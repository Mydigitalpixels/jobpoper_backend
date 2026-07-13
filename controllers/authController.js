const asyncHandler = require('express-async-handler');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Job = require('../models/Job');
const Location = require('../models/Location');
const Notification = require('../models/Notification');
const Device = require('../models/Device');
const PhoneVerification = require('../models/PhoneVerification');
const TwilioService = require('../services/twilioService');
const { sendPushToUserForNotification } = require('../services/pushNotificationService');
const { generateToken } = require('../middleware/auth');

const { generateUniqueWorkerId } = require('../utils/generateUniqueId');

const buildUserResponse = (user) => {
  let professionalProfile = user.professionalProfile || null;
  if (professionalProfile && Array.isArray(professionalProfile.serviceCategories)) {
    // Self-heal: drop any stray/unpopulated null entries (e.g. from legacy
    // records saved before serviceCategories was consistently populated).
    const cleanCategories = professionalProfile.serviceCategories.filter(Boolean);
    if (cleanCategories.length !== professionalProfile.serviceCategories.length) {
      professionalProfile = professionalProfile.toObject
        ? { ...professionalProfile.toObject(), serviceCategories: cleanCategories }
        : { ...professionalProfile, serviceCategories: cleanCategories };
    }
  }

  return {
    id: user._id,
    phoneNumber: user.phoneNumber,
    isVerified: user.isVerified,
    isPhoneVerified: user.isPhoneVerified,
    profile: user.profile,
    verification: user.verification,
    vehiclePreference: user.vehiclePreference,
    workerId: user.workerId || null,
    rating: user.rating || { average: 0, count: 0 },
    isProfessional: user.isProfessional || false,
    professionalProfile,
    role: user.role,
    lastLogin: user.lastLogin
  };
};

// Populate professionalProfile.serviceCategories (ObjectId refs) on a user
// document so the client always receives full category objects instead of
// raw IDs. Safe to call on users without a professionalProfile. Never throws
// - if populate fails for any reason we fall back to the unpopulated data
// rather than failing the whole request.
const populateServiceCategories = async (user) => {
  if (!user || !user.professionalProfile) return user;
  try {
    await user.populate("professionalProfile.serviceCategories", "name slug icon");
  } catch (err) {
    console.error("[PROFILE] Failed to populate serviceCategories (non-fatal)", {
      userId: user._id,
      error: err.message,
    });
  }
  return user;
};

const parseCoordinate = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const applyCurrentLocation = (user, { fullAddress, latitude, longitude }) => {
  const parsedLatitude = parseCoordinate(latitude);
  const parsedLongitude = parseCoordinate(longitude);

  if (!fullAddress || parsedLatitude === null || parsedLongitude === null) {
    return false;
  }

  user.profile.location = fullAddress;
  user.profile.currentLocation = {
    fullAddress,
    latitude: parsedLatitude,
    longitude: parsedLongitude,
    updatedAt: new Date()
  };
  return true;
};

