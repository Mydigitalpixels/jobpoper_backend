const mongoose = require('mongoose');

/**
 * Atomic OTP budget counters — one document per hour-bucket (and one per day).
 * Using findOneAndUpdate with $inc guarantees that concurrent requests cannot
 * overshoot the cap (the old count-then-send pattern had a TOCTOU race).
 *
 * Documents auto-expire via the TTL index so no cleanup job is needed.
 */
const otpBudgetSchema = new mongoose.Schema(
  {
    _id: { type: String },           // e.g. "global:2026-09-05T20" or "country:+255:2026-09-05T20"
    count: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false }
);

otpBudgetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Atomically reserve one send against a budget bucket.
 * @param {string} bucketId  — e.g. "global:2026-09-05T20"
 * @param {number} cap       — maximum allowed count
 * @param {number} ttlMs     — how long the bucket lives (ms)
 * @returns {Promise<{allowed: boolean, count: number}>}
 */
otpBudgetSchema.statics.reserve = async function (bucketId, cap, ttlMs = 7200_000) {
  const doc = await this.findOneAndUpdate(
    { _id: bucketId },
    {
      $inc: { count: 1 },
      $setOnInsert: { expiresAt: new Date(Date.now() + ttlMs) },
    },
    { upsert: true, new: true }
  );
  if (doc.count > cap) {
    // Over budget — release the reservation
    await this.updateOne({ _id: bucketId }, { $inc: { count: -1 } });
    return { allowed: false, count: doc.count - 1 };
  }
  return { allowed: true, count: doc.count };
};

/**
 * Release a reservation (call on Twilio send failure so failed sends don't
 * eat into the budget).
 */
otpBudgetSchema.statics.release = async function (bucketId) {
  await this.updateOne(
    { _id: bucketId, count: { $gt: 0 } },
    { $inc: { count: -1 } }
  );
};

module.exports = mongoose.model('OtpBudget', otpBudgetSchema);
