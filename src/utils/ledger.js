const { Wallet, WalletTransaction, ApplicationSetting, Notification, AuditLog } = require('../models');
const { ids, HttpError } = require('./helpers');

const DEFAULTS = {
  returns: { enabled: false, inputMode: 'daily', dailyPercent: 0.3, monthlyPercent: 9, daysBasis: 'calendar', base: 'principal', minBalance: 100000, frequency: 'daily', startDate: null,
    conditions: 'Returns are a calculated program benefit under the published terms. They are not guaranteed and may be changed or withdrawn.' },
  // Separate program: a monthly % of the principal held, credited to earned income at month end.
  principalReturn: { enabled: false, percent: 2, minPrincipal: 100000,
    conditions: 'Month-end principal return is a program benefit under the published terms. It is not guaranteed and may be changed or withdrawn.' },
  referral: { enabled: false, percent: 10, basis: 'booking_amount', eligibleActivity: 'first_completed_booking', autoApprove: false, bookingEnabled: true,
    deposit: { enabled: false, percent: 5, eligible: 'first_deposit', minAmount: 0 },
    holding: { enabled: false, percent: 1, payout: 'month_end' },
    earning: { enabled: false, percent: 5, payout: 'month_end' } },
  wallet: {
    minWithdrawal: 50000, minDeposit: 10000, methods: ['UPI', 'Bank Transfer', 'NEFT/IMPS'], depositInstructions: 'Pay to the account shown by support, then upload the payment proof.',
    tds: { enabled: true, label: 'TDS', percent: 2 }, service: { enabled: true, label: 'Service charges', percent: 2 },
    principalLock: { enabled: true, mode: 'days', days: 30, date: null },
  },
  contact: { whatsapp: '919999999999', message: 'Hello Kings Lioness, I need help.', phone: '+91 99999 99999', email: 'support@kingandlioness.example', address: 'Bengaluru, India' },
};
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const merge = (a, b) => { const o = { ...a }; for (const k of Object.keys(b || {})) o[k] = isObj(a?.[k]) && isObj(b[k]) ? merge(a[k], b[k]) : b[k]; return o; };
async function getSettings() { const d = await ApplicationSetting.findOne({ key: 'app' }).lean(); return merge(DEFAULTS, d?.data || {}); }

// monthly percentage -> daily percentage. 'calendar' divides by the days in that month, 'fixed30' always by 30.
const daysIn = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
// inputMode 'daily': admin types the daily % directly. 'monthly': monthly % is divided into days.
const dailyPercent = (r, d = new Date()) => (r.inputMode === 'monthly' ? (Number(r.monthlyPercent) || 0) / (r.daysBasis === 'fixed30' ? 30 : daysIn(d)) : Number(r.dailyPercent) || 0);
const pad = (n) => String(n).padStart(2, '0');
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // server-local date
const monthStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const isLastDayOfMonth = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getDate() === 1;

// Principal can't be withdrawn while locked. Lock = last deposit + N days, or a fixed date, as set by the admin.
function lockInfo(L, wallet, now = new Date()) {
  if (!L?.enabled) return { locked: false, unlockAt: null };
  let base = null;
  if (L.mode === 'date') { if (L.date) base = new Date(L.date + 'T00:00:00.000Z'); }
  else if (Number(L.days) > 0 && wallet?.lastDepositAt) base = new Date(+new Date(wallet.lastDepositAt) + L.days * 864e5);
  // lockUntil is set when locked principal is received by transfer: it keeps the sender's remaining lock period.
  const extra = wallet?.lockUntil ? new Date(wallet.lockUntil) : null;
  if (L.mode === 'date' && !L.date && !extra) return { locked: true, unlockAt: null }; // lock on, date not set yet: stay locked
  const unlockAt = [base, extra].filter(Boolean).sort((a, b) => b - a)[0] || null;
  return { locked: !!unlockAt && now < unlockAt, unlockAt };
}
function calcFees(w, amount) {
  const tds = w.tds?.enabled ? Math.round((amount * w.tds.percent) / 100) : 0;
  const service = w.service?.enabled ? Math.round((amount * w.service.percent) / 100) : 0;
  return { tds, service, fee: tds + service, net: amount - tds - service };
}

// Every balance change goes through credit()/debit(), inside a Mongo transaction (session).
async function credit(session, { userId, amount, type, note, relatedId, bucket = 'principal', split, totals = {}, touchDeposit = false, lockUntil = null }) {
  const p = split ? split.principal : bucket === 'principal' ? amount : 0;
  const e = split ? split.earned : bucket === 'earned' ? amount : 0;
  if (p + e !== amount || amount < 1) throw new HttpError(400, 'Invalid amount');
  const update = { $inc: { balance: amount, principal: p, earned: e, ...totals } };
  if (touchDeposit) update.$set = { lastDepositAt: new Date() };
  if (lockUntil) update.$max = { lockUntil: new Date(lockUntil) };
  const w = await Wallet.findOneAndUpdate({ user: userId }, update, { new: true, session });
  if (!w) throw new HttpError(404, 'Wallet not found');
  const [tx] = await WalletTransaction.create([{ user: userId, wallet: w._id, reference: ids.txn(), type, direction: 'credit', amount, balanceAfter: w.balance, principalDelta: p, earnedDelta: e, note, relatedId }], { session });
  return { wallet: w, tx };
}
// policy: 'principal_first' | 'earned_first' | 'principal' | 'earned' | explicit split
async function debit(session, { userId, amount, type, note, relatedId, policy = 'principal_first', split, totals = {} }) {
  const w = await Wallet.findOne({ user: userId }).session(session);
  if (!w) throw new HttpError(404, 'Wallet not found');
  let p; let e;
  if (split) { p = split.principal; e = split.earned; }
  else if (policy === 'principal') { p = amount; e = 0; }
  else if (policy === 'earned') { p = 0; e = amount; }
  else if (policy === 'earned_first') { e = Math.min(w.earned, amount); p = amount - e; }
  else { p = Math.min(w.principal, amount); e = amount - p; }
  if (amount < 1 || p + e !== amount || p > w.principal || e > w.earned) throw new HttpError(400, 'Insufficient balance');
  const nw = await Wallet.findOneAndUpdate({ user: userId, principal: { $gte: p }, earned: { $gte: e } },
    { $inc: { balance: -amount, principal: -p, earned: -e, ...totals } }, { new: true, session });
  if (!nw) throw new HttpError(409, 'Balance changed, please try again');
  const [tx] = await WalletTransaction.create([{ user: userId, wallet: nw._id, reference: ids.txn(), type, direction: 'debit', amount, balanceAfter: nw.balance, principalDelta: -p, earnedDelta: -e, note, relatedId }], { session });
  return { wallet: nw, tx };
}
const notify = (session, userId, title, body, link) => Notification.create([{ user: userId, title, body, link }], { session });
const notifyAdmin = (title, body, link) => Notification.create({ forAdmin: true, title, body, link });
const audit = (actor, action, target, reason, meta, ip) => AuditLog.create({ actor, action, target, reason, meta, ip });
module.exports = { getSettings, credit, debit, notify, notifyAdmin, audit, DEFAULTS, dailyPercent, lockInfo, calcFees, todayStr, monthStr, isLastDayOfMonth };
