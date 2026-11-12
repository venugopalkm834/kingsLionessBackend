require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);
const mongoose = require('mongoose');
const cron = require('node-cron');
const connect = require('./config/db');
const app = require('./app');
const { runDailyReturns, runMonthEnd } = require('./utils/returns');
const { txState } = require('./utils/helpers');
const { User } = require('./models');
for (const k of ['MONGO_URI', 'JWT_SECRET', 'ENC_KEY']) if (!process.env[k]) { console.error(`Missing env ${k}. Copy .env.example to .env and fill it in.`); process.exit(1); }
if (process.env.JWT_SECRET.length < 16) { console.error('JWT_SECRET must be at least 16 characters'); process.exit(1); }
connect().then(async () => {
  // One-time upgrade for existing databases: the old "email must be unique" index blocks accounts without an email.
  // The new partial index (email_unique_when_set) replaces it. Safe to run on every start.
  try { await User.collection.dropIndex('email_1'); console.log('Dropped old email index'); } catch (e) { /* already gone */ }
  await User.createIndexes().catch((e) => console.warn('index warning:', e.message));
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') {
    txState.enabled = false;
    console.warn('\n!! MongoDB is not a replica set: running WITHOUT transactions (fine for local testing only).\n!! Use the replica set in docker-compose.yml or MongoDB Atlas for production.\n');
  }
  // Runs daily at 00:10 server time; does nothing unless an admin switched the program on. Same-day reruns cannot double credit.
  cron.schedule('10 0 * * *', () => runDailyReturns().then((r) => console.log('daily returns', r)).catch(console.error));
  // Last day of the month at 23:55 (the function re-checks the date): principal return + month-end referral earning commission.
  cron.schedule('55 23 28-31 * *', () => runMonthEnd().then((r) => console.log('month-end', r)).catch(console.error));
  app.listen(process.env.PORT || 4000, () => console.log('Kings Lioness API on :' + (process.env.PORT || 4000)));
}).catch((e) => { console.error(e); process.exit(1); });
