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
  otpIpLimiter,
  registerLimiter,
  checkPhoneLimiter,
  loginLimiter,
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
router.post('/send-verification', otpIpLimiter, publicOtpLimiter, sendPhoneVerification);
router.post('/resend-verification', otpIpLimiter, publicOtpLimiter, resendPhoneVerification);
router.post('/verify-phone', publicOtpLimiter, verifyPhoneNumber);
// SECURITY — /register is the amplifier that made both SMS-pumping incidents
// possible: it is public, needs no OTP and returns a JWT for ANY phone number.
// The attacker minted one account per number they wanted to pump and spent
// each token on exactly one Twilio SMS, which reset every per-user limit.
// Registration is a once-per-person event, so an IP cap costs real users
// nothing. This does NOT make registration safe on its own — the destination
// number caps in otpGuard are what actually bound the spend — but it removes
// the free identity supply.
router.post('/register', registerLimiter, register);
router.post('/login', loginLimiter, login);
// Unauthenticated account-enumeration oracle: answers "does this number have
// an account?" for anyone who asks.
router.post('/check-phone', checkPhoneLimiter, checkPhoneExists);

// Forgot Password Flow — send-otp is public and costs Twilio money, so it
// shares the same IP limiter as the legacy signup OTP routes.
router.post('/forgot-password/send-otp', otpIpLimiter, publicOtpLimiter, sendForgotPasswordOtp);
router.post('/forgot-password/verify-otp', publicOtpLimiter, verifyForgotPasswordOtp);
router.post('/forgot-password/reset-pin', resetPin);

// Protected routes
router.use(protect); // All routes below this middleware are protected
router.get('/me', getMe);

// In-app phone verification (replaces the OTP step that used to sit inside
// signup). Always operates on the authenticated user's own phone number.
router.post('/phone/send-otp', otpIpLimiter, otpSendLimiter, sendMyPhoneOtp);
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
