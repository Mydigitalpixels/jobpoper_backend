/**
 * Purge the accounts and phone records left behind by an SMS-pumping attack.
 *
 * WHAT IT REMOVES
 *   For every phone number matching a targeted country calling code:
 *     - User documents that are NOT phone-verified and have no activity
 *     - PhoneVerification records
 *     - Device (push token) records belonging to those users
 *     - Notification records belonging to those users
 *     - Location records belonging to those users
 *
 * WHAT IT KEEPS ON PURPOSE
 *     - OtpSendLog rows. That is your evidence trail for the incident and for
 *       the next one. Pass --purge-logs only after the report is finalised.
 *     - Any account that is phone-verified, or that has posted a task, placed
 *       an order, written a review or owns a business profile. Those look like
 *       real people; the script refuses them and lists them for manual review.
 *
 * USAGE (on the production server, from the backend folder)
 *
 *   # 1. See what would go, change nothing (default):
 *   node scripts/purgeOtpAbusers.js --countries=255
 *
 *   # 2. Same, but list every number:
 *   node scripts/purgeOtpAbusers.js --countries=255 --verbose
 *
 *   # 3. Actually delete:
 *   node scripts/purgeOtpAbusers.js --countries=255 --apply
 *
 *   # Options:
 *   --countries=255,880   calling codes to purge (no "+"). REQUIRED.
 *   --since-hours=168     only accounts created in the last N hours
 *   --apply               perform the deletion (otherwise it is a dry run)
 *   --purge-logs          also delete the OtpSendLog evidence rows
 *   --verbose             print every affected number
 */

require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../models/User');
const PhoneVerification = require('../models/PhoneVerification');
const OtpSendLog = require('../models/OtpSendLog');
const Device = require('../models/Device');
const Notification = require('../models/Notification');
const Location = require('../models/Location');
const Job = require('../models/Job');
const Order = require('../models/Order');
const Review = require('../models/Review');
const BusinessProfile = require('../models/BusinessProfile');

const argOf = (name, fallback = '') => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

const APPLY = hasFlag('apply');
const VERBOSE = hasFlag('verbose');
const PURGE_LOGS = hasFlag('purge-logs');
const SINCE_HOURS = Number(argOf('since-hours', '')) || null;

const codes = argOf('countries', process.env.OTP_BLOCKED_COUNTRY_CODES || '')
  .split(',')
  .map((s) => s.trim().replace(/\D/g, ''))
  .filter(Boolean);

const mask = (p) => {
  const s = String(p || '');
  return s.length <= 7 ? s : `${s.slice(0, 6)}${'•'.repeat(s.length - 10)}${s.slice(-4)}`;
};

