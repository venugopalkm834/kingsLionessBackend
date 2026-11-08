const r = require('express').Router();
const { z } = require('zod');
const M = require('../models');
const { HttpError, asyncH, withTx, page, dec, inr } = require('../utils/helpers');
const { auth, role, validate, upload } = require('../middleware');
const { getSettings, credit, debit, notify, audit, dailyPercent } = require('../utils/ledger');
const { runDailyReturns, runMonthEnd } = require('../utils/returns');
const { approveCommission, addCommission, depositCommission } = require('../utils/referral');
r.use(auth, role('admin'));

const rx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const range = (q, f = 'createdAt') => (q.from || q.to ? { [f]: { ...(q.from && { $gte: new Date(q.from) }), ...(q.to && { $lte: new Date(q.to + 'T23:59:59') }) } } : {});
async function list(Model, req, { filter = {}, search = [], populate = null, sort = { createdAt: -1 }, keys = ['status'] } = {}) {
  const { p, l, skip } = page(req.query); const q = { ...filter, ...range(req.query) };
  keys.forEach((k) => { if (req.query[k]) q[k] = req.query[k]; });
  if (req.query.search && search.length) q.$or = search.map((f) => ({ [f]: rx(req.query.search) }));
  let qy = Model.find(q); if (populate) qy = qy.populate(populate);
  const [items, total] = await Promise.all([qy.sort(sort).skip(skip).limit(l), Model.countDocuments(q)]);
  return { items, total, page: p, limit: l };
}
const uref = 'name userId username';

// ---------------- dashboard ----------------
r.get('/dashboard', asyncH(async (req, res) => {
  const since = new Date(); since.setMonth(since.getMonth() - 5); since.setDate(1); since.setHours(0, 0, 0, 0);
  const byMonth = (Model, extra = {}, sumField) => Model.aggregate([{ $match: { createdAt: { $gte: since }, ...extra } },
    { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } }, v: sumField ? { $sum: '$' + sumField } : { $sum: 1 } } }, { $sort: { _id: 1 } }]);
  const sumW = (f) => M.Wallet.aggregate([{ $group: { _id: null, v: { $sum: '$' + f } } }]).then((x) => x[0]?.v || 0);
  const [users, active, bookings, pending, completed, pendingW, pendingD, bal, principal, earned, deps, rets, comm, bm, dm, wm, um, recentB, recentT] = await Promise.all([
    M.User.countDocuments({ role: 'user' }), M.User.countDocuments({ role: 'user', status: 'active' }), M.Booking.countDocuments(), M.Booking.countDocuments({ status: 'pending' }),
    M.Booking.countDocuments({ status: 'completed' }), M.Withdrawal.countDocuments({ status: { $in: ['pending', 'approved', 'processing'] } }), M.Deposit.countDocuments({ status: 'pending' }),
    sumW('balance'), sumW('principal'), sumW('earned'), sumW('totalDeposits'), sumW('totalReturns'),
    M.ReferralCommission.aggregate([{ $match: { status: 'approved' } }, { $group: { _id: null, v: { $sum: '$amount' } } }]).then((x) => x[0]?.v || 0),
    byMonth(M.Booking), byMonth(M.Deposit, { status: 'approved' }, 'amount'), byMonth(M.Withdrawal, { status: { $ne: 'rejected' } }, 'amount'), byMonth(M.User, { role: 'user' }),
    M.Booking.find().sort({ createdAt: -1 }).limit(6), M.WalletTransaction.find().populate('user', 'name userId').sort({ createdAt: -1 }).limit(6)]);
  res.json({ stats: { users, active, bookings, pending, completed, pendingW, pendingD, balances: bal, principal, earned, deposits: deps, returns: rets, commissions: comm },
    charts: { bookings: bm, deposits: dm, withdrawals: wm, users: um }, recentBookings: recentB, recentTransactions: recentT });
}));

