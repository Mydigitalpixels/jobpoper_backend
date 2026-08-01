const express = require('express');
const router = express.Router();
const {
  getMyReferralSummary,
  getMyReferrals,
  validateReferralCode,
} = require('../controllers/referralController');
const { protect } = require('../middleware/auth');
const { validateLimiter } = require('../middleware/rateLimit');

router.use(protect); // every referral route requires an authenticated session

router.get('/me', getMyReferralSummary);
router.get('/my-referrals', getMyReferrals);
router.get('/validate/:code', validateLimiter, validateReferralCode);

module.exports = router;
