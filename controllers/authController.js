const asyncHandler = require('express-async-handler');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Job = require('../models/Job');
const Location = require('../models/Location');
const Notification = require('../models/Notification');
const PhoneVerification = require('../models/PhoneVerification');
const TwilioService = require('../services/twilioService');
const { generateToken } = require('../middleware/auth');

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
      isPhoneVerified: true
    });

    // Generate JWT token
    const token = generateToken(user._id);

    res.status(201).json({
      status: 'success',
      message: 'User registered successfully',
      data: {
        token,
        user: {
          id: user._id,
          phoneNumber: user.phoneNumber,
          isPhoneVerified: user.isPhoneVerified,
          isProfileComplete: user.profile.isProfileComplete,
          role: user.role
        }
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
      user: {
        id: user._id,
        phoneNumber: user.phoneNumber,
        isPhoneVerified: user.isPhoneVerified,
        isProfileComplete: user.profile.isProfileComplete,
        role: user.role
      }
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
  const { fullName, email, location, dateOfBirth } = req.body;
  const user = req.user;

  console.log("[PROFILE] completeProfile called", {
    userId: user?._id,
    phoneNumber: user?.phoneNumber,
    hasFullName: !!fullName,
    hasEmail: !!email,
    hasLocation: !!location,
    hasDob: !!dateOfBirth,
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
      hasDob: !!dateOfBirth,
      hasProfileImage: !!req.processedFileName,
    });
    user.profile.fullName = fullName;
    user.profile.email = email;
    user.profile.location = location || user.profile.location;
    user.profile.dateOfBirth = dateOfBirth || user.profile.dateOfBirth;
    // If a file was uploaded and processed, use that; otherwise keep existing value
    if (req.processedFileName) {
      user.profile.profileImage = `profiles/${req.processedFileName}`;
    }
    user.profile.isProfileComplete = true;

    console.log("[PROFILE] Saving updated profile to DB for user", user._id);
    await user.save();
    console.log("[PROFILE] Profile save successful for user", user._id);

    console.log("[PROFILE] completeProfile responding success", {
      userId: user._id,
    });
    res.status(200).json({
      status: 'success',
      message: 'Profile completed successfully',
      data: {
        user: {
          id: user._id,
          phoneNumber: user.phoneNumber,
          profile: user.profile,
          isProfileComplete: user.profile.isProfileComplete,
          role: user.role
        }
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

// @desc    Get current user
// @route   GET /api/auth/me
// @access  Private
const getMe = asyncHandler(async (req, res) => {
  const user = req.user;

  res.status(200).json({
    status: 'success',
    data: {
      user: {
        id: user._id,
        phoneNumber: user.phoneNumber,
        isPhoneVerified: user.isPhoneVerified,
        profile: user.profile,
        role: user.role,
        lastLogin: user.lastLogin
      }
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

module.exports = {
  sendPhoneVerification,
  resendPhoneVerification,
  verifyPhoneNumber,
  register,
  login,
  checkPhoneExists,
  completeProfile,
  getMe,
  changePin,
  sendForgotPasswordOtp,
  verifyForgotPasswordOtp,
  resetPin,
  deleteAccount
};