// ---------------- bookings ----------------
const bookingFilter = (req) => ({ ...(req.query.category && { category: req.query.category }) });
r.get('/bookings', asyncH(async (req, res) => res.json(await list(M.Booking, req, { filter: bookingFilter(req), search: ['bookingId', 'customerName', 'username', 'userCode', 'mobile', 'serviceName'] }))));
r.get('/bookings/export', asyncH(async (req, res) => {
  const q = { ...bookingFilter(req), ...range(req.query), ...(req.query.status && { status: req.query.status }) };
  const rows = await M.Booking.find(q).sort({ createdAt: -1 }).limit(5000);
  const e = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Booking ID', 'Customer', 'Username', 'User ID', 'Mobile', 'Category', 'Service', 'Date', 'Address', 'Voice note', 'Status', 'Remarks'];
  const csv = [head.join(','), ...rows.map((b) => [b.bookingId, b.customerName, b.username, b.userCode, b.mobile, b.category, b.serviceName, b.preferredDate?.toISOString().slice(0, 10), b.address, b.audio ? 'yes' : 'no', b.status, b.remarks].map(e).join(','))].join('\n');
  res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=bookings.csv' }).send(csv);
}));
r.patch('/bookings/:id', validate(z.object({ status: z.enum(['pending', 'confirmed', 'in_progress', 'completed', 'cancelled']).optional(), remarks: z.string().max(500).optional(), amount: z.coerce.number().int().min(0).optional() })),
  asyncH(async (req, res) => {
    const b = await M.Booking.findById(req.params.id); if (!b) throw new HttpError(404, 'Booking not found');
    const { status, remarks, amount } = req.body;
    if (remarks !== undefined) b.remarks = remarks; if (amount !== undefined) b.amount = amount;
    const changed = status && status !== b.status;
    if (changed) { b.status = status; b.timeline.push({ status, note: remarks || '' }); }
    await b.save();
    if (changed) {
      await M.Notification.create({ user: b.user, title: `Booking ${b.bookingId}: ${status.replace('_', ' ')}`, body: remarks || '', link: '/bookings' });
      if (status === 'completed') await maybeCommission(b, req.user._id);
    }
    await audit(req.user._id, 'booking.update', b.bookingId, remarks, { status, amount }, req.ip);
    res.json(b);
  }));
async function maybeCommission(b, actorId) {
  const s = await getSettings(); if (!s.referral.enabled || s.referral.bookingEnabled === false) return;
  const u = await M.User.findById(b.user); if (!u?.referredBy || String(u.referredBy) === String(u._id)) return; // no self-referral
  const done = await M.Booking.countDocuments({ user: u._id, status: 'completed', _id: { $ne: b._id } });
  if (s.referral.eligibleActivity === 'first_completed_booking' && done > 0) return;
  const key = s.referral.eligibleActivity === 'first_completed_booking' ? `first:${u._id}` : `booking:${b._id}`;
  await addCommission({ referrer: u.referredBy, referred: u._id, kind: 'booking', key, basis: b.amount, percent: s.referral.percent, autoApprove: s.referral.autoApprove, actorId });
}

// ---------------- users ----------------
r.get('/users', asyncH(async (req, res) => {
  const out = await list(M.User, req, { filter: { role: 'user' }, search: ['name', 'email', 'mobile', 'userId', 'walletId', 'username'] });
  const wallets = await M.Wallet.find({ user: { $in: out.items.map((u) => u._id) } });
  out.items = out.items.map((u) => { const w = wallets.find((x) => String(x.user) === String(u._id)); return { ...u.toObject(), balance: w?.balance || 0, principal: w?.principal || 0, earned: w?.earned || 0 }; });
  res.json(out);
}));
r.get('/users/:id', asyncH(async (req, res) => {
  const u = await M.User.findById(req.params.id); if (!u) throw new HttpError(404, 'User not found');
  const [wallet, bookings, txs] = await Promise.all([M.Wallet.findOne({ user: u._id }), M.Booking.find({ user: u._id }).sort({ createdAt: -1 }).limit(20), M.WalletTransaction.find({ user: u._id }).sort({ createdAt: -1 }).limit(20)]);
  res.json({ user: u, wallet, bookings, transactions: txs });
}));
const userEdit = z.object({
  name: z.string().min(2).max(80).optional(), username: z.string().min(3).max(24).regex(/^[a-z0-9_]+$/i).optional(), email: z.string().email().optional(),
  mobile: z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile').optional(), address: z.string().max(300).optional(), city: z.string().max(80).optional(), state: z.string().max(80).optional(),
  pin: z.string().regex(/^\d{6}$/).optional().or(z.literal('')), status: z.enum(['active', 'suspended']).optional(), newPassword: z.string().min(8).regex(/^(?=.*[A-Za-z])(?=.*\d)/, 'Password needs a letter and a number').optional() });
