const { Wallet, DailyReturn, MonthlyReturn, Referral } = require('../models');
const { withTx, inr } = require('./helpers');
const { getSettings, credit, notify, dailyPercent, baseField, todayStr, monthStr, isLastDayOfMonth } = require('./ledger');
const { addCommission } = require('./referral');

// DAILY earning: the admin sets a daily % (or a monthly % that is split into days). Credited every day to EARNED income.
// Idempotent: the unique (user, date) index makes a second run on the same day a no-op per user.
async function creditDaily() {
  const s = (await getSettings()).returns; const date = todayStr();
  if (!s.enabled) return { skipped: 'Daily earnings are disabled in Settings', date };
  if (s.startDate && date < s.startDate) return { skipped: 'Program has not started yet', date };
  const pct = dailyPercent(s);
  if (!(pct > 0)) return { skipped: 'Daily percentage is 0', date };
  const base = baseField(s); // 'principal' | 'balance' | 'earned'
  let credited = 0; let duplicates = 0; let total = 0;
  for await (const w of Wallet.find({ [base]: { $gte: Math.max(1, s.minBalance) } }).cursor()) {
    const basis = w[base]; const amount = Math.floor((basis * pct) / 100); if (amount < 1) continue;
    try {
      await withTx(async (ses) => {
        await DailyReturn.create([{ user: w.user, date, basis, monthlyPercent: s.inputMode === 'monthly' ? s.monthlyPercent : null, ratePercent: pct, amount }], { session: ses });
        await credit(ses, { userId: w.user, amount, type: 'return', bucket: 'earned', note: `Daily earning ${pct.toFixed(4)}% for ${date}`, relatedId: date, totals: { totalReturns: amount } });
        await notify(ses, w.user, 'Daily earning credited', `${inr(amount)} for ${date}`, '/wallet');
      });
      credited++; total += amount;
    } catch (e) { if (e.code === 11000 || /E11000/.test(e.message)) duplicates++; else throw e; }
  }
  return { date, dailyPercent: pct, credited, duplicates, total };
}

// MONTH-END principal return (separate setting): percent of the principal held, credited once per month to EARNED income.
// Runs automatically on the last day of the month; admin can also run it manually (force) for the current month.
// Also pays the month-end referral "earning" commission (percent of what each referred user earned this month).
async function runMonthEnd({ force = false } = {}) {
  const st = await getSettings(); const s = st.principalReturn; const now = new Date(); const month = monthStr(now);
  if (!force && !isLastDayOfMonth(now)) return { skipped: 'Not the last day of the month', month };
  const out = { month, credited: 0, duplicates: 0, total: 0 };
  if (s.enabled && Number(s.percent) > 0) {
    for await (const w of Wallet.find({ principal: { $gte: Math.max(1, s.minPrincipal) } }).cursor()) {
      const amount = Math.floor((w.principal * Number(s.percent)) / 100); if (amount < 1) continue;
      try {
        await withTx(async (ses) => {
          await MonthlyReturn.create([{ user: w.user, month, basis: w.principal, percent: Number(s.percent), amount }], { session: ses });
          await credit(ses, { userId: w.user, amount, type: 'return', bucket: 'earned', note: `Month-end principal return ${s.percent}% for ${month}`, relatedId: 'M' + month, totals: { totalReturns: amount } });
          await notify(ses, w.user, 'Month-end principal return credited', `${inr(amount)} for ${month}`, '/wallet');
        });
        out.credited++; out.total += amount;
      } catch (e) { if (e.code === 11000 || /E11000/.test(e.message)) out.duplicates++; else throw e; }
    }
  } else out.principalReturn = 'disabled';
  const R = st.referral; out.referralCommissions = 0;
  const wantE = R.enabled && R.earning?.enabled && R.earning.payout !== 'daily' && Number(R.earning.percent) > 0;
  if (wantE) {
    for await (const ref of Referral.find().cursor()) {
      if (wantE) {
        // everything the referred user earned this month: daily earnings + month-end principal return
        const [d, m] = await Promise.all([DailyReturn.aggregate([{ $match: { user: ref.referred, date: { $regex: '^' + month } } }, { $group: { _id: null, v: { $sum: '$amount' } } }]),
          MonthlyReturn.aggregate([{ $match: { user: ref.referred, month } }, { $group: { _id: null, v: { $sum: '$amount' } } }])]);
        const basis = (d[0]?.v || 0) + (m[0]?.v || 0);
        if (basis > 0) { const c = await addCommission({ referrer: ref.referrer, referred: ref.referred, kind: 'earning', key: `earnm:${month}:${ref.referred}`, basis, percent: Number(R.earning.percent), autoApprove: R.autoApprove }); if (c) out.referralCommissions++; }
      }
    }
  }
  return out;
}

// Referral commissions that are paid DAILY (admin chooses daily or month-end per type):
//  - earning: % of the referred user's earning credited that day (when the admin chose daily payout).
async function runDailyReferral(date) {
  const R = (await getSettings()).referral; let made = 0;
  if (!R.enabled) return 0;
  const wantE = R.earning?.enabled && R.earning.payout === 'daily' && Number(R.earning.percent) > 0;
  if (!wantE) return 0;
  for await (const ref of Referral.find().cursor()) {
    if (wantE) {
      const dr = await DailyReturn.findOne({ user: ref.referred, date });
      if (dr?.amount) { const c = await addCommission({ referrer: ref.referrer, referred: ref.referred, kind: 'earning', key: `earn:${date}:${ref.referred}`, basis: dr.amount, percent: Number(R.earning.percent), autoApprove: R.autoApprove }); if (c) made++; }
    }
  }
  return made;
}
async function runDailyReturns() {
  const out = await creditDaily();
  out.referralCommissions = await runDailyReferral(out.date || todayStr());
  return out;
}
module.exports = { runDailyReturns, runMonthEnd };
