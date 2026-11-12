const { Schema, model } = require('mongoose');
const T = { timestamps: true };
const ref = (m) => ({ type: Schema.Types.ObjectId, ref: m });
const sparseUnique = (s, f) => { s.index(f, { unique: true, sparse: true }); return s; };

const userSchema = new Schema({
  userId: { type: String, unique: true }, walletId: { type: String, unique: true }, referralCode: { type: String, unique: true },
  name: { type: String, required: true }, username: { type: String, unique: true, required: true, lowercase: true },
  email: { type: String, lowercase: true, trim: true }, mobile: { type: String, index: true }, passwordHash: { type: String, select: false },
  role: { type: String, enum: ['user', 'admin'], default: 'user', index: true },
  referredBy: ref('User'), nominee: { name: String, relation: String, mobile: String, dob: String, address: String }, avatar: String, address: String, city: String, state: String, pin: String,
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
}, T);
// Email is optional now (users log in with their mobile number). It stays unique, but only when one is present.
userSchema.index({ email: 1 }, { unique: true, name: 'email_unique_when_set', partialFilterExpression: { email: { $type: 'string' } } });
const User = model('User', userSchema);

// All money is integer paise. balance = principal + earned.
// principal = deposits / transfers received / admin credits.  earned = daily returns + referral commissions.
const Wallet = model('Wallet', new Schema({
  user: { ...ref('User'), unique: true }, walletId: { type: String, unique: true },
  balance: { type: Number, default: 0, min: 0 }, principal: { type: Number, default: 0, min: 0 }, earned: { type: Number, default: 0, min: 0 },
  lastDepositAt: Date, lockUntil: Date,
  totalDeposits: { type: Number, default: 0 }, totalWithdrawals: { type: Number, default: 0 },
  totalReturns: { type: Number, default: 0 }, totalTransfers: { type: Number, default: 0 },
}, T));

const txSchema = new Schema({
  user: { ...ref('User'), index: true }, wallet: ref('Wallet'), reference: { type: String, unique: true },
  type: { type: String, enum: ['deposit', 'withdrawal', 'withdrawal_refund', 'transfer_in', 'transfer_out', 'transfer_refund', 'return', 'referral', 'adjustment'] },
  direction: { type: String, enum: ['credit', 'debit'] }, amount: { type: Number, min: 1 }, balanceAfter: Number,
  principalDelta: { type: Number, default: 0 }, earnedDelta: { type: Number, default: 0 }, note: String, relatedId: String,
}, T);
txSchema.index({ user: 1, createdAt: -1 });
const WalletTransaction = model('WalletTransaction', txSchema); // append-only: no update/delete routes exist

const Service = model('Service', new Schema({
  name: { type: String, required: true }, slug: { type: String, unique: true }, description: String, image: String,
  items: [String], active: { type: Boolean, default: true }, allowCustom: { type: Boolean, default: false }, order: { type: Number, default: 0 },
}, T));

const bookingSchema = new Schema({
  bookingId: { type: String, unique: true }, user: { ...ref('User'), index: true }, service: ref('Service'),
  category: String, serviceName: String, customerName: String, username: String, userCode: String, mobile: String, description: String,
  quantity: { type: Number, default: 1 }, address: String, preferredDate: Date, additional: String, audio: String,
  status: { type: String, enum: ['pending', 'confirmed', 'in_progress', 'completed', 'cancelled'], default: 'pending', index: true },
  amount: { type: Number, default: 0 }, remarks: String,
  timeline: [{ status: String, at: { type: Date, default: Date.now }, note: String }],
}, T);
bookingSchema.index({ createdAt: -1 });
const Booking = model('Booking', bookingSchema);

const Deposit = model('Deposit', sparseUnique(new Schema({
  user: { ...ref('User'), index: true }, amount: Number, method: String, txnRef: String, proof: String, paymentAccount: ref('PaymentAccount'), paidTo: String, target: { type: String, enum: ['principal', 'earned'], default: 'principal' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true }, remarks: String, reviewedBy: ref('User'), idemKey: String,
}, T), { user: 1, idemKey: 1 }));