(async () => {
  if (!codes.length) {
    console.error(
      'No country codes given.\n' +
      '  node scripts/purgeOtpAbusers.js --countries=255\n' +
      '(or set OTP_BLOCKED_COUNTRY_CODES in .env)'
    );
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(uri);

  const prefixRegex = new RegExp(`^\\+?(${codes.join('|')})`);
  console.log(`\n=== OTP abuser purge ===`);
  console.log(`mode        : ${APPLY ? 'APPLY (deletes data)' : 'DRY RUN (no changes)'}`);
  console.log(`countries   : ${codes.map((c) => `+${c}`).join(', ')}`);
  console.log(`window      : ${SINCE_HOURS ? `accounts created in the last ${SINCE_HOURS}h` : 'all time'}`);
  console.log(`otp logs    : ${PURGE_LOGS ? 'WILL BE DELETED' : 'kept (evidence)'}\n`);

  // ── 1. candidate accounts ──────────────────────────────────────────────────
  const userFilter = { phoneNumber: prefixRegex };
  if (SINCE_HOURS) {
    userFilter.createdAt = { $gte: new Date(Date.now() - SINCE_HOURS * 3600 * 1000) };
  }

  const candidates = await User.find(userFilter)
    .select('_id phoneNumber isPhoneVerified isVerified createdAt')
    .lean();

  console.log(`Matched ${candidates.length} account(s) in those countries.`);

  if (!candidates.length) {
    console.log('Nothing to do for User records.');
  }

  // ── 2. protect anything that looks real ────────────────────────────────────
  const ids = candidates.map((u) => u._id);
  const [jobOwners, orderUsers, reviewers, bizOwners] = await Promise.all([
    Job.distinct('postedBy', { postedBy: { $in: ids } }).catch(() => []),
    Order.distinct('customer', { customer: { $in: ids } }).catch(() => []),
    Review.distinct('reviewerId', { reviewerId: { $in: ids } }).catch(() => []),
    BusinessProfile.distinct('user', { user: { $in: ids } }).catch(() => []),
  ]);

  const activeIds = new Set(
    [...jobOwners, ...orderUsers, ...reviewers, ...bizOwners].map(String)
  );

  const keep = [];
  const purge = [];
  for (const u of candidates) {
    if (u.isPhoneVerified || u.isVerified || activeIds.has(String(u._id))) {
      keep.push(u);
    } else {
      purge.push(u);
    }
  }

  console.log(`  -> ${purge.length} unverified & inactive (will be purged)`);
  console.log(`  -> ${keep.length} verified or with activity (KEPT for manual review)`);

  if (keep.length) {
    console.log('\nKept accounts — check these by hand before deleting anything:');
    keep.forEach((u) =>
      console.log(`   ${mask(u.phoneNumber)}  verified=${u.isPhoneVerified}  created=${new Date(u.createdAt).toISOString()}`)
    );
  }

  if (VERBOSE && purge.length) {
    console.log('\nAccounts queued for deletion:');
    purge.forEach((u) =>
      console.log(`   ${mask(u.phoneNumber)}  created=${new Date(u.createdAt).toISOString()}`)
    );
  }

  // ── 3. related records ─────────────────────────────────────────────────────
  const purgeIds = purge.map((u) => u._id);

  const pvFilter = { phoneNumber: prefixRegex };
  const logFilter = { phoneNumber: prefixRegex };

  const counts = {
    users: purge.length,
    phoneVerifications: await PhoneVerification.countDocuments(pvFilter),
    devices: purgeIds.length ? await Device.countDocuments({ user: { $in: purgeIds } }).catch(() => 0) : 0,
    notifications: purgeIds.length ? await Notification.countDocuments({ recipient: { $in: purgeIds } }).catch(() => 0) : 0,
    locations: purgeIds.length ? await Location.countDocuments({ user: { $in: purgeIds } }).catch(() => 0) : 0,
    otpSendLogs: await OtpSendLog.countDocuments(logFilter),
  };

  console.log('\nRecords in scope:');
  Object.entries(counts).forEach(([k, v]) => console.log(`   ${String(v).padStart(6)}  ${k}`));

  // ── 4. do it ───────────────────────────────────────────────────────────────
  if (!APPLY) {
    console.log('\nDRY RUN — nothing was changed. Re-run with --apply to delete.\n');
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log('\nDeleting...');
  const results = {};
  if (purgeIds.length) {
    results.devices = (await Device.deleteMany({ user: { $in: purgeIds } }).catch(() => ({ deletedCount: 0 }))).deletedCount;
    results.notifications = (await Notification.deleteMany({ recipient: { $in: purgeIds } }).catch(() => ({ deletedCount: 0 }))).deletedCount;
    results.locations = (await Location.deleteMany({ user: { $in: purgeIds } }).catch(() => ({ deletedCount: 0 }))).deletedCount;
    results.users = (await User.deleteMany({ _id: { $in: purgeIds } })).deletedCount;
  }
  results.phoneVerifications = (await PhoneVerification.deleteMany(pvFilter)).deletedCount;
  if (PURGE_LOGS) {
    results.otpSendLogs = (await OtpSendLog.deleteMany(logFilter)).deletedCount;
  }

  console.log('\nDeleted:');
  Object.entries(results).forEach(([k, v]) => console.log(`   ${String(v).padStart(6)}  ${k}`));
  console.log('\nDone.');
  console.log(
    'REMINDER: deleting numbers does not prevent the next attack. The country ' +
    'block (OTP_ALLOWED_COUNTRY_CODES / Twilio Geo Permissions) is what does.\n'
  );

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('[purge] failed:', err);
  process.exit(1);
});
