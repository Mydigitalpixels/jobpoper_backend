const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { requirePhoneVerified } = require('../middleware/requirePhoneVerified');
const { uploadBusinessImages } = require('../middleware/upload');
const {
  createBusinessProfile,
  getMyBusinessProfiles,
  updateBusinessProfile,
  deleteBusinessProfile,
  listApprovedBusinessProfiles,
} = require('../controllers/businessProfileController');

// Authenticated routes
router.get('/me', protect, getMyBusinessProfiles);
router.get('/', protect, listApprovedBusinessProfiles);
// Creation requires a verified phone (no-op until ENFORCE_PHONE_VERIFICATION=true).
router.post('/', protect, requirePhoneVerified, ...uploadBusinessImages, createBusinessProfile);
router.put('/:id', protect, ...uploadBusinessImages, updateBusinessProfile);
router.delete('/:id', protect, deleteBusinessProfile);

module.exports = router;