r.patch('/users/:id', validate(userEdit), asyncH(async (req, res) => {
  const u = await M.User.findOne({ _id: req.params.id, role: 'user' }); if (!u) throw new HttpError(404, 'User not found');
  const { newPassword, ...b } = req.body; const changed = {};
  if (b.username) b.username = b.username.toLowerCase(); if (b.email) b.email = b.email.toLowerCase();
  for (const k of ['username', 'email', 'mobile']) if (b[k] && b[k] !== u[k] && (await M.User.exists({ [k]: b[k], _id: { $ne: u._id } }))) throw new HttpError(409, `This ${k} is already used by another account`);
  for (const k of Object.keys(b)) if (b[k] !== undefined && b[k] !== u[k]) { changed[k] = [u[k], b[k]]; u[k] = b[k]; }
  if (newPassword) { u.passwordHash = await require('bcryptjs').hash(newPassword, 12); changed.password = 'reset'; }
  await u.save();
  await audit(req.user._id, 'user.edit', u.userId, null, changed, req.ip);
  const out = u.toObject(); delete out.passwordHash; res.json(out);
}));
// ---------------- services ----------------
const svcSchema = z.object({ name: z.string().min(2), description: z.string().max(400).optional(), items: z.union([z.array(z.string()), z.string()]).optional(),
  active: z.coerce.boolean().optional(), allowCustom: z.coerce.boolean().optional(), order: z.coerce.number().optional() });
const parseSvc = (b) => { const d = svcSchema.parse(b); if (typeof d.items === 'string') d.items = d.items.split('\n').map((s) => s.trim()).filter(Boolean); return d; };
const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const strBool = (v) => v === true || v === 'true';
r.get('/services', asyncH(async (req, res) => res.json(await M.Service.find().sort({ order: 1 }))));
r.post('/services', upload.single('image'), asyncH(async (req, res) => {
  const d = parseSvc(req.body); const count = await M.Service.countDocuments();
  res.status(201).json(await M.Service.create({ ...d, active: strBool(req.body.active), allowCustom: strBool(req.body.allowCustom), order: count, slug: slug(d.name), image: req.file ? '/uploads/' + req.file.filename : undefined }));
}));
r.put('/services/:id', upload.single('image'), asyncH(async (req, res) => {
  const d = parseSvc(req.body); const set = { ...d, active: strBool(req.body.active), allowCustom: strBool(req.body.allowCustom), slug: slug(d.name) };
  if (req.file) set.image = '/uploads/' + req.file.filename;
  const s = await M.Service.findByIdAndUpdate(req.params.id, set, { new: true }); if (!s) throw new HttpError(404, 'Service not found'); res.json(s);
}));
r.patch('/services/:id/toggle', asyncH(async (req, res) => { const s = await M.Service.findById(req.params.id); if (!s) throw new HttpError(404, 'Service not found'); s.active = !s.active; await s.save(); res.json(s); }));
r.delete('/services/:id', asyncH(async (req, res) => { await M.Service.findByIdAndDelete(req.params.id); res.json({ ok: true }); }));

// ---------------- deposits ----------------
r.get('/deposits', asyncH(async (req, res) => res.json(await list(M.Deposit, req, { populate: { path: 'user', select: uref }, search: ['txnRef'] }))));
r.patch('/deposits/:id', validate(z.object({ status: z.enum(['approved', 'rejected']), remarks: z.string().max(300).optional() })), asyncH(async (req, res) => {
  const out = await withTx(async (s) => {
    const d = await M.Deposit.findOneAndUpdate({ _id: req.params.id, status: 'pending' }, { status: req.body.status, remarks: req.body.remarks, reviewedBy: req.user._id }, { new: true, session: s });
    if (!d) throw new HttpError(409, 'Already processed');
    if (d.status === 'approved') await credit(s, { userId: d.user, amount: d.amount, bucket: 'principal', touchDeposit: true, type: 'deposit', note: 'Deposit approved', relatedId: String(d._id), totals: { totalDeposits: d.amount } });
    await notify(s, d.user, `Deposit ${d.status}`, d.remarks || inr(d.amount), '/wallet'); return d;
  });
  if (out.status === 'approved') await depositCommission(out, req.user._id).catch((e) => console.error('deposit commission', e));
  await audit(req.user._id, 'deposit.' + out.status, String(out._id), req.body.remarks, { amount: out.amount }, req.ip); res.json(out);
}));

