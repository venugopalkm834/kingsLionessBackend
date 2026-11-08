const r = require('express').Router();
const { newUserId } = require('../utils/userid');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { User, Wallet, Referral } = require('../models');
const { ids, HttpError, asyncH, withTx } = require('../utils/helpers');
const { sign, auth, validate } = require('../middleware');
const { notifyAdmin } = require('../utils/ledger');

const pw = z.string().min(8).regex(/[A-Za-z]/, 'needs a letter').regex(/\d/, 'needs a number');
const reg = z.object({
  name: z.string().min(2).max(80), username: z.string().min(3).max(24).regex(/^[a-z0-9_]+$/i),
  email: z.string().email(), mobile: z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile'),
  password: pw, referralCode: z.string().optional(),
});
const publicUser = (u, w) => ({ id: u._id, userId: u.userId, name: u.name, username: u.username, email: u.email, mobile: u.mobile,
  role: u.role, referralCode: u.referralCode, avatar: u.avatar, address: u.address, city: u.city, state: u.state, pin: u.pin, status: u.status, createdAt: u.createdAt, ...(w ? { balance: w.balance } : {}) });

r.post('/register', validate(reg), asyncH(async (req, res) => {
  const b = req.body;
  if (await User.exists({ mobile: b.mobile })) throw new HttpError(409, 'This mobile number is already registered');
  const referrer = b.referralCode ? await User.findOne({ referralCode: b.referralCode.toUpperCase() }) : null;
  const user = await withTx(async (s) => {
    const [u] = await User.create([{ ...b, username: b.username.toLowerCase(), passwordHash: await bcrypt.hash(b.password, 12),
      userId: await newUserId(User, s), walletId: ids.wallet(), referralCode: ids.refCode(), referredBy: referrer?._id }], { session: s });
    await Wallet.create([{ user: u._id, walletId: u.walletId }], { session: s });
    // self-referral is impossible: the new user's code did not exist before registration
    if (referrer) await Referral.create([{ referrer: referrer._id, referred: u._id }], { session: s });
    return u;
  });
  notifyAdmin('New user registered', `${user.name} (${user.userId})`, '/admin/users').catch(() => {});
  res.status(201).json({ token: sign(user), user: publicUser(user) });
}));

const login = (adminOnly) => asyncH(async (req, res) => {
  const { identifier, password } = req.body;
  const q = identifier.toLowerCase();
  const u = await User.findOne({ $or: [{ email: q }, { username: q }] }).select('+passwordHash');
  if (!u || !(await bcrypt.compare(password, u.passwordHash))) throw new HttpError(401, 'Invalid credentials');
  if (adminOnly !== (u.role === 'admin')) throw new HttpError(403, adminOnly ? 'Not an admin account' : 'Please use the admin login');
  if (u.status !== 'active') throw new HttpError(403, 'Account suspended');
  res.json({ token: sign(u), user: publicUser(u) });
});
const lg = validate(z.object({ identifier: z.string().min(2), password: z.string().min(1) }));
r.post('/login', lg, login(false));
r.post('/admin/login', lg, login(true));

r.get('/me', auth, asyncH(async (req, res) => { const w = await Wallet.findOne({ user: req.user._id }); res.json(publicUser(req.user, w)); }));
r.put('/me', auth, validate(z.object({ name: z.string().min(2).max(80), mobile: z.string().regex(/^[6-9]\d{9}$/), address: z.string().max(300).optional(),
  city: z.string().max(80).optional(), state: z.string().max(80).optional(), pin: z.string().regex(/^\d{6}$/).optional().or(z.literal('')) })),
  asyncH(async (req, res) => { if (req.body.mobile !== req.user.mobile && (await User.exists({ mobile: req.body.mobile, _id: { $ne: req.user._id } }))) throw new HttpError(409, 'This mobile number is already registered'); Object.assign(req.user, req.body); await req.user.save(); res.json(publicUser(req.user)); }));
r.post('/change-password', auth, validate(z.object({ current: z.string(), next: pw })), asyncH(async (req, res) => {
  const u = await User.findById(req.user._id).select('+passwordHash');
  if (!(await bcrypt.compare(req.body.current, u.passwordHash))) throw new HttpError(400, 'Current password is incorrect');
  u.passwordHash = await bcrypt.hash(req.body.next, 12); await u.save(); res.json({ ok: true });
}));
module.exports = r;
