/**
 * One-time migration: fix the workerId unique index.
 *
 * WHY: workerId used to be declared with a field-level `unique` (originally
 * non-sparse, later sparse). Both variants break in production:
 *   - a non-sparse unique index rejects a 2nd document without a workerId;
 *   - a sparse unique index still indexes documents that store an explicit
 *     `null` (legacy rows created when the schema had `default: null`), so
 *     those collide with each other.
 * The result: saving a professional profile (the only flow that assigns a
 * workerId) throws E11000 "duplicate key" and the app shows
 * "Profile update failed. Please try again."
 *
 * WHAT THIS DOES (idempotent, safe to re-run):
 *   1. Unsets every `workerId: null` so the field becomes genuinely absent.
 *   2. Drops the old `workerId_1` index (whatever options it had).
 *   3. Creates a PARTIAL unique index that only covers real string workerIds,
 *      so any number of users without a workerId can coexist.
 *
 * RUN:  node scripts/fixWorkerIdIndex.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const NEW_INDEX_NAME = 'workerId_unique_partial';

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  console.log(`✅ Connected to ${mongoose.connection.name}`);

  const users = mongoose.connection.db.collection('users');

  // --- 1. Clean legacy explicit nulls -> unset the field entirely ---
  const cleanup = await users.updateMany(
    { workerId: null },
    { $unset: { workerId: '' } }
  );
  console.log(`🧹 Unset workerId on ${cleanup.modifiedCount} legacy document(s).`);

  // --- 2. Sanity check: no duplicate real workerIds before adding unique index ---
  const dupes = await users
    .aggregate([
      { $match: { workerId: { $type: 'string' } } },
      { $group: { _id: '$workerId', count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  if (dupes.length) {
    console.error(
      `❌ Found ${dupes.length} duplicate workerId value(s). Resolve these before creating a unique index:`
    );
    dupes.forEach((d) => console.error(`   ${d._id} -> ${d.ids.length} users`));
    console.error('Aborting without touching indexes.');
    await mongoose.disconnect();
    process.exit(1);
  }

  // --- 3. Drop any pre-existing workerId index ---
  const existing = await users.indexes();
  for (const idx of existing) {
    const keys = Object.keys(idx.key || {});
    if (keys.length === 1 && keys[0] === 'workerId') {
      await users.dropIndex(idx.name);
      console.log(`🗑️  Dropped old index "${idx.name}".`);
    }
  }

  // --- 4. Create the partial unique index ---
  await users.createIndex(
    { workerId: 1 },
    {
      name: NEW_INDEX_NAME,
      unique: true,
      partialFilterExpression: { workerId: { $type: 'string' } },
    }
  );
  console.log(`✅ Created partial unique index "${NEW_INDEX_NAME}".`);

  console.log('\nFinal indexes on users:');
  (await users.indexes()).forEach((i) =>
    console.log(
      `   ${i.name}: ${JSON.stringify(i.key)}${i.unique ? ' [unique]' : ''}${
        i.partialFilterExpression ? ' [partial]' : ''
      }`
    )
  );

  await mongoose.disconnect();
  console.log('\n✅ Migration complete.');
})().catch(async (err) => {
  console.error('❌ Migration failed:', err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
