const r = require('express').Router();
const { newUserId } = require('../utils/userid');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { User, Wallet, Referral } = require('../models');
const { ids, HttpError, asyncH, withTx, enc, isAadhaar, isPan, idHash } = require('../utils/helpers');
const { sign, auth, validate } = require('../middleware');
const { notifyAdmin } = require('../utils/ledger');

const pw = z.string().min(8).regex(/[A-Za-z]/, 'needs a letter').regex(/\d/, 'needs a number');
// Users sign up with name, username, mobile and password (no email) and sign in with mobile OR username.
const mobile = z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile');
const aadhaar = z.string().transform((v) => v.replace(/[\s-]/g, '')).refine(isAadhaar, 'Enter a valid 12-digit Aadhaar number');
const pan = z.string().transform((v) => v.trim().toUpperCase()).refine(isPan, 'Enter a valid PAN, e.g. ABCDE1234F');
const reg = z.object({
  aadhaar, pan,
  name: z.string().min(2).max(80), username: z.string().min(3).max(24).regex(/^[a-z0-9_]+$/i, 'Letters, numbers and _ only'), mobile, password: pw, referralCode: z.string().optional(),
});
const publicUser = (u, w) => ({ id: u._id, userId: u.userId, name: u.name, username: u.username, email: u.email, mobile: u.mobile,
  role: u.role, referralCode: u.referralCode, aadhaarLast4: u.aadhaarLast4, panLast4: u.panLast4, nominee: u.nominee, avatar: u.avatar, address: u.address, city: u.city, state: u.state, pin: u.pin, status: u.status, createdAt: u.createdAt, ...(w ? { balance: w.balance } : {}) });

r.post('/register', validate(reg), asyncH(async (req, res) => {
  const b = req.body;
  if (await User.exists({ mobile: b.mobile })) throw new HttpError(409, 'This mobile number is already registered');
  const username = b.username.toLowerCase();
  if (await User.exists({ username })) throw new HttpError(409, 'This username is already taken');
  const aH = idHash('aadhaar', b.aadhaar), pH = idHash('pan', b.pan);
  if (await User.exists({ aadhaarHash: aH })) throw new HttpError(409, 'This Aadhaar number is already registered');
  if (await User.exists({ panHash: pH })) throw new HttpError(409, 'This PAN is already registered');
  const referrer = b.referralCode ? await User.findOne({ referralCode: b.referralCode.trim().toUpperCase() }) : null;
  if (b.referralCode && b.referralCode.trim() && !referrer) throw new HttpError(400, 'Invalid referral code. Check it or leave it blank.');
  const user = await withTx(async (s) => {
    const [u] = await User.create([{ name: b.name, mobile: b.mobile, username, passwordHash: await bcrypt.hash(b.password, 12),
      userId: await newUserId(User, s), walletId: ids.wallet(), referralCode: ids.refCode(), referredBy: referrer?._id,
      aadhaarEnc: enc(b.aadhaar), aadhaarHash: aH, aadhaarLast4: b.aadhaar.slice(-4), panEnc: enc(b.pan), panHash: pH, panLast4: b.pan.slice(-4) }], { session: s });
    await Wallet.create([{ user: u._id, walletId: u.walletId }], { session: s });
    // self-referral is impossible: the new user's code did not exist before registration
    if (referrer) await Referral.create([{ referrer: referrer._id, referred: u._id }], { session: s });
    return u;
  });
  notifyAdmin('New user registered', `${user.name} (${user.userId})`, '/admin/users').catch(() => {});
  res.status(201).json({ token: sign(user), user: publicUser(user) });
}));

// Public: lets the register page show who the referral code belongs to. Returns the first and last name only, nothing else.
r.get('/referral/:code', asyncH(async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,20}$/.test(code)) return res.json({ valid: false });
  const u = await User.findOne({ referralCode: code, role: 'user', status: 'active' }).select('name');
  res.json(u ? { valid: true, name: u.name } : { valid: false });
}));

// Customer login: mobile number OR username, plus password. Admin login keeps email / username.
r.post('/login', validate(z.object({ identifier: z.string().min(3).max(60), password: z.string().min(1) })), asyncH(async (req, res) => {
  const id = req.body.identifier.trim().toLowerCase();
  const q = /^[6-9]\d{9}$/.test(id) ? { mobile: id } : { username: id };
  // Older databases may hold more than one account on a number: the password decides which one it is.
  const candidates = await User.find({ ...q, role: 'user' }).select('+passwordHash');
  let u = null;
  for (const c of candidates) if (await bcrypt.compare(req.body.password, c.passwordHash)) { u = c; break; }
  if (!u) throw new HttpError(401, 'Invalid mobile / username or password');
  if (u.status !== 'active') throw new HttpError(403, 'Account suspended');
  res.json({ token: sign(u), user: publicUser(u) });
}));
r.post('/admin/login', validate(z.object({ identifier: z.string().min(2), password: z.string().min(1) })), asyncH(async (req, res) => {
  const q = req.body.identifier.toLowerCase();
  const u = await User.findOne({ role: 'admin', $or: [{ email: q }, { username: q }] }).select('+passwordHash');
  if (!u || !(await bcrypt.compare(req.body.password, u.passwordHash))) throw new HttpError(401, 'Invalid credentials');
  if (u.status !== 'active') throw new HttpError(403, 'Account suspended');
  res.json({ token: sign(u), user: publicUser(u) });
}));

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
