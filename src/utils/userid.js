const crypto = require('crypto');
// Public user ID: KL + year + 4 random digits (e.g. KL20264821). Falls back to 5 digits if a year gets crowded.
async function newUserId(User, session) {
  const y = new Date().getFullYear();
  for (let i = 0; i < 60; i++) {
    const d = i < 40 ? 4 : 5; const id = `KL${y}${String(crypto.randomInt(0, 10 ** d)).padStart(d, '0')}`;
    const q = User.exists({ userId: id }); if (session) q.session(session);
    if (!(await q)) return id;
  }
  throw new Error('Could not generate a user ID');
}
module.exports = { newUserId };
