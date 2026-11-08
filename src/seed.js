require('dotenv').config();
const { newUserId } = require('./utils/userid');
const bcrypt = require('bcryptjs');
const connect = require('./config/db');
const { User, Wallet, Service, ApplicationSetting } = require('./models');
const { ids } = require('./utils/helpers');
const svc = [
  ['Home Appliances', 'Installation, repair and servicing for the things your home runs on.', ['AC installation & repair', 'Refrigerator', 'Washing machine', 'Television', 'Electrical appliances', 'Maintenance']],
  ['Logistics', 'Goods transport, local delivery and commercial logistics on demand.', ['Goods transportation', 'Local delivery', 'Commercial logistics', 'Transportation services']],
  ['Manpower Supply', 'Skilled workers, technicians and helpers, placed when you need them.', ['Skilled workers', 'General labour', 'Technicians', 'Helpers', 'Professional manpower']],
  ['Civil Works', 'Construction, painting, plumbing, electrical work and renovation.', ['Construction', 'Painting', 'Plumbing', 'Electrical works', 'Renovation', 'Maintenance']],
  ['Trading', 'Products and commercial trading configured by our team.', ['Products', 'Commercial trading']],
  ['Others', 'Tell us what you need and we will find the right professional.', []],
];
(async () => {
  await connect();
  for (const [i, [name, description, items]] of svc.entries()) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await Service.updateOne({ slug }, { $setOnInsert: { name, slug, description, items, order: i, allowCustom: name === 'Others', active: true, image: `/assets/services/${slug}.svg` } }, { upsert: true });
  }
  const email = (process.env.ADMIN_EMAIL || 'admin@kingandlioness.local').toLowerCase();
  if (!(await User.findOne({ role: 'admin' }))) {
    const a = await User.create({ name: 'Administrator', username: 'admin', email, mobile: '9999999999', role: 'admin',
      passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD || 'ChangeMe@123', 12), userId: await newUserId(User), walletId: ids.wallet(), referralCode: ids.refCode() });
    await Wallet.create({ user: a._id, walletId: a.walletId });
  }
  await ApplicationSetting.updateOne({ key: 'app' }, { $setOnInsert: { data: {} } }, { upsert: true }); // defaults apply: returns and referral are OFF
  console.log('Seed complete. Admin login:', email); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
