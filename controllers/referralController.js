const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const { generateUniqueReferralCode } = require('../utils/generateUniqueId');
const {
  buildReferredUser,
  REFERRED_USER_SELECT,
} = require('../utils/referralPresenter');

// Escape user input before using it inside a RegExp.
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// @desc    Own referral code + total referral count
// @route   GET /api/referrals/me
// @access  Private
const getMyReferralSummary = asyncHandler(async (req, res) => {
  const user = req.user;

  // Self-heal: a legacy session or a registration where generation failed
  // may have no code. Assign and persist one on first access so no user is
  // ever permanently stuck without a referral code.
  if (!user.referralCode) {
    try {
      const code = await generateUniqueReferralCode(User);
      await User.updateOne(
        { _id: user._id, referralCode: { $exists: false } },
        { $set: { referralCode: code } }
      );
      user.referralCode = code;
    } catch (err) {
      console.error('[REFERRAL] Lazy code assignment failed', err.message);
    }
  }

  const totalReferrals = await User.countDocuments({ referredBy: user._id });

  res.status(200).json({
    status: 'success',
    data: {
      referralCode: user.referralCode || null,
      totalReferrals,
    },
  });
});

// @desc    Paginated list of users referred by the caller (contact masked)
// @route   GET /api/referrals/my-referrals
// @access  Private
const getMyReferrals = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  const search = (req.query.search || '').trim();

  const query = { referredBy: req.user._id };
  if (search) {
    query['profile.fullName'] = { $regex: escapeRegExp(search), $options: 'i' };
  }

  const total = await User.countDocuments(query);
  const users = await User.find(query)
    .select(REFERRED_USER_SELECT)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  res.status(200).json({
    status: 'success',
    data: {
      referrals: users.map(buildReferredUser),
      page,
      limit,
      total,
      hasMore: page * limit < total,
    },
  });
});

// @desc    Soft pre-check of a typed referral code (200 with valid flag)
// @route   GET /api/referrals/validate/:code
// @access  Private
const validateReferralCode = asyncHandler(async (req, res) => {
  const code = (req.params.code || '').trim().toUpperCase();

  if (!/^[A-Z0-9]{5}$/.test(code)) {
    return res.status(400).json({
      status: 'error',
      code: 'REFERRAL_CODE_MALFORMED',
      message: 'Referral code must be 5 letters or numbers.',
    });
  }

  const referrer = await User.findOne({ referralCode: code })
    .select('_id isActive profile.fullName');

  // Not a valid target if missing, blocked, or the caller's own code.
  const isSelf = referrer && String(referrer._id) === String(req.user._id);
  if (!referrer || referrer.isActive === false || isSelf) {
    return res.status(200).json({ status: 'success', data: { valid: false } });
  }

  // First name + last initial only — enough to confirm, not to identify.
  const full = (referrer.profile && referrer.profile.fullName) || '';
  const parts = full.trim().split(/\s+/).filter(Boolean);
  let referrerName = parts[0] || 'a MakeMy Task user';
  if (parts.length > 1) referrerName += ` ${parts[parts.length - 1][0]}.`;

  res.status(200).json({
    status: 'success',
    data: { valid: true, referrerName },
  });
});

module.exports = {
  getMyReferralSummary,
  getMyReferrals,
  validateReferralCode,
};
