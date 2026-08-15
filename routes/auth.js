const express = require('express');
const router = express.Router();
const {
  sendPhoneVerification,
  resendPhoneVerification,
  verifyPhoneNumber,
  register,
  login,
  checkPhoneExists,
  sendMyPhoneOtp,
  verifyMyPhoneOtp,
  getMyPhoneStatus,
  completeProfile,
  updateCurrentLocation,
  getMe,
  changePin,
  sendForgotPasswordOtp,
  verifyForgotPasswordOtp,
  resetPin,
  deleteAccount,
  submitVerificationDocuments,
  getVerificationStatus,
  getVerificationRequests,
  reviewVerificationRequest,
  getVehiclePreference,
  updateVehiclePreference,
  updateProfessionalProfile
} = require('../controllers/authController');
const { protect, authorize } = require('../middleware/auth');
const { uploadProfileImage, uploadVerificationDocuments, uploadWorkImages } = require('../middleware/upload');
const {
  completeProfileLimiter,
  otpSendLimiter,
  otpVerifyLimiter,
  publicOtpLimiter,
} = require('../middleware/rateLimit');

// Only rate-limit complete-profile calls that actually carry a referral code,
// so ordinary profile completion is never throttled. Multipart bodies are
// parsed after upload middleware, so this runs post-upload in the chain below.
const referralRateGate = (req, res, next) => {
  const hasCode = !!(req.body && String(req.body.referralCode || '').trim());
  return hasCode ? completeProfileLimiter(req, res, next) : next();
};

// Public routes
// NOTE: send/resend/verify-phone are LEGACY. Signup no longer uses them — they
// remain only so app builds <= 1.4.5 keep working. New clients use the
// authenticated /phone/* routes below. Do not remove until those builds are
// no longer in the wild.
router.post('/send-verification', publicOtpLimiter, sendPhoneVerification);
router.post('/resend-verification', publicOtpLimiter, resendPhoneVerification);
router.post('/verify-phone', publicOtpLimiter, verifyPhoneNumber);
router.post('/register', register);
router.post('/login', login);
router.post('/check-phone', checkPhoneExists);

// Forgot Password Flow — send-otp is public and costs Twilio money, so it
// shares the same IP limiter as the legacy signup OTP routes.
router.post('/forgot-password/send-otp', publicOtpLimiter, sendForgotPasswordOtp);
router.post('/forgot-password/verify-otp', publicOtpLimiter, verifyForgotPasswordOtp);
router.post('/forgot-password/reset-pin', resetPin);

// Protected routes
router.use(protect); // All routes below this middleware are protected
router.get('/me', getMe);

// In-app phone verification (replaces the OTP step that used to sit inside
// signup). Always operates on the authenticated user's own phone number.
router.post('/phone/send-otp', otpSendLimiter, sendMyPhoneOtp);
router.post('/phone/verify-otp', otpVerifyLimiter, verifyMyPhoneOtp);
router.get('/phone/status', getMyPhoneStatus);

router.put('/complete-profile', uploadProfileImage, referralRateGate, completeProfile);
router.put('/current-location', updateCurrentLocation);
router.get('/verification-status', getVerificationStatus);
router.put('/verification-documents', uploadVerificationDocuments, submitVerificationDocuments);
router.put('/change-pin', changePin);
router.get('/vehicle-preference', getVehiclePreference);
router.put('/vehicle-preference', updateVehiclePreference);
router.put('/professional-profile', uploadWorkImages, updateProfessionalProfile);
router.delete('/delete-account', deleteAccount);
router.get('/verification-requests', authorize('admin'), getVerificationRequests);
router.put('/verification-requests/:userId/review', authorize('admin'), reviewVerificationRequest);

module.exports = router;
