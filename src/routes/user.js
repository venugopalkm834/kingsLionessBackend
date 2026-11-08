const r = require('express').Router();
const { z } = require('zod');
const { Service, Booking, Deposit, Withdrawal, Transfer, BankAccount, Wallet, WalletTransaction, DailyReturn, MonthlyReturn, Referral, ReferralCommission, Notification, User } = require('../models');
const { ids, HttpError, asyncH, withTx, enc, page, inr, fmtDate } = require('../utils/helpers');
const { auth, validate, idem, upload, uploadAudio } = require('../middleware');
const { getSettings, credit, debit, notify, notifyAdmin, dailyPercent, lockInfo, calcFees, todayStr } = require('../utils/ledger');

// ---------------- public ----------------
r.get('/services', asyncH(async (req, res) => res.json(await Service.find({ active: true }).sort({ order: 1 }))));
r.get('/program-info', asyncH(async (req, res) => {
  const s = await getSettings();
  res.json({
    returns: { enabled: s.returns.enabled, inputMode: s.returns.inputMode, monthlyPercent: s.returns.monthlyPercent, dailyPercent: dailyPercent(s.returns), daysBasis: s.returns.daysBasis, base: s.returns.base, minBalance: s.returns.minBalance, conditions: s.returns.conditions },
    principalReturn: { enabled: s.principalReturn.enabled, percent: s.principalReturn.percent, minPrincipal: s.principalReturn.minPrincipal, conditions: s.principalReturn.conditions },
    referral: { enabled: s.referral.enabled, bookingEnabled: s.referral.bookingEnabled, percent: s.referral.percent, eligibleActivity: s.referral.eligibleActivity, deposit: s.referral.deposit, holding: s.referral.holding, earning: s.referral.earning },
    wallet: { minDeposit: s.wallet.minDeposit, minWithdrawal: s.wallet.minWithdrawal, methods: s.wallet.methods, depositInstructions: s.wallet.depositInstructions, tds: s.wallet.tds, service: s.wallet.service, principalLock: s.wallet.principalLock },
    contact: s.contact,
  });
}));
r.get('/referral/check/:code', asyncH(async (req, res) => { const u = await User.findOne({ referralCode: req.params.code.toUpperCase() }); res.json({ valid: !!u }); }));

r.use(auth);

// ---------------- bookings (multipart: optional voice note in field "audio") ----------------
const bookingSchema = z.object({
  serviceId: z.string().optional(), category: z.string().max(80).optional(), serviceName: z.string().min(2).max(120), description: z.string().max(1000).optional(),
  quantity: z.coerce.number().int().min(1).max(1000).default(1), mobile: z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile'),
  address: z.string().min(5).max(400), preferredDate: z.coerce.date().refine((d) => d >= new Date(Date.now() - 864e5), 'Date cannot be in the past'),
  additional: z.string().max(1000).optional(),
});
r.post('/bookings', uploadAudio.single('audio'), validate(bookingSchema), asyncH(async (req, res) => {
  const b = req.body; let svc = null;
  if (b.serviceId) { svc = await Service.findOne({ _id: b.serviceId, active: true }); if (!svc) throw new HttpError(400, 'Service unavailable'); }
  const u = req.user;
  const bk = await Booking.create({ bookingId: ids.booking(), user: u._id, service: svc?._id, category: svc?.name || b.category || 'Others', serviceName: b.serviceName,
    customerName: u.name, username: u.username, userCode: u.userId, mobile: b.mobile, description: b.description, quantity: b.quantity, address: b.address,
    preferredDate: b.preferredDate, additional: b.additional, audio: req.file ? '/uploads/' + req.file.filename : undefined, timeline: [{ status: 'pending', note: 'Booking received' }] });
  await notifyAdmin('New booking ' + bk.bookingId, `${u.name} booked ${b.serviceName}${req.file ? ' (voice note attached)' : ''}`, '/admin/bookings');
  res.status(201).json(bk);
}));
r.get('/bookings', asyncH(async (req, res) => {
  const { p, l, skip } = page(req.query); const q = { user: req.user._id }; if (req.query.status) q.status = req.query.status;
  const [items, total] = await Promise.all([Booking.find(q).sort({ createdAt: -1 }).skip(skip).limit(l), Booking.countDocuments(q)]);
  res.json({ items, total, page: p, limit: l });
}));
r.post('/bookings/:id/cancel', asyncH(async (req, res) => {
  const b = await Booking.findOne({ _id: req.params.id, user: req.user._id });
  if (!b) throw new HttpError(404, 'Booking not found'); if (b.status !== 'pending') throw new HttpError(400, 'Only pending bookings can be cancelled');
  b.status = 'cancelled'; b.timeline.push({ status: 'cancelled', note: 'Cancelled by customer' }); await b.save(); res.json(b);
}));

