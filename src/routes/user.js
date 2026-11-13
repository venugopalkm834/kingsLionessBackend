const r = require('express').Router();
const { z } = require('zod');
const { Service, Booking, Banner, Deposit, PaymentAccount, Withdrawal, Transfer, BankAccount, Wallet, WalletTransaction, DailyReturn, MonthlyReturn, Referral, ReferralCommission, Notification, User } = require('../models');
const { ids, HttpError, asyncH, withTx, enc, page, inr, fmtDate } = require('../utils/helpers');
const { auth, validate, idem, upload, uploadAudio } = require('../middleware');
const { getSettings, credit, debit, notify, notifyAdmin, dailyPercent, baseField, daysIn, lockInfo, calcFees, todayStr } = require('../utils/ledger');

// ---------------- public ----------------
r.get('/services', asyncH(async (req, res) => res.json(await Service.find({ active: true }).sort({ order: 1 }))));
r.get('/program-info', asyncH(async (req, res) => {
  const s = await getSettings();
  res.json({
    returns: { enabled: s.returns.enabled, inputMode: s.returns.inputMode, monthlyPercent: s.returns.monthlyPercent, dailyPercent: dailyPercent(s.returns), daysBasis: s.returns.daysBasis, base: s.returns.base, minBalance: s.returns.minBalance, conditions: s.returns.conditions },
    principalReturn: { enabled: s.principalReturn.enabled, percent: s.principalReturn.percent, minPrincipal: s.principalReturn.minPrincipal, conditions: s.principalReturn.conditions },
    referral: { enabled: s.referral.enabled, bookingEnabled: s.referral.bookingEnabled, percent: s.referral.percent, eligibleActivity: s.referral.eligibleActivity, deposit: s.referral.deposit, earning: s.referral.earning },
    wallet: { minDeposit: s.wallet.minDeposit, minWithdrawal: s.wallet.minWithdrawal, methods: s.wallet.methods, depositInstructions: s.wallet.depositInstructions, tds: s.wallet.tds, service: s.wallet.service, principalLock: s.wallet.principalLock },
    contact: s.contact,
  });
}));
r.get('/banners', asyncH(async (req, res) => res.json(await Banner.find({ active: true }).sort({ order: 1, createdAt: -1 }).select('image title subtitle link'))));
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
  const baseKey = baseField(s.returns); const base = w[baseKey]; const dp = dailyPercent(s.returns);
  const qualifies = base >= Math.max(1, s.returns.minBalance); const eligible = s.returns.enabled && qualifies;
  // What the admin's rate pays on the chosen base, shown to the user even before the program is switched on.
  const perDay = qualifies ? Math.floor((base * dp) / 100) : 0;
  const perMonth = qualifies ? (s.returns.inputMode === 'monthly' ? Math.floor((base * Number(s.returns.monthlyPercent || 0)) / 100) : perDay * daysIn(new Date())) : 0;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const [refAll, refToday] = await Promise.all([WalletTransaction.aggregate([{ $match: { user: req.user._id, type: 'referral' } }, { $group: { _id: null, v: { $sum: '$amount' } } }]),
    WalletTransaction.aggregate([{ $match: { user: req.user._id, type: 'referral', createdAt: { $gte: start } } }, { $group: { _id: null, v: { $sum: '$amount' } } }])]);
  const pr = s.principalReturn; const expectedMonth = pr.enabled && w.principal >= Math.max(1, pr.minPrincipal) ? Math.floor((w.principal * Number(pr.percent)) / 100) : 0;
  res.json({ wallet: w, lock: { ...lock, withdrawable }, expectedMonthEnd: expectedMonth,
    settings: { returnsEnabled: s.returns.enabled, inputMode: s.returns.inputMode, daysBasis: s.returns.daysBasis, base: s.returns.base, principalReturn: s.principalReturn, nextMonthEnd: monthEnd, monthlyPercent: s.returns.monthlyPercent, dailyPercent: dp, minWithdrawal: s.wallet.minWithdrawal, tds: s.wallet.tds, service: s.wallet.service, principalLock: s.wallet.principalLock },
    earning: { baseKey, baseAmount: base, perDay, perMonth, qualifies, minBalance: s.returns.minBalance, totalEarned: w.totalReturns || 0 },
    referralIncome: { today: refToday[0]?.v || 0, total: refAll[0]?.v || 0, display: s.referral.earning?.display === 'overall' ? 'overall' : 'daily' },
    todayReturn: today ? today.amount : eligible ? perDay : 0, todayCredited: !!today, recent });
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
// Where to pay: the active bank / UPI accounts the admin has added. Shown on the deposit form.
const publicPay = (a) => ({ _id: a._id, type: a.type, label: a.label, holderName: a.holderName, bankName: a.bankName, accountNumber: a.accountNumber, ifsc: a.ifsc, branch: a.branch,
  accountType: a.accountType, upiId: a.upiId, qrImage: a.qrImage, note: a.note });
