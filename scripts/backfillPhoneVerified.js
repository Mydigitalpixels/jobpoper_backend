/**
 * Backfill: mark every EXISTING user as phone-verified.
 *
 * WHY
 * ---
 * Until this release, signup was impossible without completing a Twilio OTP —
 * /auth/register hard-refused to create a user unless a verified
 * PhoneVerification record existed. So every account that exists right now is
 * legitimately phone-verified, even if the flag says otherwise.
 *
 * Phone verification now gates real actions (posting a task, contacting a
 * poster, showing interest, adding a business profile). Without this backfill,
 * live users would be interrupted by a verification sheet for a number they
 * already verified. This script is what guarantees "nothing breaks for people
 * already using the app".
 *
 * ORDERING — IMPORTANT
 * --------------------
 * Run this BEFORE deploying the modified /auth/register. If you deploy first,
 * users who sign up in the gap would be swept up by this backfill and marked
 * verified without ever having verified.
 *
 *   1. Take a database snapshot.
 *   2. node scripts/backfillPhoneVerified.js --dry-run
 *   3. Sanity-check the reported counts.
 *   4. node scripts/backfillPhoneVerified.js
 *   5. Deploy the backend.
 *
 * SAFETY
 * ------
 * Uses updateMany, so Mongoose validators and pre-save hooks do NOT fire. This
 * matters a great deal: a find().forEach(u => u.save()) loop would trip the
 * User pre-save hook and re-hash every already-hashed PIN, locking out every
 * user in the database. Do not "improve" this into a save() loop.
 *
 * Idempotent — safe to run more than once.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

const DRY_RUN = process.argv.includes('--dry-run');

const FILTER = {
  $or: [
    { isPhoneVerified: false },
    { isPhoneVerified: { $exists: false } },
  ],
};

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('[backfill] MONGODB_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`[backfill] connected${DRY_RUN ? ' (DRY RUN — nothing will be written)' : ''}`);

  const total = await User.countDocuments({});
  const affected = await User.countDocuments(FILTER);
  const alreadyOk = total - affected;

  console.log(`[backfill] total users              : ${total}`);
  console.log(`[backfill] already isPhoneVerified  : ${alreadyOk}`);
  console.log(`[backfill] to update                : ${affected}`);

  if (affected === 0) {
    console.log('[backfill] nothing to do.');
    await mongoose.disconnect();
    process.exit(0);
  }

  if (DRY_RUN) {
    const sample = await User.find(FILTER).select('_id phoneNumber createdAt').limit(5).lean();
    console.log('[backfill] sample of affected users:');
    sample.forEach((u) => {
      console.log(`           ${u._id}  ${u.phoneNumber}  ${u.createdAt || 'n/a'}`);
    });
    console.log('[backfill] dry run complete — re-run without --dry-run to apply.');
    await mongoose.disconnect();
    process.exit(0);
  }

  const result = await User.updateMany(FILTER, { $set: { isPhoneVerified: true } });
  console.log(`[backfill] matched ${result.matchedCount}, modified ${result.modifiedCount}`);

  const remaining = await User.countDocuments(FILTER);
  console.log(`[backfill] remaining unverified     : ${remaining}`);

  if (remaining !== 0) {
    console.error('[backfill] WARNING: some users were not updated. Investigate before deploying.');
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log('[backfill] done.');
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('[backfill] failed:', err);
  process.exit(1);
});