// ---------------- wallet ----------------
r.get('/wallet', asyncH(async (req, res) => {
  const [w, s, recent, today] = await Promise.all([Wallet.findOne({ user: req.user._id }), getSettings(),
    WalletTransaction.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(8), DailyReturn.findOne({ user: req.user._id, date: todayStr() })]);
  if (!w) throw new HttpError(404, 'Wallet not found');
  const lock = lockInfo(s.wallet.principalLock, w);
  const withdrawable = lock.locked ? w.earned : w.balance;
  const nd = new Date(); const monthEnd = new Date(nd.getFullYear(), nd.getMonth() + 1, 0).toISOString().slice(0, 10);
  const base = s.returns.base === 'balance' ? w.balance : w.principal; const dp = dailyPercent(s.returns);
  const eligible = s.returns.enabled && base >= Math.max(1, s.returns.minBalance);
  const pr = s.principalReturn; const expectedMonth = pr.enabled && w.principal >= Math.max(1, pr.minPrincipal) ? Math.floor((w.principal * Number(pr.percent)) / 100) : 0;
  res.json({ wallet: w, lock: { ...lock, withdrawable }, expectedMonthEnd: expectedMonth,
    settings: { returnsEnabled: s.returns.enabled, inputMode: s.returns.inputMode, principalReturn: s.principalReturn, nextMonthEnd: monthEnd, monthlyPercent: s.returns.monthlyPercent, dailyPercent: dp, minWithdrawal: s.wallet.minWithdrawal, tds: s.wallet.tds, service: s.wallet.service, principalLock: s.wallet.principalLock },
    todayReturn: today ? today.amount : eligible ? Math.floor((base * dp) / 100) : 0, todayCredited: !!today, recent });
}));
r.get('/wallet/transactions', asyncH(async (req, res) => {
  const { p, l, skip } = page(req.query); const q = { user: req.user._id }; if (req.query.type) q.type = req.query.type;
  const [items, total] = await Promise.all([WalletTransaction.find(q).sort({ createdAt: -1 }).skip(skip).limit(l), WalletTransaction.countDocuments(q)]);
  res.json({ items, total, page: p, limit: l });
}));
r.get('/wallet/returns', asyncH(async (req, res) => { const { p, l, skip } = page(req.query);
  const [items, total] = await Promise.all([DailyReturn.find({ user: req.user._id }).sort({ date: -1 }).skip(skip).limit(l), DailyReturn.countDocuments({ user: req.user._id })]);
  res.json({ items, total, page: p, limit: l }); }));

