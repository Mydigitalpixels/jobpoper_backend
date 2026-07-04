const mongoose = require('mongoose');

const phoneVerificationSchema = new mongoose.Schema({
  phoneNumber: {
    type: String,
    required: [true, 'Phone number is required'],
    trim: true,
    // Allow any format (local e.g. 03001234567 or international +923001234567)
    // The User model enforces strict E.164 format at registration
  },
  verificationCode: {
    type: String,
    required: [true, 'Verification code is required'],
    length: [6, 'Verification code must be 6 digits']
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  attempts: {
    type: Number,
    default: 0,
    max: [5, 'Maximum verification attempts exceeded']
  },
  expiresAt: {
    type: Date,
    required: true,
    default: () => new Date(Date.now() + 10 * 60 * 1000) // 10 minutes from now
  },
  twilioSid: {
    type: String // Twilio verification SID
  }
}, {
  timestamps: true
});

// Index for better performance
phoneVerificationSchema.index({ phoneNumber: 1 });
phoneVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index

// Method to check if verification is valid
phoneVerificationSchema.methods.isValid = function() {
  return !this.isVerified && this.attempts < 5 && this.expiresAt > new Date();
};

// Method to increment attempts
phoneVerificationSchema.methods.incrementAttempts = function() {
  this.attempts += 1;
  return this.save();
};

// Method to mark as verified
phoneVerificationSchema.methods.markAsVerified = function() {
  this.isVerified = true;
  return this.save();
};

module.exports = mongoose.model('PhoneVerification', phoneVerificationSchema);
