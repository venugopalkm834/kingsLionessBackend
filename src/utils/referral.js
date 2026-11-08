const M = require('../models');
const { HttpError, withTx, inr } = require('./helpers');
const { getSettings, credit, notify } = require('./ledger');

// Pays an approved commission into the referrer's EARNED income (withdrawable).
async function approveCommission(id, actorId) {
  return withTx(async (ses) => {
    const c = await M.ReferralCommission.findOneAndUpdate({ _id: id, status: 'pending' }, { status: 'approved', reviewedBy: actorId || null }, { new: true, session: ses });
    if (!c) throw new HttpError(409, 'Already processed');
    const label = { booking: 'Referral commission (booking)', deposit: 'Referral commission (deposit)', holding: 'Referral commission (holding)', earning: 'Referral commission (earnings)' }[c.kind] || 'Referral commission';
    await credit(ses, { userId: c.referrer, amount: c.amount, bucket: 'earned', type: 'referral', note: label, relatedId: c.activityKey });
    await notify(ses, c.referrer, 'Referral commission credited', `${inr(c.amount)} · ${label}`, '/referrals');
    return c;
  });
}
// The unique activityKey makes a second commission for the same activity impossible.
async function addCommission({ referrer, referred, kind, key, basis, percent, autoApprove, actorId }) {
  const amount = Math.floor((basis * percent) / 100); if (amount < 1) return null;
  try {
    const c = await M.ReferralCommission.create({ referrer, referred, kind, activityKey: key, basis, percent, amount });
    if (autoApprove) await approveCommission(c._id, actorId);
    return c;
  } catch (e) { if (e.code === 11000) return null; throw e; }
}
async function depositCommission(dep, actorId) {
  const s = (await getSettings()).referral; const d = s.deposit;
  if (!s.enabled || !d?.enabled || !(Number(d.percent) > 0)) return null;
  const u = await M.User.findById(dep.user); if (!u?.referredBy || String(u.referredBy) === String(u._id)) return null;
  if (dep.amount < (Number(d.minAmount) || 0)) return null;
  if (d.eligible === 'first_deposit' && (await M.Deposit.countDocuments({ user: u._id, status: 'approved', _id: { $ne: dep._id } })) > 0) return null;
  return addCommission({ referrer: u.referredBy, referred: u._id, kind: 'deposit', key: `dep:${dep._id}`, basis: dep.amount, percent: Number(d.percent), autoApprove: s.autoApprove, actorId });
}
module.exports = { approveCommission, addCommission, depositCommission };