const amt = z.coerce.number().int().min(1); // paise
r.post('/wallet/deposits', upload.single('proof'), asyncH(async (req, res) => {
  const body = z.object({ amount: amt, method: z.string().min(2), txnRef: z.string().min(4).max(60) }).parse(req.body);
  const s = await getSettings();
  if (body.amount < s.wallet.minDeposit) throw new HttpError(400, `Minimum deposit is ${inr(s.wallet.minDeposit)}`);
  const key = idem(req);
  if (key) { const ex = await Deposit.findOne({ user: req.user._id, idemKey: key }); if (ex) return res.json(ex); }
  const d = await Deposit.create({ ...body, user: req.user._id, proof: req.file ? '/uploads/' + req.file.filename : undefined, idemKey: key });
  await notifyAdmin('Deposit request', `${req.user.name} requested ${inr(body.amount)}`, '/admin/deposits');
  res.status(201).json(d);
}));
const paged = (Model, filter, sort, pop) => asyncH(async (req, res) => { const { p, l, skip } = page(req.query); const f = typeof filter === 'function' ? filter(req) : filter;
  let q = Model.find(f).sort(sort).skip(skip).limit(l); if (pop) q = q.populate(...pop);
  const [items, total] = await Promise.all([q, Model.countDocuments(f)]); res.json({ items, total, page: p, limit: l }); });
r.get('/wallet/deposits', paged(Deposit, (req) => ({ user: req.user._id }), { createdAt: -1 }));

r.post('/wallet/withdrawals', validate(z.object({ amount: amt, bankId: z.string(), notes: z.string().max(300).optional() })), asyncH(async (req, res) => {
  const { amount, bankId, notes } = req.body; const key = idem(req);
  if (key) { const ex = await Withdrawal.findOne({ user: req.user._id, idemKey: key }); if (ex) return res.json(ex); }
  const s = await getSettings();
  if (amount < s.wallet.minWithdrawal) throw new HttpError(400, `Minimum withdrawal is ${inr(s.wallet.minWithdrawal)}`);
  const bank = await BankAccount.findOne({ _id: bankId, user: req.user._id, status: 'verified' });
  if (!bank) throw new HttpError(400, 'Choose a verified bank account');
  const f = calcFees(s.wallet, amount);
  if (f.net < 1) throw new HttpError(400, 'Amount is too small after charges');
  const wd = await withTx(async (ses) => {
    const w = await Wallet.findOne({ user: req.user._id }).session(ses);
    const lock = lockInfo(s.wallet.principalLock, w);
    const withdrawable = lock.locked ? w.earned : w.balance;
    if (amount > withdrawable) throw new HttpError(400, lock.locked
      ? `Your principal is locked${lock.unlockAt ? ' until ' + fmtDate(lock.unlockAt) : ''}. Only earned income can be withdrawn now: ${inr(w.earned)} available.`
      : 'Insufficient balance');
    const e = Math.min(w.earned, amount); const p = amount - e; // earned income is used first
    const [doc] = await Withdrawal.create([{ user: req.user._id, bank: bank._id, amount, fee: f.fee, net: f.net, notes, idemKey: key,
      tds: f.tds, tdsLabel: s.wallet.tds.label, tdsPercent: s.wallet.tds.enabled ? s.wallet.tds.percent : 0,
      serviceCharge: f.service, serviceLabel: s.wallet.service.label, servicePercent: s.wallet.service.enabled ? s.wallet.service.percent : 0, fromEarned: e, fromPrincipal: p }], { session: ses });
    await debit(ses, { userId: req.user._id, amount, split: { principal: p, earned: e }, type: 'withdrawal', note: 'Withdrawal requested (funds held)', relatedId: String(doc._id) });
    return doc;
  });
  await notifyAdmin('Withdrawal request', `${req.user.name} requested ${inr(amount)} (net ${inr(f.net)})`, '/admin/withdrawals');
  res.status(201).json(wd);
}));
r.get('/wallet/withdrawals', paged(Withdrawal, (req) => ({ user: req.user._id }), { createdAt: -1 }, ['bank', 'bankName last4']));