// ---------------- withdrawals ----------------
const NEXT = { pending: ['approved', 'processing', 'rejected'], approved: ['processing', 'completed', 'rejected'], processing: ['completed', 'rejected'] };
r.get('/withdrawals', asyncH(async (req, res) => res.json(await list(M.Withdrawal, req, { populate: [{ path: 'user', select: uref }, { path: 'bank', select: 'bankName last4 ifsc holderName' }] }))));
r.patch('/withdrawals/:id', validate(z.object({ status: z.enum(['approved', 'processing', 'completed', 'rejected']), remarks: z.string().max(300).optional() })), asyncH(async (req, res) => {
  const out = await withTx(async (s) => {
    const w = await M.Withdrawal.findById(req.params.id).session(s); if (!w) throw new HttpError(404, 'Withdrawal not found');
    if (!(NEXT[w.status] || []).includes(req.body.status)) throw new HttpError(409, `Cannot move from ${w.status} to ${req.body.status}`);
    w.status = req.body.status; w.remarks = req.body.remarks; w.reviewedBy = req.user._id; await w.save({ session: s });
    if (w.status === 'rejected') await credit(s, { userId: w.user, amount: w.amount, split: { principal: w.fromPrincipal || 0, earned: w.fromEarned || 0 }, type: 'withdrawal_refund', note: 'Withdrawal rejected, refunded', relatedId: String(w._id) });
    if (w.status === 'completed') await M.Wallet.updateOne({ user: w.user }, { $inc: { totalWithdrawals: w.amount } }, { session: s });
    await notify(s, w.user, `Withdrawal ${w.status}`, w.remarks || `${inr(w.amount)} (net ${inr(w.net)})`, '/wallet'); return w;
  });
  await audit(req.user._id, 'withdrawal.' + out.status, String(out._id), req.body.remarks, { amount: out.amount, net: out.net }, req.ip); res.json(out);
}));

// ---------------- transfers / transactions / wallets ----------------
r.get('/transfers', asyncH(async (req, res) => res.json(await list(M.Transfer, req, { populate: [{ path: 'from', select: 'name userId' }, { path: 'to', select: 'name userId' }], search: ['reference', 'fromWalletId', 'toWalletId'], keys: [] }))));
r.get('/transactions', asyncH(async (req, res) => res.json(await list(M.WalletTransaction, req, { populate: { path: 'user', select: 'name userId walletId' }, search: ['reference', 'note'], keys: ['type'] }))));
r.get('/wallets', asyncH(async (req, res) => {
  const f = {};
  if (req.query.search) { const us = await M.User.find({ $or: [{ walletId: rx(req.query.search) }, { mobile: rx(req.query.search) }, { name: rx(req.query.search) }, { userId: rx(req.query.search) }] }).select('_id'); f.user = { $in: us.map((u) => u._id) }; }
  const { p, l, skip } = page(req.query);
  const [items, total] = await Promise.all([M.Wallet.find(f).populate('user', 'name userId').sort({ balance: -1 }).skip(skip).limit(l), M.Wallet.countDocuments(f)]);
  res.json({ items, total, page: p, limit: l });
}));
const findByRef = async (ref) => {
  const v = String(ref || '').trim(); const up = v.toUpperCase(); const digits = v.replace(/\D/g, '').slice(-10);
  const found = await M.User.find({ role: 'user', $or: [{ userId: up }, { walletId: up }, ...(digits.length === 10 ? [{ mobile: digits }] : [])] }).limit(2);
  if (!found.length) throw new HttpError(404, 'No user found with this User ID or mobile');
  if (found.length > 1) throw new HttpError(409, 'More than one match. Use the User ID.');
  return found[0];
};
r.get('/wallets/lookup/:ref', asyncH(async (req, res) => {
  const u = await findByRef(req.params.ref);
  const w = await M.Wallet.findOne({ user: u._id }); res.json({ name: u.name, userId: u.userId, mobile: u.mobile, balance: w?.balance || 0, principal: w?.principal || 0, earned: w?.earned || 0 });
}));
// Admin adds or deducts money in a user's wallet. A reason is mandatory and every adjustment is written to the audit log and the user's ledger.
r.post('/wallets/adjust', validate(z.object({ ref: z.string().min(3), direction: z.enum(['credit', 'debit']), bucket: z.enum(['auto', 'principal', 'earned']).default('auto'), amount: z.coerce.number().int().min(1), reason: z.string().min(5).max(300) })), asyncH(async (req, res) => {
  const { direction, bucket, amount, reason } = req.body;
  const u = await findByRef(req.body.ref);
  const out = await withTx(async (s) => {
    const o = direction === 'credit'
      ? await credit(s, { userId: u._id, amount, bucket: bucket === 'earned' ? 'earned' : 'principal', touchDeposit: bucket !== 'earned', type: 'adjustment', note: 'Admin credit: ' + reason })
      : await debit(s, { userId: u._id, amount, policy: bucket === 'auto' ? 'principal_first' : bucket, type: 'adjustment', note: 'Admin deduction: ' + reason });
    await notify(s, u._id, direction === 'credit' ? 'Funds added to your wallet' : 'Funds deducted from your wallet', `${inr(amount)} · ${reason}`, '/wallet');
    return o;
  });
  await audit(req.user._id, 'wallet.adjust', u.userId, reason, { direction, bucket, amount }, req.ip);
  res.json({ balance: out.wallet.balance, principal: out.wallet.principal, earned: out.wallet.earned });
}));
r.get('/audit-logs', asyncH(async (req, res) => res.json(await list(M.AuditLog, req, { populate: { path: 'actor', select: 'name' }, search: ['action', 'target', 'reason'], keys: [] }))));

