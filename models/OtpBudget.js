const mongoose = require('mongoose');

/**
 * Atomic OTP spend budget.
 *
 * WHY THIS EXISTS
 * ---------------
 * The original global cap in otpGuard.js was a read-then-act check:
 *
 *     const sent = await OtpSendLog.countDocuments(...)   // READ
 *     if (sent >= cap) deny                               // DECIDE
 *     ...                                                 // await
 *     await TwilioService.sendVerificationCode(...)       // ACT (costs money)
 *     await logOtpSend({ result: 'sent' })                // WRITE (too late)
 *
 * Every concurrent request inside that window reads the same pre-burst count,
 * so all of them pass and all of them send. The 05 Sep incident log shows
 * exactly that shape: 12 sends in 4 seconds, five stamped in the same second.
 *
 * This collection replaces the count with a RESERVATION. `reserve()` is a
 * single atomic findOneAndUpdate with $inc + upsert, so N concurrent callers
 * get N distinct counter values and only the ones at or under the cap proceed.
 * A cap of 15 means at most 15 Twilio calls, no matter how parallel the
 * attacker is.
 *
 * Buckets are keyed by scope + time window, e.g.
 *   global:h:2026-09-09T20      global:d:2026-09-09
 *   country:+255:h:2026-09-09T20
 *   phone:+255703123456:d:2026-09-09
 *
 * Documents TTL-delete themselves 48h after creation.
 */
const otpBudgetSchema = new mongoose.Schema(
  {
    _id: { type: String },
    count: { type: Number, default: 0 },
    expiresAt: { type: Date },
  },
  { versionKey: false, timestamps: true }
);

otpBudgetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const OtpBudget = mongoose.model('OtpBudget', otpBudgetSchema);

const TTL_MS = 48 * 60 * 60 * 1000;

/**
 * Atomically claim one unit of budget.
 * @returns {Promise<{ ok: boolean, count: number }>} ok=false means the cap is
 *          already spent; the caller must NOT send and should release nothing
 *          (the over-cap increment is harmless — it decays with the bucket).
 */
const reserve = async (bucketId, cap) => {
  const doc = await OtpBudget.findOneAndUpdate(
    { _id: bucketId },
    {
      $inc: { count: 1 },
      $setOnInsert: { expiresAt: new Date(Date.now() + TTL_MS) },
    },
    { upsert: true, new: true }
  );
  return { ok: doc.count <= cap, count: doc.count };
};

/** Give a reservation back — used when the send never happened. */
const release = async (bucketId) => {
  try {
    await OtpBudget.updateOne({ _id: bucketId }, { $inc: { count: -1 } });
  } catch (err) {
    console.error('[OTP-BUDGET] release failed', bucketId, err.message);
  }
};

/** Release a list of bucket ids (best effort, never throws). */
const releaseAll = async (bucketIds = []) => {
  await Promise.all(bucketIds.map(release));
};

const hourBucket = (d = new Date()) => d.toISOString().slice(0, 13); // 2026-09-09T20
const dayBucket = (d = new Date()) => d.toISOString().slice(0, 10);  // 2026-09-09

module.exports = OtpBudget;
module.exports.reserve = reserve;
module.exports.release = release;
module.exports.releaseAll = releaseAll;
module.exports.hourBucket = hourBucket;
module.exports.dayBucket = dayBucket;