async function findRecipient(req, by, value) {
  const v = String(value || '').trim();
  if (!v) throw new HttpError(400, by === 'mobile' ? 'Enter the mobile number' : 'Enter the user ID');
  const q = by === 'mobile' ? { mobile: v.replace(/\D/g, '').slice(-10) } : by === 'walletId' ? { walletId: v.toUpperCase() } : { userId: v.toUpperCase() };
  const found = await User.find({ ...q, status: 'active', role: 'user' }).limit(2);
  if (found.length > 1) throw new HttpError(409, 'More than one account uses this mobile number. Please use the User ID.');
  const u = found[0];
  if (!u || String(u._id) === String(req.user._id)) throw new HttpError(404, 'No user found');
  return u;
}
r.get('/wallet/lookup', asyncH(async (req, res) => {
  const u = await findRecipient(req, req.query.by === 'mobile' ? 'mobile' : 'userId', req.query.value);
  res.json({ name: u.name, userId: u.userId, mobile: u.mobile ? `******${String(u.mobile).slice(-4)}` : '' });
}));
r.post('/wallet/transfers', validate(z.object({ by: z.enum(['userId', 'mobile', 'walletId']).default('userId'), value: z.string().optional(), walletId: z.string().optional(), source: z.enum(['principal', 'earned']).default('principal'), amount: amt, note: z.string().max(200).optional() })), asyncH(async (req, res) => {
  const { amount, note, source } = req.body; const by = req.body.by; const value = req.body.value || req.body.walletId; const key = idem(req);
  if (key) { const ex = await Transfer.findOne({ from: req.user._id, idemKey: key }); if (ex) return res.json(ex); }
  const to = await findRecipient(req, by, value);
  const st = await getSettings();
  const t = await withTx(async (s) => {
    const reference = ids.txn('TRF');
    // Principal sent while locked stays locked for the receiver until the sender's unlock date. Earned income stays earned.
    let lockUntil = null;
    if (source === 'principal') { const w = await Wallet.findOne({ user: req.user._id }).session(s); const li = lockInfo(st.wallet.principalLock, w); if (li.locked && li.unlockAt) lockUntil = li.unlockAt; }
    const [tr] = await Transfer.create([{ reference, from: req.user._id, to: to._id, fromWalletId: req.user.walletId, toWalletId: to.walletId, amount, source, lockUntil, note, idemKey: key }], { session: s });
    const label = source === 'earned' ? 'earned income' : 'principal';
    await debit(s, { userId: req.user._id, amount, policy: source, type: 'transfer_out', note: `To ${to.userId} (${label})`, relatedId: reference, totals: { totalTransfers: amount } });
    await credit(s, { userId: to._id, amount, bucket: source, lockUntil, type: 'transfer_in', note: `From ${req.user.userId} (${label})`, relatedId: reference });
    await notify(s, to._id, 'Funds received', `${inr(amount)} ${label} from ${req.user.name}${lockUntil ? ' · locked until ' + fmtDate(lockUntil) : ''}`, '/wallet');
    return tr;
  });
  res.status(201).json({ ...t.toObject(), recipientName: to.name, toUserId: to.userId, fromWalletId: undefined, toWalletId: undefined });
}));
r.get('/wallet/transfers', asyncH(async (req, res) => { const { p, l, skip } = page(req.query); const f = { $or: [{ from: req.user._id }, { to: req.user._id }] };
  const [rows, total] = await Promise.all([Transfer.find(f).populate('from to', 'name userId').sort({ createdAt: -1 }).skip(skip).limit(l), Transfer.countDocuments(f)]);
  res.json({ items: rows.map((t) => ({ ...t.toObject(), fromWalletId: undefined, toWalletId: undefined, direction: String(t.from._id) === String(req.user._id) ? 'sent' : 'received' })), total, page: p, limit: l }); }));
r.get('/wallet/monthly-returns', paged(MonthlyReturn, (req) => ({ user: req.user._id }), { month: -1 }));

// ---------------- bank accounts ----------------
const bankSchema = z.object({ holderName: z.string().min(2).max(80), bankName: z.string().min(2).max(80), accountNumber: z.string().regex(/^\d{9,18}$/, 'Account number must be 9 to 18 digits'),
  ifsc: z.string().regex(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/, 'Invalid IFSC (example: HDFC0001234)'), type: z.enum(['savings', 'current']).default('savings'), isDefault: z.boolean().optional() });
