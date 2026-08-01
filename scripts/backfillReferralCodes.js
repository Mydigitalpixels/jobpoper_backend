/**
 * One-time, idempotent backfill: assign a unique referralCode to every
 * existing user that does not have one.
 *
 * Modelled on scripts/fixWorkerIdIndex.js. Safe to re-run — it only touches
 * documents still missing a code, and reports zero work on a second run.
 *
 * ORDER MATTERS: the partial unique index is ensured FIRST so the database
 * rejects any duplicate the instant a collision is attempted, and the
 * per-document retry handles it. Never backfill first and index later.
 *
 * RUN:      node scripts/backfillReferralCodes.js
 * DRY RUN:  node scripts/backfillReferralCodes.js --dry-run
 * UNDO:     db.users.updateMany({}, { $unset: { referralCode: '' } })
 *           (DESTRUCTIVE — regenerated codes differ; never run post-launch)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { generateId } = require('../utils/generateUniqueId');

const DRY = process.argv.includes('--dry-run');
const BATCH = 500;
const INDEX_NAME = 'referralCode_unique_partial';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log(`✅ Connected to ${mongoose.connection.name}${DRY ? '  (DRY RUN)' : ''}`);
  const users = mongoose.connection.db.collection('users');

  // --- 1. Pre-flight: detect pre-existing duplicate referralCode values ---
  const dupes = await users.aggregate([
    { $match: { referralCode: { $type: 'string' } } },
    { $group: { _id: '$referralCode', count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();

  if (dupes.length) {
    console.error(`❌ Found ${dupes.length} duplicate referralCode value(s). Resolve before continuing:`);
    dupes.forEach((d) => console.error(`   ${d._id} -> ${d.ids.length} users`));
    await mongoose.disconnect();
    process.exit(1);
  }

  // --- 2. Ensure the partial unique index exists (idempotent) ---
  if (!DRY) {
    await users.createIndex(
      { referralCode: 1 },
      { name: INDEX_NAME, unique: true, partialFilterExpression: { referralCode: { $type: 'string' } } }
    );
    console.log(`✅ Ensured partial unique index "${INDEX_NAME}".`);
  }

  // --- 3. Count remaining work ---
  const remaining = await users.countDocuments({ referralCode: { $exists: false } });
  console.log(`ℹ️  ${remaining} user(s) without a referralCode.`);
  if (DRY) {
    console.log('DRY RUN — no writes performed. Re-run without --dry-run to apply.');
    await mongoose.disconnect();
    return;
  }
  if (remaining === 0) {
    console.log('✅ Nothing to backfill.');
    await mongoose.disconnect();
    return;
  }

  // Assign a fresh unique code for one document, retrying on collision.
  const assignOne = async (id) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = generateId(5);
      const clash = await users.findOne({ referralCode: code }, { projection: { _id: 1 } });
      if (clash) continue;
      try {
        const r = await users.updateOne(
          { _id: id, referralCode: { $exists: false } },
          { $set: { referralCode: code } }
        );
        return r.modifiedCount === 1;
      } catch (e) {
        if (e.code === 11000) continue; // lost the race — try another code
        throw e;
      }
    }
    console.warn(`⚠️  Could not assign a code to ${id} after 6 attempts.`);
    return false;
  };

  // --- 4. Batch loop ---
  let done = 0;
  while (true) {
    const batch = await users
      .find({ referralCode: { $exists: false } }, { projection: { _id: 1 } })
      .limit(BATCH)
      .toArray();
    if (batch.length === 0) break;
    for (const u of batch) {
      // eslint-disable-next-line no-await-in-loop
      if (await assignOne(u._id)) done += 1;
    }
    console.log(`   … ${done}/${remaining} assigned`);
    await sleep(100); // keep the live API responsive
  }

  // --- 5. Verify ---
  const left = await users.countDocuments({ referralCode: { $exists: false } });
  console.log(`\n✅ Backfill complete. Assigned ${done}. Remaining without code: ${left}.`);
  console.log('   Rollback (DESTRUCTIVE): db.users.updateMany({}, { $unset: { referralCode: "" } })');

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('❌ Backfill failed:', err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
