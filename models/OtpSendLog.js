const mongoose = require('mongoose');

/**
 * Durable audit log for every OTP send attempt.
 *
 * PhoneVerification docs expire after 10 minutes, which is why the last
 * Twilio drain left almost no trail. This collection is the paper trail:
 * who asked, from where, to which number, and whether Twilio was charged.
 *
 * Kept for 90 days, then TTL-deleted. Raise expireAfterSeconds if you need
 * a longer investigation window.
 */
const otpSendLogSchema = new mongoose.Schema(
  {
    phoneNumber: { type: String, required: true, trim: true, index: true },
    maskedPhone: { type: String, default: '' },
    countryPrefix: { type: String, default: '', index: true },
    endpoint: {
      type: String,
      required: true,
      enum: [
        'send-verification',
        'resend-verification',
        'forgot-password',
        'phone-send-otp',
      ],
    },
    result: {
      type: String,
      required: true,
      enum: [
        'sent',
        'already_verified',
        'already_registered',
        'not_found',
        'invalid_phone',
        'country_blocked',
        'cooldown',
        'phone_capped',
        'global_capped',
        'twilio_failed',
      ],
      index: true,
    },
    ip: { type: String, default: '', index: true },
    userAgent: { type: String, default: '' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    twilioSid: { type: String, default: '' },
    errorCode: { type: String, default: '' },
    errorMessage: { type: String, default: '' },
  },
  { timestamps: true }
);

otpSendLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
otpSendLogSchema.index({ phoneNumber: 1, result: 1, createdAt: -1 });
otpSendLogSchema.index({ result: 1, createdAt: -1 });

module.exports = mongoose.model('OtpSendLog', otpSendLogSchema);
