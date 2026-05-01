const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { uploadBusinessImages } = require('../middleware/upload');
const {
  createBusinessProfile,
  getMyBusinessProfiles,
  updateBusinessProfile,
  listApprovedBusinessProfiles,
} = require('../controllers/businessProfileController');

// Authenticated routes
router.get('/me', protect, getMyBusinessProfiles);
router.get('/', protect, listApprovedBusinessProfiles);
router.post('/', protect, ...uploadBusinessImages, createBusinessProfile);
router.put('/:id', protect, ...uploadBusinessImages, updateBusinessProfile);

module.exports = router;
