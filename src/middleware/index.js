const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { User } = require('../models');
const { HttpError } = require('../utils/helpers');

const sign = (u) => jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES || '7d' });
async function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Authentication required');
    const p = jwt.verify(h.slice(7), process.env.JWT_SECRET);
    const u = await User.findById(p.id);
    if (!u) throw new HttpError(401, 'Invalid session');
    if (u.status !== 'active') throw new HttpError(403, 'Account suspended');
    req.user = u; next();
  } catch (e) { next(e.status ? e : new HttpError(401, 'Invalid or expired token')); }
}
const role = (r) => (req, res, next) => (req.user?.role === r ? next() : next(new HttpError(403, 'Forbidden')));
const validate = (schema) => (req, res, next) => {
  const r = schema.safeParse(req.body || {});
  if (!r.success) return next(new HttpError(422, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')));
  req.body = r.data; next();
};
const idem = (req) => req.headers['idempotency-key']?.toString().slice(0, 80);
const errorHandler = (err, req, res, next) => {
  if (err.code === 11000) return res.status(409).json({ message: 'Duplicate value: ' + Object.keys(err.keyPattern || {}).join(', ') });
  if (err.name === 'ZodError') return res.status(422).json({ message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  if (err.name === 'CastError') return res.status(400).json({ message: 'Invalid id' });
  if (err.name === 'MulterError') return res.status(400).json({ message: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid JSON body' });
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ message: status === 500 ? (process.env.NODE_ENV === 'production' ? 'Server error' : 'Server error: ' + err.message) : err.message });
};
// UPLOAD_DIR lets a hosted server keep uploads on a persistent disk (see DEPLOY.md). Default: ./uploads
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
require('fs').mkdirSync(uploadDir, { recursive: true });
const store = multer.diskStorage({
  destination: uploadDir,
  filename: (req, f, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(f.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '')),
});
const upload = multer({ storage: store, limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, f, cb) => (['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(f.mimetype) ? cb(null, true) : cb(new HttpError(400, 'Only PNG, JPG, WEBP or PDF files are allowed'))) });
// voice notes: recorded in the browser (webm/mp4) or picked from the phone (WhatsApp .opus/.ogg, .m4a, .mp3, .aac, .wav)
const uploadAudio = multer({ storage: store, limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, f, cb) => (/^audio\//.test(f.mimetype) || ['video/webm', 'video/mp4', 'application/ogg'].includes(f.mimetype) || /\.(opus|ogg|oga|m4a|mp3|aac|wav|webm|amr|3gp)$/i.test(f.originalname || '') ? cb(null, true) : cb(new HttpError(400, 'Please attach an audio file (mp3, m4a, ogg/opus, wav, webm)'))) });
module.exports = { sign, auth, role, validate, idem, errorHandler, upload, uploadAudio };