// ---------------- bank accounts ----------------
r.get('/banks', asyncH(async (req, res) => {
  const o = await list(M.BankAccount, req, { populate: { path: 'user', select: uref }, search: ['bankName', 'holderName', 'last4'] });
  o.items = o.items.map((b) => ({ _id: b._id, user: b.user, holderName: b.holderName, bankName: b.bankName, masked: '•••• ' + b.last4, ifsc: b.ifsc, type: b.type, status: b.status, remarks: b.remarks, createdAt: b.createdAt })); res.json(o);
}));
r.patch('/banks/:id', validate(z.object({ status: z.enum(['verified', 'rejected']), remarks: z.string().max(300).optional() })), asyncH(async (req, res) => {
  const b = await M.BankAccount.findByIdAndUpdate(req.params.id, req.body, { new: true }); if (!b) throw new HttpError(404, 'Bank account not found');
  await M.Notification.create({ user: b.user, title: `Bank account ${b.status}`, body: b.remarks || b.bankName, link: '/banks' });
  await audit(req.user._id, 'bank.' + b.status, String(b._id), req.body.remarks, null, req.ip); res.json({ ok: true });
}));
// The full account number is only shown on demand, to pay a withdrawal, and every reveal is audited.
r.get('/banks/:id/reveal', asyncH(async (req, res) => {
  const b = await M.BankAccount.findById(req.params.id).populate('user', 'name userId'); if (!b) throw new HttpError(404, 'Bank account not found');
  await audit(req.user._id, 'bank.reveal', String(b._id), null, { user: b.user?.userId }, req.ip);
  res.json({ holderName: b.holderName, bankName: b.bankName, accountNumber: dec(b.accountEnc), ifsc: b.ifsc, type: b.type, owner: b.user?.name });
}));

// ---------------- referrals ----------------
r.get('/referrals', asyncH(async (req, res) => res.json(await list(M.Referral, req, { populate: [{ path: 'referrer', select: 'name userId referralCode' }, { path: 'referred', select: 'name userId' }], keys: [] }))));
r.get('/commissions', asyncH(async (req, res) => res.json(await list(M.ReferralCommission, req, { populate: [{ path: 'referrer', select: 'name userId' }, { path: 'referred', select: 'name userId' }] }))));
r.patch('/commissions/:id', validate(z.object({ status: z.enum(['approved', 'rejected']), remarks: z.string().optional() })), asyncH(async (req, res) => {
  if (req.body.status === 'approved') await approveCommission(req.params.id, req.user._id);
  else { const c = await M.ReferralCommission.findOneAndUpdate({ _id: req.params.id, status: 'pending' }, { status: 'rejected', reviewedBy: req.user._id }); if (!c) throw new HttpError(409, 'Already processed'); }
  await audit(req.user._id, 'commission.' + req.body.status, req.params.id, null, null, req.ip); res.json({ ok: true });
}));

// ---------------- daily returns ----------------
r.get('/returns', asyncH(async (req, res) => res.json(await list(M.DailyReturn, req, { populate: { path: 'user', select: 'name userId' }, keys: ['date'] }))));
r.get('/monthly-returns', asyncH(async (req, res) => res.json(await list(M.MonthlyReturn, req, { populate: { path: 'user', select: 'name userId' }, keys: ['month'] }))));
r.post('/returns/run-month-end', asyncH(async (req, res) => { const out = await runMonthEnd({ force: true }); await audit(req.user._id, 'returns.month_end', out.month || '', null, out, req.ip); res.json(out); }));
r.post('/returns/run', asyncH(async (req, res) => { const out = await runDailyReturns(); await audit(req.user._id, 'returns.run', out.date || '', null, out, req.ip); res.json(out); }));

