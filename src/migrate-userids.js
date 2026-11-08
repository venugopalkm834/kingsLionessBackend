// One-off: gives every existing account a KL<year>**** user ID (old IDs like USR1234567 are replaced). Wallet IDs are untouched.
require('dotenv').config();
const connect = require('./config/db'); const { User } = require('./models'); const { newUserId } = require('./utils/userid');
(async () => {
  await connect(); let n = 0;
  for (const u of await User.find({ userId: { $not: /^KL\d{8,9}$/ } })) { u.userId = await newUserId(User); await u.save(); n++; }
  console.log('Updated', n, 'user IDs'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