// @desc    Send phone verification code
// @route   POST /api/auth/send-verification
// @access  Public
const sendPhoneVerification = asyncHandler(async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({
      status: 'error',
      message: 'Phone number is required'
    });
  }

  // Check if phone number already exists
  const existingUser = await User.findOne({ phoneNumber });
  if (existingUser) {
    return res.status(400).json({
      status: 'error',
      message: 'Phone number already registered'
    });
  }

  try {
    const result = await TwilioService.sendVerificationCode(phoneNumber);

    res.status(200).json({
      status: 'success',
      message: 'Verification code sent successfully',
      data: {
        phoneNumber,
        twilioSid: result.twilioSid
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// @desc    Resend phone verification code
// @route   POST /api/auth/resend-verification
// @access  Public
const resendPhoneVerification = asyncHandler(async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({
      status: 'error',
      message: 'Phone number is required'
    });
  }

  // Optional: keep same behavior as sendPhoneVerification and prevent resend for already registered numbers
  const existingUser = await User.findOne({ phoneNumber });
  if (existingUser) {
    return res.status(400).json({
      status: 'error',
      message: 'Phone number already registered'
    });
  }

  try {
    const result = await TwilioService.sendVerificationCode(phoneNumber);

    res.status(200).json({
      status: 'success',
      message: 'Verification code resent successfully',
      data: {
        phoneNumber,
        twilioSid: result.twilioSid
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// @desc    Verify phone number
// @route   POST /api/auth/verify-phone
// @access  Public
const verifyPhoneNumber = asyncHandler(async (req, res) => {
  const { phoneNumber, verificationCode } = req.body;

  if (!phoneNumber || !verificationCode) {
    return res.status(400).json({
      status: 'error',
      message: 'Phone number and verification code are required'
    });
  }

  try {
    const result = await TwilioService.verifyCode(phoneNumber, verificationCode);

    res.status(200).json({
      status: 'success',
      message: 'Phone number verified successfully',
      data: {
        phoneNumber,
        isVerified: true
      }
    });
  } catch (error) {
    res.status(400).json({
      status: 'error',
      message: error.message
    });
  }
});

// @desc    Register user with phone and PIN
// @route   POST /api/auth/register
// @access  Public
const register = asyncHandler(async (req, res) => {
  const { phoneNumber, pin } = req.body;

  if (!phoneNumber || !pin) {
    return res.status(400).json({
      status: 'error',
      message: 'Phone number and PIN are required'
    });
  }

  // Validate PIN format
  if (!/^\d{4}$/.test(pin)) {
    return res.status(400).json({
      status: 'error',
      message: 'PIN must be exactly 4 digits'
    });
  }

  // Check if phone number is verified
  const isVerified = await TwilioService.isPhoneVerified(phoneNumber);
  if (!isVerified) {
    return res.status(400).json({
      status: 'error',
      message: 'Phone number must be verified before registration'
    });
  }

  // Check if user already exists
  const existingUser = await User.findOne({ phoneNumber });
  if (existingUser) {
    return res.status(400).json({
      status: 'error',
      message: 'User already exists with this phone number'
    });
  }

  try {
    // Create user
    const user = await User.create({
      phoneNumber,
      pin,
      isPhoneVerified: true,
      isVerified: false
    });

    // Generate JWT token
    const token = generateToken(user._id);

    res.status(201).json({
      status: 'success',
      message: 'User registered successfully',
      data: {
        token,
        user: buildUserResponse(user)
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to create user account'
    });
  }
});

// @desc    Login user with phone and PIN
// @route   POST /api/auth/login
// @access  Public
const login = asyncHandler(async (req, res) => {
  const { phoneNumber, pin } = req.body;

  if (!phoneNumber || !pin) {
    return res.status(400).json({
      status: 'error',
      message: 'Phone number and PIN are required'
    });
  }

  // Find user by phone number
  const user = await User.findOne({ phoneNumber });

  if (!user) {
    return res.status(401).json({
      status: 'error',
      message: 'Invalid credentials'
    });
  }

  // Check if user is active
  if (!user.isActive) {
    return res.status(401).json({
      status: 'error',
      message: 'Account is deactivated'
    });
  }

  // Verify PIN
  const isPinValid = await user.comparePin(pin);
  if (!isPinValid) {
    return res.status(401).json({
      status: 'error',
      message: 'Invalid credentials'
    });
  }

  // Update last login
  user.lastLogin = new Date();
  await user.save();

  // Generate JWT token
  const token = generateToken(user._id);

  res.status(200).json({
    status: 'success',
    message: 'Login successful',
    data: {
      token,
      user: buildUserResponse(user)
    }
  });
});

// @desc    Check if phone number exists
// @route   POST /api/auth/check-phone
// @access  Public
const checkPhoneExists = asyncHandler(async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({
      status: 'error',
      message: 'Phone number is required'
    });
  }

  try {
    const user = await User.findOne({ phoneNumber }).select('_id isActive');

    const exists = !!user;
    const isActive = user ? user.isActive : false;

    res.status(200).json({
      status: 'success',
      data: {
        exists,
        isActive
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to check phone number',
      error: error.message
    });
  }
});

// @desc    Complete user profile
// @route   PUT /api/auth/complete-profile
// @access  Private
const completeProfile = asyncHandler(async (req, res) => {
  const { fullName, email, location, latitude, longitude } = req.body;
  const user = req.user;

  console.log("[PROFILE] completeProfile called", {
    userId: user?._id,
    phoneNumber: user?.phoneNumber,
    hasFullName: !!fullName,
    hasEmail: !!email,
    hasLocation: !!location,
  });

  // Validate required fields
  if (!fullName || !email) {
    console.warn("[PROFILE] Validation failed: fullName/email missing", {
      userId: user?._id,
      fullNameProvided: !!fullName,
      emailProvided: !!email,
    });
    return res.status(400).json({
      status: 'error',
      message: 'Full name and email are required'
    });
  }

  try {
    // Validate email format if provided
    if (email && !/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/.test(email)) {
      console.warn("[PROFILE] Validation failed: invalid email format", {
        userId: user?._id,
        email,
      });
      return res.status(400).json({
        status: 'error',
        message: 'Please enter a valid email address'
      });
    }

    // Update profile
    console.log("[PROFILE] Updating profile fields for user", user._id, {
      hasLocation: !!location,
      hasProfileImage: !!req.processedFileName,
    });
    user.profile.fullName = fullName;
    user.profile.email = email;
    if (location) {
      const updatedCurrentLocation = applyCurrentLocation(user, {
        fullAddress: location,
        latitude,
        longitude
      });
      if (!updatedCurrentLocation) {
        user.profile.location = location;
      }
    }
    // If a file was uploaded and processed, use that; otherwise keep existing value
    if (req.processedFileName) {
      user.profile.profileImage = `profiles/${req.processedFileName}`;
    }
    user.profile.isProfileComplete = true;

    // Save isProfessional flag if provided
    const { isProfessional } = req.body;
    if (isProfessional !== undefined) {
      user.isProfessional = isProfessional === true || isProfessional === 'true';
    }

    console.log("[PROFILE] Saving updated profile to DB for user", user._id);
    await user.save();
    console.log("[PROFILE] Profile save successful for user", user._id);

    if (user.isProfessional) {
      await populateServiceCategories(user);
    }

    console.log("[PROFILE] completeProfile responding success", {
      userId: user._id,
    });
    res.status(200).json({
      status: 'success',
      message: 'Profile completed successfully',
      data: {
        user: buildUserResponse(user)
      }
    });
  } catch (error) {
    console.error("[PROFILE] Error completing profile", {
      userId: user?._id,
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      status: 'error',
      message: 'Failed to update profile',
      error: error.message
    });
  }
});

// @desc    Update current user location used for nearby jobs and notifications
// @route   PUT /api/auth/current-location
// @access  Private
const updateCurrentLocation = asyncHandler(async (req, res) => {
  const { fullAddress, location, latitude, longitude } = req.body;
  const user = req.user;
  const address = fullAddress || location;

  if (!address || latitude === undefined || longitude === undefined) {
    return res.status(400).json({
      status: 'error',
      message: 'Full address, latitude, and longitude are required'
    });
  }

  const updated = applyCurrentLocation(user, {
    fullAddress: address,
    latitude,
    longitude
  });

  if (!updated) {
    return res.status(400).json({
      status: 'error',
      message: 'Latitude and longitude must be valid numbers'
    });
  }

  await user.save();

  res.status(200).json({
    status: 'success',
    message: 'Current location updated successfully',
    data: {
      user: buildUserResponse(user)
    }
  });
});

// @desc    Get current user
// @route   GET /api/auth/me
// @access  Private
const getMe = asyncHandler(async (req, res) => {
  const user = req.user;

  if (user.isProfessional) {
    await populateServiceCategories(user);
  }

  res.status(200).json({
    status: 'success',
    data: {
      user: buildUserResponse(user)
    }
  });
});

// @desc    Get current verification status
// @route   GET /api/auth/verification-status
// @access  Private
const getVerificationStatus = asyncHandler(async (req, res) => {
  const user = req.user;

  res.status(200).json({
    status: 'success',
    message: 'Verification status fetched successfully',
    data: {
      isVerified: user.isVerified,
      verification: user.verification
    }
  });
});

// @desc    Submit verification documents
// @route   PUT /api/auth/verification-documents
// @access  Private
const submitVerificationDocuments = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);

  if (!user) {
    return res.status(404).json({
      status: 'error',
      message: 'User not found'
    });
  }

  const selfieImage = req.processedVerificationFiles?.selfie;
  const idPhotoImage = req.processedVerificationFiles?.photoId;

  if (!selfieImage || !idPhotoImage) {
    return res.status(400).json({
      status: 'error',
      message: 'Both selfie and photo ID are required'
    });
  }

  if (!user.verification) {
    user.verification = {};
  }

  user.verification.selfieImage = `verification/selfies/${selfieImage}`;
  user.verification.idPhotoImage = `verification/id-documents/${idPhotoImage}`;
  user.verification.status = 'under_review';
  user.verification.submittedAt = new Date();
  user.verification.reviewedAt = null;
  user.verification.reviewNotes = '';
  user.isVerified = false;

  await user.save();

  res.status(200).json({
    status: 'success',
    message: 'Verification documents submitted successfully and are now under review',
    data: {
      isVerified: user.isVerified,
      verification: user.verification,
      user: buildUserResponse(user)
    }
  });
});

// @desc    Get verification requests for admin
// @route   GET /api/auth/verification-requests
// @access  Private/Admin
const getVerificationRequests = asyncHandler(async (req, res) => {
  const { status = 'under_review', page = 1, limit = 20 } = req.query;
  const pageNumber = Math.max(parseInt(page, 10) || 1, 1);
  const limitNumber = Math.max(parseInt(limit, 10) || 20, 1);

  const query = {};
  if (status && status !== 'all') {
    query['verification.status'] = status;
  }

  const [users, total] = await Promise.all([
    User.find(query)
      .select('phoneNumber profile.fullName isVerified verification createdAt')
      .sort({ 'verification.submittedAt': -1, createdAt: -1 })
      .skip((pageNumber - 1) * limitNumber)
      .limit(limitNumber),
    User.countDocuments(query)
  ]);

  res.status(200).json({
    status: 'success',
    message: 'Verification requests fetched successfully',
    data: {
      requests: users.map((user) => ({
        id: user._id,
        phoneNumber: user.phoneNumber,
        fullName: user.profile?.fullName || '',
        isVerified: user.isVerified,
        verification: user.verification,
        createdAt: user.createdAt
      })),
      pagination: {
        currentPage: pageNumber,
        limit: limitNumber,
        total,
        totalPages: Math.ceil(total / limitNumber)
      }
    }
  });
});

// @desc    Review verification request
// @route   PUT /api/auth/verification-requests/:userId/review
// @access  Private/Admin
const reviewVerificationRequest = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { status, reviewNotes = '' } = req.body;

  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({
      status: 'error',
      message: "Status must be either 'approved' or 'rejected'"
    });
  }

  const user = await User.findById(userId);

  if (!user) {
    return res.status(404).json({
      status: 'error',
      message: 'User not found'
    });
  }

  if (!user.verification?.selfieImage || !user.verification?.idPhotoImage) {
    return res.status(400).json({
      status: 'error',
      message: 'Verification documents have not been submitted for this user'
    });
  }

  user.verification.status = status;
  user.verification.reviewedAt = new Date();
  user.verification.reviewNotes = reviewNotes;
  user.isVerified = status === 'approved';

  await user.save();

  const verificationNotif = await Notification.create({
    recipient: user._id,
    type: 'verification_review',
    title: status === 'approved' ? 'Verification approved' : 'Verification rejected',
    message:
      status === 'approved'
        ? 'Your verification has been approved. You can now access verified features.'
        : `Your verification was rejected.${reviewNotes ? ` Reason: ${reviewNotes}` : ' Please review and submit again.'}`,
    relatedEntityType: 'User',
    relatedEntityId: user._id,
    navigationIdentifier: 'verification:details'
  });
  sendPushToUserForNotification(user._id, verificationNotif, Device).catch((e) =>
    console.warn('[FCM] verification_review push failed', e && e.message)
  );

  res.status(200).json({
    status: 'success',
    message: `Verification request ${status} successfully`,
    data: {
      isVerified: user.isVerified,
      verification: user.verification,
      user: buildUserResponse(user)
    }
  });
});

// @desc    Change user PIN (only requires new PIN)
// @route   PUT /api/auth/change-pin
// @access  Private
const changePin = asyncHandler(async (req, res) => {
  const { newPin } = req.body;

  // Validate required field
  if (!newPin) {
    return res.status(400).json({
      status: 'error',
      message: 'New PIN is required'
    });
  }

  // Validate new PIN format
  if (!/^\d{4}$/.test(newPin)) {
    return res.status(400).json({
      status: 'error',
      message: 'New PIN must be exactly 4 digits'
    });
  }

  try {
    // Fetch user (ensure we have access to PIN for comparison)
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    // Prevent setting the same PIN again
    const isSamePin = await user.comparePin(newPin);
    if (isSamePin) {
      return res.status(400).json({
        status: 'error',
        message: 'New PIN must be different from the current PIN'
      });
    }

    // Update to new PIN
    user.pin = newPin;
    await user.save();

    res.status(200).json({
      status: 'success',
      message: 'PIN changed successfully'
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to change PIN',
      error: error.message
    });
  }
});

// @desc    Send OTP for forgot password
// @route   POST /api/auth/forgot-password/send-otp
// @access  Public
const sendForgotPasswordOtp = asyncHandler(async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({
      status: 'error',
      message: 'Phone number is required'
    });
  }

  // Check if phone number exists in our system
  const user = await User.findOne({ phoneNumber });
  if (!user) {
    return res.status(404).json({
      status: 'error',
      message: 'Phone number not found'
    });
  }

  try {
    const result = await TwilioService.sendVerificationCode(phoneNumber);

    res.status(200).json({
      status: 'success',
      message: 'Verification code sent successfully',
      data: {
        phoneNumber,
        twilioSid: result.twilioSid
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// @desc    Verify OTP for forgot password
// @route   POST /api/auth/forgot-password/verify-otp
// @access  Public
const verifyForgotPasswordOtp = asyncHandler(async (req, res) => {
  const { phoneNumber, verificationCode } = req.body;

  if (!phoneNumber || !verificationCode) {
    return res.status(400).json({
      status: 'error',
      message: 'Phone number and verification code are required'
    });
  }

  try {
    const result = await TwilioService.verifyCode(phoneNumber, verificationCode);

    // Find user to get ID
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    // Generate a temporary reset token (expires in 10 minutes)
    const resetToken = jwt.sign(
      { id: user._id, type: 'reset' },
      process.env.JWT_SECRET,
      { expiresIn: '10m' }
    );

    res.status(200).json({
      status: 'success',
      message: 'OTP verified successfully',
      data: {
        resetToken // User must send this token to reset-pin endpoint
      }
    });
  } catch (error) {
    res.status(400).json({
      status: 'error',
      message: error.message
    });
  }
});

// @desc    Reset PIN using reset token
// @route   POST /api/auth/forgot-password/reset-pin
// @access  Private (Restricted to Reset Token)
const resetPin = asyncHandler(async (req, res) => {
  const { newPin } = req.body;
  // Get token from header
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({
      status: 'error',
      message: 'Not authorized, no token'
    });
  }

  if (!newPin) {
    return res.status(400).json({
      status: 'error',
      message: 'New PIN is required'
    });
  }

  // Validate new PIN format
  if (!/^\d{4}$/.test(newPin)) {
    return res.status(400).json({
      status: 'error',
      message: 'New PIN must be exactly 4 digits'
    });
  }

  try {
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check if it is a reset token
    if (decoded.type !== 'reset') {
      return res.status(401).json({
        status: 'error',
        message: 'Invalid token type. Please use the token from OTP verification.'
      });
    }

    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    // Update PIN
    user.pin = newPin;
    await user.save();

    res.status(200).json({
      status: 'success',
      message: 'PIN reset successfully. Please login with your new PIN.'
    });
  } catch (error) {
    return res.status(401).json({
      status: 'error',
      message: 'Invalid or expired token',
      error: error.message
    });
  }
});

// @desc    Get current user's vehicle preference
// @route   GET /api/auth/vehicle-preference
// @access  Private
const getVehiclePreference = asyncHandler(async (req, res) => {
  const user = req.user;

  res.status(200).json({
    status: 'success',
    message: 'Vehicle preference fetched successfully',
    data: {
      vehiclePreference: user.vehiclePreference || {
        vehicleType: null,
        vehicleNumber: null,
        pricePerKm: null,
        isSet: false,
        updatedAt: null
      }
    }
  });
});

// @desc    Create or update user's vehicle preference (Pickup/Delivery service)
// @route   PUT /api/auth/vehicle-preference
// @access  Private
const updateVehiclePreference = asyncHandler(async (req, res) => {
  const { vehicleType, vehicleNumber, pricePerKm } = req.body;
  const user = req.user;

  console.log('[VEHICLE_PREF] updateVehiclePreference called', {
    userId: user?._id,
    vehicleType,
    vehicleNumber,
    pricePerKm
  });

  // Validate vehicleType
  const allowedTypes = ['2_wheeler', '3_wheeler', '4_wheeler'];
  if (!vehicleType || !allowedTypes.includes(vehicleType)) {
    return res.status(400).json({
      status: 'error',
      message: 'Vehicle type is required and must be one of: 2_wheeler, 3_wheeler, 4_wheeler'
    });
  }

  // Validate vehicleNumber
  if (!vehicleNumber || typeof vehicleNumber !== 'string' || !vehicleNumber.trim()) {
    return res.status(400).json({
      status: 'error',
      message: 'Vehicle number is required'
    });
  }

  const trimmedNumber = vehicleNumber.trim().toUpperCase();
  if (trimmedNumber.length < 4 || trimmedNumber.length > 20) {
    return res.status(400).json({
      status: 'error',
      message: 'Vehicle number must be between 4 and 20 characters'
    });
  }

  // Validate pricePerKm
  const numericPrice = Number(pricePerKm);
  if (
    pricePerKm === undefined ||
    pricePerKm === null ||
    pricePerKm === '' ||
    Number.isNaN(numericPrice) ||
    numericPrice < 0
  ) {
    return res.status(400).json({
      status: 'error',
      message: 'Price per km is required and must be a non-negative number'
    });
  }

  try {
    user.vehiclePreference = {
      vehicleType,
      vehicleNumber: trimmedNumber,
      pricePerKm: numericPrice,
      isSet: true,
      updatedAt: new Date()
    };

    await user.save();

    console.log('[VEHICLE_PREF] Successfully updated for user', user._id);

    res.status(200).json({
      status: 'success',
      message: 'Vehicle preference saved successfully',
      data: {
        vehiclePreference: user.vehiclePreference,
        user: buildUserResponse(user)
      }
    });
  } catch (error) {
    console.error('[VEHICLE_PREF] Error updating vehicle preference', {
      userId: user?._id,
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({
      status: 'error',
      message: 'Failed to save vehicle preference',
      error: error.message
    });
  }
});

// @desc    Delete user account and all related data
// @route   DELETE /api/auth/delete-account
// @access  Private
const deleteAccount = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const phoneNumber = req.user.phoneNumber;

  try {
    // 1. Delete all jobs posted by the user
    await Job.deleteMany({ postedBy: userId });

    // 2. Delete all locations saved by the user
    await Location.deleteMany({ user: userId });

    // 3. Delete all notifications for the user
    await Notification.deleteMany({ recipient: userId });

    // 4. Delete phone verification records
    await PhoneVerification.deleteMany({ phoneNumber });

    // 5. Delete the user account
    const user = await User.findByIdAndDelete(userId);

    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    res.status(200).json({
      status: 'success',
      message: 'Account and all related data deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to delete account',
      error: error.message
    });
  }
});

// @desc    Update professional profile (categories, work images, bio, experience)
// @route   PUT /api/auth/professional-profile
// @access  Private
const updateProfessionalProfile = asyncHandler(async (req, res) => {
  const user = req.user;
  const { serviceCategories, bio, yearsOfExperience, existingWorkImages } = req.body;

  try {
    // Parse serviceCategories (may come as JSON string from FormData)
    let parsedCategories = [];
    if (serviceCategories) {
      try {
        parsedCategories = typeof serviceCategories === 'string'
          ? JSON.parse(serviceCategories)
          : serviceCategories;
      } catch {
        parsedCategories = Array.isArray(serviceCategories) ? serviceCategories : [serviceCategories];
      }
      // Drop any falsy/malformed entries (e.g. a stale null carried over from
      // a previous unpopulated response) so we never persist literal nulls.
      parsedCategories = parsedCategories.filter((c) => {
        const id = typeof c === 'string' ? c : c?._id;
        return typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id);
      }).map((c) => (typeof c === 'string' ? c : c._id));

      if (parsedCategories.length > 5) {
        return res.status(400).json({ status: 'error', message: 'Maximum 5 service categories allowed' });
      }
    }

    // Parse existingWorkImages (images already saved, coming back from client)
    let keptImages = [];
    if (existingWorkImages) {
      try {
        keptImages = typeof existingWorkImages === 'string'
          ? JSON.parse(existingWorkImages)
          : existingWorkImages;
      } catch {
        keptImages = Array.isArray(existingWorkImages) ? existingWorkImages : [existingWorkImages];
      }
    }

    // New uploaded images
    const newImagePaths = (req.processedFileNames || []).map(f => `work-images/${f}`);

    const allWorkImages = [...keptImages, ...newImagePaths];
    if (allWorkImages.length > 10) {
      return res.status(400).json({ status: 'error', message: 'Maximum 10 work images allowed' });
    }

    // Update professionalProfile fields
    if (!user.professionalProfile) user.professionalProfile = {};
    if (parsedCategories.length > 0) user.professionalProfile.serviceCategories = parsedCategories;
    user.professionalProfile.workImages = allWorkImages;
    if (bio !== undefined) user.professionalProfile.bio = bio;
    if (yearsOfExperience !== undefined && yearsOfExperience !== '') {
      user.professionalProfile.yearsOfExperience = Number(yearsOfExperience);
    }

    // Mark as professional when they save this info
    user.isProfessional = true;

    // Auto-assign a unique Worker ID if this professional doesn't have one yet
    if (!user.workerId) {
      user.workerId = await generateUniqueWorkerId(User);
    }

    user.markModified('professionalProfile');
    await user.save();
    await populateServiceCategories(user);

    res.status(200).json({
      status: 'success',
      message: 'Professional profile updated successfully',
      data: {
        user: buildUserResponse(user)
      }
    });
  } catch (error) {
    console.error('[PROFESSIONAL_PROFILE] Error updating professional profile', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to update professional profile',
      error: error.message
    });
  }
});

module.exports = {
  sendPhoneVerification,
  resendPhoneVerification,
  verifyPhoneNumber,
  register,
  login,
  checkPhoneExists,
  completeProfile,
  updateCurrentLocation,
  getMe,
  getVerificationStatus,
  submitVerificationDocuments,
  getVerificationRequests,
  reviewVerificationRequest,
  changePin,
  sendForgotPasswordOtp,
  verifyForgotPasswordOtp,
  resetPin,
  deleteAccount,
  getVehiclePreference,
  updateVehiclePreference,
  updateProfessionalProfile
};