// ---------------- settings / notifications ----------------
const pct = (max) => z.coerce.number().min(0).max(max);
const feeRow = z.object({ enabled: z.boolean(), label: z.string().min(1).max(40), percent: pct(50) });
r.get('/settings', asyncH(async (req, res) => { const s = await getSettings(); res.json({ ...s, preview: { dailyPercent: dailyPercent(s.returns) } }); }));
r.put('/settings', validate(z.object({
  returns: z.object({ enabled: z.boolean(), inputMode: z.enum(['daily', 'monthly']).default('daily'), dailyPercent: pct(10).default(0), monthlyPercent: pct(60), daysBasis: z.enum(['calendar', 'fixed30']), base: z.enum(['principal', 'balance']), minBalance: z.coerce.number().int().min(0), frequency: z.literal('daily').default('daily'), startDate: z.string().nullable().optional(), conditions: z.string().max(1500) }),
  principalReturn: z.object({ enabled: z.boolean(), percent: pct(100), minPrincipal: z.coerce.number().int().min(0), conditions: z.string().max(1500) }),
  referral: z.object({ enabled: z.boolean(), bookingEnabled: z.boolean().default(true), percent: pct(50), basis: z.literal('booking_amount').default('booking_amount'), eligibleActivity: z.enum(['first_completed_booking', 'every_completed_booking']), autoApprove: z.boolean(),
    deposit: z.object({ enabled: z.boolean(), percent: pct(50), eligible: z.enum(['first_deposit', 'every_deposit']), minAmount: z.coerce.number().int().min(0) }),
    holding: z.object({ enabled: z.boolean(), percent: pct(50), payout: z.enum(['daily', 'month_end']).default('month_end') }),
    earning: z.object({ enabled: z.boolean(), percent: pct(50), payout: z.enum(['daily', 'month_end']).default('month_end') }) }),
  wallet: z.object({ minWithdrawal: z.coerce.number().int().min(100), minDeposit: z.coerce.number().int().min(100), methods: z.array(z.string()).min(1), depositInstructions: z.string().max(600),
    tds: feeRow, service: feeRow, principalLock: z.object({ enabled: z.boolean(), mode: z.enum(['days', 'date']), days: z.coerce.number().int().min(0).max(3650), date: z.string().nullable().optional() }) }),
  contact: z.object({ whatsapp: z.string().regex(/^\d{8,15}$/, 'WhatsApp number: digits only with country code, e.g. 919876543210'), message: z.string().max(200), phone: z.string().max(40), email: z.string().max(120), address: z.string().max(200) }),
  legalReviewConfirmed: z.boolean().optional() })), asyncH(async (req, res) => {
  const { legalReviewConfirmed, ...data } = req.body; const cur = await getSettings();
  const on = (n, o) => n?.enabled && !o?.enabled;
  const enabling = on(data.returns, cur.returns) || on(data.principalReturn, cur.principalReturn) || on(data.referral, cur.referral) || on(data.referral.deposit, cur.referral.deposit) || on(data.referral.holding, cur.referral.holding) || on(data.referral.earning, cur.referral.earning);
  if (enabling && !legalReviewConfirmed) throw new HttpError(400, 'Tick the confirmation that legal/regulatory review is complete before switching on earnings or referral payouts');
  if (data.wallet.principalLock.enabled && data.wallet.principalLock.mode === 'date' && !data.wallet.principalLock.date) throw new HttpError(400, 'Choose the date until which principal stays locked');
  await M.ApplicationSetting.findOneAndUpdate({ key: 'app' }, { key: 'app', data }, { upsert: true });
  await audit(req.user._id, 'settings.update', 'app', null, data, req.ip); res.json(await getSettings());
}));
r.get('/notifications', asyncH(async (req, res) => res.json(await M.Notification.find({ forAdmin: true }).sort({ createdAt: -1 }).limit(50))));
r.post('/notifications/read-all', asyncH(async (req, res) => { await M.Notification.updateMany({ forAdmin: true }, { read: true }); res.json({ ok: true }); }));
module.exports = r;
