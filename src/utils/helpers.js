const crypto = require('crypto');
const mongoose = require('mongoose');

const rnd = (n) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');
const ids = {
  user: () => 'USR' + rnd(7),
  wallet: () => 'WLT' + rnd(10),
  booking: () => `BKG-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${rnd(4)}`,
  txn: (p = 'TXN') => `${p}${Date.now().toString(36).toUpperCase()}${rnd(4)}`,
  refCode: () => crypto.randomBytes(4).toString('hex').toUpperCase(),
};

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Mongo transactions need a replica set. server.js turns them off automatically (dev only)
// when it detects a standalone mongod, so the app still runs; production must use a replica set.
const txState = { enabled: true };
async function withTx(fn) {
  if (!txState.enabled) return fn(null);
  const s = await mongoose.startSession();
  try { let out; await s.withTransaction(async () => { out = await fn(s); }); return out; }
  finally { s.endSession(); }
}

// AES-256-GCM for bank account numbers. Any ENC_KEY string works: it is hashed to a 32 byte key.
const key = () => crypto.createHash('sha256').update(String(process.env.ENC_KEY || '')).digest();
const enc = (t) => {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const d = Buffer.concat([c.update(String(t), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), d].map((b) => b.toString('hex')).join('.');
};
const dec = (s) => {
  const [iv, tag, d] = s.split('.').map((h) => Buffer.from(h, 'hex'));
  const c = crypto.createDecipheriv('aes-256-gcm', key(), iv); c.setAuthTag(tag);
  return Buffer.concat([c.update(d), c.final()]).toString('utf8');
};
// Identity numbers. Aadhaar: 12 digits, first digit 2-9, last digit is a Verhoeff check digit (catches typing mistakes). PAN: AAAAA9999A.
const VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
const verhoeff = (num) => { let c = 0; const a = String(num).split('').reverse().map(Number); for (let i = 0; i < a.length; i++) c = VD[c][VP[i % 8][a[i]]]; return c === 0; };
const isAadhaar = (v) => /^[2-9]\d{11}$/.test(v) && verhoeff(v);
const isPan = (v) => /^[A-Z]{3}[ABCFGHLJPTK][A-Z]\d{4}[A-Z]$/.test(v);
const idHash = (kind, v) => crypto.createHmac('sha256', String(process.env.ENC_KEY || '')).update(kind + ':' + v).digest('hex');
const page = (q) => { const p = Math.max(1, +q.page || 1); const l = Math.min(100, Math.max(1, +q.limit || 10)); return { p, l, skip: (p - 1) * l }; };
const inr = (paise) => '₹' + ((paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
module.exports = { ids, HttpError, asyncH, withTx, txState, enc, dec, isAadhaar, isPan, idHash, page, inr, fmtDate };