r.get('/payment-accounts', asyncH(async (req, res) => res.json((await PaymentAccount.find({ active: true }).sort({ order: 1, createdAt: 1 })).map(publicPay))));
const payName = (a) => (a.type === 'upi' ? `UPI · ${a.upiId}` : `${a.bankName} · •••• ${String(a.accountNumber).slice(-4)}`);
r.post('/wallet/deposits', upload.single('proof'), asyncH(async (req, res) => {
  const body = z.object({ amount: amt, method: z.string().min(2).max(40), txnRef: z.string().min(4).max(60), paymentAccountId: z.string().min(8), target: z.enum(['principal', 'earned']).default('principal') }).parse(req.body);
  const s = await getSettings();
  if (body.amount < s.wallet.minDeposit) throw new HttpError(400, `Minimum deposit is ${inr(s.wallet.minDeposit)}`);
  const key = idem(req);
  if (key) { const ex = await Deposit.findOne({ user: req.user._id, idemKey: key }); if (ex) return res.json(ex); }
  const acc = await PaymentAccount.findOne({ _id: body.paymentAccountId, active: true });
  if (!acc) throw new HttpError(400, 'That payment account is not available. Please pick one from the list.');
  const { paymentAccountId, ...rest } = body;
  const d = await Deposit.create({ ...rest, method: acc.type === 'upi' ? 'UPI' : rest.method, paymentAccount: acc._id, paidTo: payName(acc), user: req.user._id, proof: req.file ? '/uploads/' + req.file.filename : undefined, idemKey: key });
  await notifyAdmin('Deposit request', `${req.user.name} requested ${inr(body.amount)} (to ${body.target} wallet) · paid to ${payName(acc)}`, '/admin/deposits');
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
// Transfers: only EARNED income can be sent, and every transfer waits for admin approval.
// The amount is held (debited) from the sender when requested; the recipient is credited when an admin approves;
// a rejection refunds the sender in full.
r.post('/wallet/transfers', validate(z.object({ by: z.enum(['userId', 'mobile', 'walletId']).default('userId'), value: z.string().optional(), walletId: z.string().optional(), source: z.enum(['principal', 'earned']).default('earned'), amount: amt, note: z.string().max(200).optional() })), asyncH(async (req, res) => {
  const { amount, note, source } = req.body; const by = req.body.by; const value = req.body.value || req.body.walletId; const key = idem(req);
  if (source !== 'earned') throw new HttpError(400, 'Principal cannot be transferred. Only earned income can be transferred.');
  if (key) { const ex = await Transfer.findOne({ from: req.user._id, idemKey: key }); if (ex) return res.json(ex); }
  const to = await findRecipient(req, by, value);
  const t = await withTx(async (s) => {
    const reference = ids.txn('TRF');
    const [tr] = await Transfer.create([{ reference, from: req.user._id, to: to._id, fromWalletId: req.user.walletId, toWalletId: to.walletId, amount, source: 'earned', note, status: 'pending', idemKey: key }], { session: s });
    await debit(s, { userId: req.user._id, amount, policy: 'earned', type: 'transfer_out', note: `To ${to.userId} (awaiting admin approval)`, relatedId: reference });
    return tr;
  });
  await notifyAdmin('Transfer request', `${req.user.name} → ${to.name} (${to.userId}) ${inr(amount)}`, '/admin/transfers');
  res.status(201).json({ ...t.toObject(), recipientName: to.name, toUserId: to.userId, fromWalletId: undefined, toWalletId: undefined });
}));
r.get('/wallet/transfers', asyncH(async (req, res) => { const { p, l, skip } = page(req.query); const f = { $or: [{ from: req.user._id }, { to: req.user._id, status: 'completed' }] }; // a pending transfer is not shown to the recipient yet
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
  const [refs, comms, s, parent] = await Promise.all([Referral.find({ referrer: req.user._id }).populate('referred', 'name userId createdAt').sort({ createdAt: -1 }),
    ReferralCommission.find({ referrer: req.user._id }), getSettings(), req.user.referredBy ? User.findById(req.user.referredBy).select('name userId') : null]);
  const sum = (st) => comms.filter((c) => st.includes(c.status)).reduce((a, c) => a + c.amount, 0);
  const by = (k) => comms.filter((c) => (c.kind || 'booking') === k && c.status === 'approved').reduce((a, c) => a + c.amount, 0);
  const kids = refs.filter((x) => x.referred);
  // second level: the people each of my direct referrals brought in
  const grand = await Referral.find({ referrer: { $in: kids.map((k) => k.referred._id) } }).populate('referred', 'name userId');
  res.json({ code: req.user.referralCode, program: s.referral, parent: parent ? { name: parent.name, userId: parent.userId } : null,
    breakdown: { booking: by('booking'), deposit: by('deposit'), earning: by('earning') }, total: refs.length, earned: sum(['approved']), eligible: sum(['pending']),
    list: kids.map((x) => { const c = comms.filter((c2) => String(c2.referred) === String(x.referred._id));
      const children = grand.filter((g) => String(g.referrer) === String(x.referred._id) && g.referred).map((g) => ({ name: g.referred.name, userId: g.referred.userId }));
      return { name: x.referred.name, userId: x.referred.userId, joined: x.referred.createdAt, status: c.length ? 'active' : 'registered', children,
        commission: c.filter((k) => k.status === 'approved').reduce((a, b) => a + b.amount, 0), pendingCommission: c.filter((k) => k.status === 'pending').reduce((a, b) => a + b.amount, 0), commissionStatus: c[0]?.status || '—' }; }) });
}));

// ---------------- nominee ----------------
const nomineeSchema = z.object({ name: z.string().trim().min(2).max(80), relation: z.string().trim().min(2).max(40), mobile: z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile').optional().or(z.literal('')),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date').optional().or(z.literal('')), address: z.string().trim().max(300).optional() });
r.put('/nominee', validate(nomineeSchema), asyncH(async (req, res) => { req.user.nominee = req.body; await req.user.save(); res.json(req.user.nominee); }));
r.delete('/nominee', asyncH(async (req, res) => { req.user.nominee = undefined; await req.user.save(); res.json({ ok: true }); }));

// ---------------- notifications / profile ----------------
r.get('/notifications', asyncH(async (req, res) => res.json(await Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(50))));
r.get('/notifications/unread', asyncH(async (req, res) => res.json({ count: await Notification.countDocuments({ user: req.user._id, read: false }) })));
r.post('/notifications/read-all', asyncH(async (req, res) => { await Notification.updateMany({ user: req.user._id, read: false }, { read: true }); res.json({ ok: true }); }));
r.post('/profile/avatar', upload.single('avatar'), asyncH(async (req, res) => {
  if (!req.file || !req.file.mimetype.startsWith('image/')) throw new HttpError(400, 'Please choose an image file');
  req.user.avatar = '/uploads/' + req.file.filename; await req.user.save(); res.json({ avatar: req.user.avatar });
}));
module.exports = r;