const maskBank = (b) => ({ _id: b._id, holderName: b.holderName, bankName: b.bankName, masked: '•••• ' + b.last4, ifsc: b.ifsc, type: b.type, isDefault: !!b.isDefault, status: b.status, remarks: b.remarks });
r.get('/banks', asyncH(async (req, res) => res.json((await BankAccount.find({ user: req.user._id }).sort({ createdAt: -1 })).map(maskBank))));
r.post('/banks', validate(bankSchema), asyncH(async (req, res) => {
  const b = req.body; const count = await BankAccount.countDocuments({ user: req.user._id });
  if (count >= 5) throw new HttpError(400, 'Maximum 5 bank accounts');
  const isDefault = !!b.isDefault || count === 0; if (isDefault) await BankAccount.updateMany({ user: req.user._id }, { isDefault: false });
  const acc = await BankAccount.create({ user: req.user._id, holderName: b.holderName.trim(), bankName: b.bankName.trim(), accountEnc: enc(b.accountNumber), last4: b.accountNumber.slice(-4),
    ifsc: b.ifsc.toUpperCase(), type: b.type, isDefault });
  await notifyAdmin('Bank account to verify', `${req.user.name} — ${b.bankName}`, '/admin/banks');
  res.status(201).json(maskBank(acc));
}));
r.patch('/banks/:id/default', asyncH(async (req, res) => {
  const b = await BankAccount.findOne({ _id: req.params.id, user: req.user._id }); if (!b) throw new HttpError(404, 'Bank account not found');
  await BankAccount.updateMany({ user: req.user._id }, { isDefault: false }); b.isDefault = true; await b.save(); res.json({ ok: true });
}));
r.delete('/banks/:id', asyncH(async (req, res) => {
  const open = await Withdrawal.countDocuments({ bank: req.params.id, user: req.user._id, status: { $in: ['pending', 'approved', 'processing'] } });
  if (open) throw new HttpError(400, 'This account has a withdrawal in progress');
  await BankAccount.deleteOne({ _id: req.params.id, user: req.user._id }); res.json({ ok: true });
}));

// ---------------- referrals ----------------
r.get('/referrals', asyncH(async (req, res) => {
  const [refs, comms, s] = await Promise.all([Referral.find({ referrer: req.user._id }).populate('referred', 'name userId createdAt').sort({ createdAt: -1 }),
    ReferralCommission.find({ referrer: req.user._id }), getSettings()]);
  const sum = (st) => comms.filter((c) => st.includes(c.status)).reduce((a, c) => a + c.amount, 0);
  const by = (k) => comms.filter((c) => (c.kind || 'booking') === k && c.status === 'approved').reduce((a, c) => a + c.amount, 0);
  res.json({ code: req.user.referralCode, program: s.referral, breakdown: { booking: by('booking'), deposit: by('deposit'), holding: by('holding'), earning: by('earning') }, total: refs.length, earned: sum(['approved']), eligible: sum(['pending']),
    list: refs.filter((x) => x.referred).map((x) => { const c = comms.filter((c2) => String(c2.referred) === String(x.referred._id));
      return { name: x.referred.name, userId: x.referred.userId, joined: x.referred.createdAt, status: c.length ? 'active' : 'registered',
        commission: c.reduce((a, b) => a + b.amount, 0), commissionStatus: c[0]?.status || '—' }; }) });
}));

// ---------------- notifications / profile ----------------
r.get('/notifications', asyncH(async (req, res) => res.json(await Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(50))));
r.get('/notifications/unread', asyncH(async (req, res) => res.json({ count: await Notification.countDocuments({ user: req.user._id, read: false }) })));
r.post('/notifications/read-all', asyncH(async (req, res) => { await Notification.updateMany({ user: req.user._id, read: false }, { read: true }); res.json({ ok: true }); }));
r.post('/profile/avatar', upload.single('avatar'), asyncH(async (req, res) => {
  if (!req.file || !req.file.mimetype.startsWith('image/')) throw new HttpError(400, 'Please choose an image file');
  req.user.avatar = '/uploads/' + req.file.filename; await req.user.save(); res.json({ avatar: req.user.avatar });
}));
module.exports = r;