// Receiving accounts the admin adds (bank or UPI). Users pay into one of these, then submit a deposit request.
const PaymentAccount = model('PaymentAccount', new Schema({
  type: { type: String, enum: ['bank', 'upi'], required: true }, label: String,
  holderName: String, bankName: String, accountNumber: String, ifsc: String, branch: String, accountType: { type: String, enum: ['savings', 'current'], default: 'current' },
  upiId: String, qrImage: String, note: String, active: { type: Boolean, default: true }, order: { type: Number, default: 0 },
}, T));

const Withdrawal = model('Withdrawal', sparseUnique(new Schema({
  user: { ...ref('User'), index: true }, bank: ref('BankAccount'), amount: Number,
  tds: { type: Number, default: 0 }, tdsLabel: String, tdsPercent: Number,
  serviceCharge: { type: Number, default: 0 }, serviceLabel: String, servicePercent: Number,
  fee: Number, net: Number, fromEarned: { type: Number, default: 0 }, fromPrincipal: { type: Number, default: 0 }, notes: String,
  status: { type: String, enum: ['pending', 'approved', 'processing', 'completed', 'rejected'], default: 'pending', index: true },
  remarks: String, reviewedBy: ref('User'), idemKey: String,
}, T), { user: 1, idemKey: 1 }));

const Transfer = model('Transfer', sparseUnique(new Schema({
  reference: { type: String, unique: true }, from: ref('User'), to: ref('User'), fromWalletId: String, toWalletId: String,
  amount: Number, source: String, lockUntil: Date, note: String, status: { type: String, enum: ['pending', 'completed', 'rejected'], default: 'pending', index: true }, remarks: String, reviewedBy: ref('User'), idemKey: String,
}, T), { from: 1, idemKey: 1 }));

// Banners the admin uploads; shown at the top of the user landing page.
const Banner = model('Banner', new Schema({ image: { type: String, required: true }, title: String, subtitle: String, link: String, active: { type: Boolean, default: true }, order: { type: Number, default: 0 } }, T));

const BankAccount = model('BankAccount', new Schema({
  user: { ...ref('User'), index: true }, holderName: String, bankName: String, accountEnc: String, last4: String, ifsc: String,
  type: { type: String, enum: ['savings', 'current'], default: 'savings' }, isDefault: Boolean,
  status: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' }, remarks: String,
}, T));

const Referral = model('Referral', new Schema({ referrer: { ...ref('User'), index: true }, referred: { ...ref('User'), unique: true } }, T));

const ReferralCommission = model('ReferralCommission', new Schema({
  referrer: { ...ref('User'), index: true }, referred: ref('User'), activityKey: { type: String, unique: true }, kind: { type: String, enum: ['booking', 'deposit', 'holding', 'earning'], default: 'booking' },
  basis: Number, percent: Number, amount: Number,
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }, reviewedBy: ref('User'),
}, T));

const dr = new Schema({ user: ref('User'), date: String, basis: Number, monthlyPercent: Number, ratePercent: Number, amount: Number }, T);
dr.index({ user: 1, date: 1 }, { unique: true }); // a second credit for the same user and day is impossible
const DailyReturn = model('DailyReturn', dr);
const mr = new Schema({ user: ref('User'), month: String, basis: Number, percent: Number, amount: Number }, T);
mr.index({ user: 1, month: 1 }, { unique: true }); // one month-end credit per user per month
const MonthlyReturn = model('MonthlyReturn', mr);

const Notification = model('Notification', new Schema({
  user: { ...ref('User'), index: true }, forAdmin: { type: Boolean, default: false }, title: String, body: String, read: { type: Boolean, default: false }, link: String,
}, T));
const ApplicationSetting = model('ApplicationSetting', new Schema({ key: { type: String, unique: true }, data: Schema.Types.Mixed }, T));
const AuditLog = model('AuditLog', new Schema({ actor: ref('User'), action: String, target: String, reason: String, meta: Schema.Types.Mixed, ip: String }, T));

module.exports = { User, PaymentAccount, Banner, Wallet, WalletTransaction, Service, Booking, Deposit, Withdrawal, Transfer, BankAccount, Referral, ReferralCommission, DailyReturn, MonthlyReturn, Notification, ApplicationSetting, AuditLog };
