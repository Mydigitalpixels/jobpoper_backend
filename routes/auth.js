const express = require('express');
const router = express.Router();
const {
  sendPhoneVerification,
  resendPhoneVerification,
  verifyPhoneNumber,
  register,
  login,
  checkPhoneExists,
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

// Public routes
router.post('/send-verification', sendPhoneVerification);
router.post('/resend-verification', resendPhoneVerification);
router.post('/verify-phone', verifyPhoneNumber);
router.post('/register', register);
router.post('/login', login);
router.post('/check-phone', checkPhoneExists);

// Forgot Password Flow
router.post('/forgot-password/send-otp', sendForgotPasswordOtp);
router.post('/forgot-password/verify-otp', verifyForgotPasswordOtp);
router.post('/forgot-password/reset-pin', resetPin);

// Protected routes
router.use(protect); // All routes below this middleware are protected
router.get('/me', getMe);
router.put('/complete-profile', uploadProfileImage, completeProfile);
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
