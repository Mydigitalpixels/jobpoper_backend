const asyncHandler = require("express-async-handler");
const User = require("../models/User");
const Job = require("../models/Job");
const BusinessProfile = require("../models/BusinessProfile");
const Notification = require("../models/Notification");
const Device = require("../models/Device");
const { generateToken } = require("../middleware/auth");
const { sendPushToUserForNotification } = require("../services/pushNotificationService");

const buildAdminUser = (user) => ({
  id: user._id,
  phoneNumber: user.phoneNumber,
  fullName: user.profile?.fullName || "",
  email: user.profile?.email || "",
  location: user.profile?.location || "",
  isProfileComplete: !!user.profile?.isProfileComplete,
  isPhoneVerified: !!user.isPhoneVerified,
  isVerified: !!user.isVerified,
  verificationStatus: user.verification?.status || "not_submitted",
  isActive: !!user.isActive,
  role: user.role,
  createdAt: user.createdAt,
  lastLogin: user.lastLogin,
});

const buildVerificationPayload = (user) => ({
  selfieImage: user.verification?.selfieImage || null,
  idPhotoImage: user.verification?.idPhotoImage || null,
  status: user.verification?.status || "not_submitted",
  submittedAt: user.verification?.submittedAt || null,
  reviewedAt: user.verification?.reviewedAt || null,
  reviewNotes: user.verification?.reviewNotes || "",
});

const buildAdminJob = (job) => ({
  id: job._id,
  title: job.title,
  jobType: job.jobType,
  urgency: job.urgency,
  status: job.status,
  cost: job.cost,
  responsePreference: job.responsePreference,
  scheduledDate: job.scheduledDate,
  scheduledTime: job.scheduledTime,
  postedBy: {
    id: job.postedBy?._id || null,
    phoneNumber: job.postedBy?.phoneNumber || "",
    fullName: job.postedBy?.profile?.fullName || "",
  },
  interestedCount: Array.isArray(job.interestedUsers)
    ? job.interestedUsers.length
    : 0,
  createdAt: job.createdAt,
});

const buildAdminJobDetail = (job) => ({
  ...buildAdminJob(job),
  description: job.description,
  isActive: !!job.isActive,
  attachments: Array.isArray(job.attachments) ? job.attachments : [],
  location: job.location || null,
  interestedUsers: Array.isArray(job.interestedUsers)
    ? job.interestedUsers.map((entry) => ({
        id: entry.user?._id || null,
        phoneNumber: entry.user?.phoneNumber || "",
        fullName: entry.user?.profile?.fullName || "",
        notedAt: entry.notedAt || null,
      }))
    : [],
  updatedAt: job.updatedAt,
});

const buildAdminBusinessProfile = (profile) => ({
  id: profile._id,
  businessName: profile.businessName,
  category:
    profile.category && typeof profile.category === "object"
      ? {
          id: profile.category._id,
          name: profile.category.name || "",
          slug: profile.category.slug || "",
        }
      : profile.category || null,
  address: profile.address,
  phoneNumber: profile.phoneNumber,
  status: profile.status,
  rejectionReason: profile.rejectionReason || null,
  submittedAt: profile.createdAt,
  createdAt: profile.createdAt,
  updatedAt: profile.updatedAt,
  user: {
    id: profile.user?._id || null,
    phoneNumber: profile.user?.phoneNumber || "",
    fullName: profile.user?.profile?.fullName || "",
  },
  images: Array.isArray(profile.images)
    ? profile.images.map((image) => ({
        id: image._id,
        url: image.url,
        isPrimary: !!image.isPrimary,
        uploadedAt: image.uploadedAt || image.createdAt || null,
      }))
    : [],
});

// @desc    Get admin dashboard summary
// @route   GET /api/admin/dashboard
// @access  Private/Admin
const getDashboardSummary = asyncHandler(async (req, res) => {
  const [
    totalUsers,
    totalJobs,
    activeJobs,
    verifiedUsers,
    pendingVerificationRequests,
    pendingBusinessApprovalRequests,
    recentUsers,
    recentJobs,
  ] = await Promise.all([
    User.countDocuments(),
    Job.countDocuments(),
    Job.countDocuments({ isActive: true, status: "open" }),
    User.countDocuments({ isVerified: true }),
    User.countDocuments({ "verification.status": "under_review" }),
    BusinessProfile.countDocuments({ status: "pending" }),
    User.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select(
        "phoneNumber profile.fullName profile.email isVerified verification.status createdAt",
      ),
    Job.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("postedBy", "phoneNumber profile.fullName")
      .select(
        "title urgency status jobType cost responsePreference scheduledDate scheduledTime postedBy interestedUsers createdAt",
      ),
  ]);

  res.status(200).json({
    status: "success",
    data: {
      stats: {
        totalUsers,
        totalJobs,
        activeJobs,
        verifiedUsers,
        pendingVerificationRequests,
        pendingBusinessApprovalRequests,
      },
      recentUsers: recentUsers.map(buildAdminUser),
      recentJobs: recentJobs.map(buildAdminJob),
    },
  });
});

// @desc    Check whether admin bootstrap is available
// @route   GET /api/admin/setup-status
// @access  Public
const getAdminSetupStatus = asyncHandler(async (req, res) => {
  const adminCount = await User.countDocuments({ role: "admin" });

  res.status(200).json({
    status: "success",
    data: {
      bootstrapAvailable: adminCount === 0,
      adminCount,
    },
  });
});

// @desc    Create the first admin account
// @route   POST /api/admin/bootstrap
// @access  Public
const bootstrapAdmin = asyncHandler(async (req, res) => {
  const { phoneNumber, pin, fullName = "", email = "" } = req.body;

  if (!phoneNumber || !pin) {
    return res.status(400).json({
      status: "error",
      message: "Phone number and PIN are required",
    });
  }

  if (!/^\d{4}$/.test(pin)) {
    return res.status(400).json({
      status: "error",
      message: "PIN must be exactly 4 digits",
    });
  }

  const existingAdmin = await User.findOne({ role: "admin" }).select("_id");
  if (existingAdmin) {
    return res.status(403).json({
      status: "error",
      message: "Admin bootstrap is no longer available",
    });
  }

  const existingUser = await User.findOne({ phoneNumber }).select("_id");
  if (existingUser) {
    return res.status(400).json({
      status: "error",
      message: "A user already exists with this phone number",
    });
  }

  const admin = await User.create({
    phoneNumber,
    pin,
    role: "admin",
    isPhoneVerified: true,
    isVerified: true,
    profile: {
      fullName,
      email,
      isProfileComplete: !!(fullName && email),
    },
    verification: {
      status: "approved",
      submittedAt: new Date(),
      reviewedAt: new Date(),
      reviewNotes: "Bootstrap admin account approved automatically",
    },
  });

  const token = generateToken(admin._id);

  res.status(201).json({
    status: "success",
    message: "Admin account created successfully",
    data: {
      token,
      user: {
        ...buildAdminUser(admin),
        profile: admin.profile,
        verification: buildVerificationPayload(admin),
      },
    },
  });
});

// @desc    Get admin users list
// @route   GET /api/admin/users
// @access  Private/Admin
const getAdminUsers = asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

  const users = await User.find()
    .sort({ createdAt: -1 })
    .limit(limit)
    .select("-pin");

  res.status(200).json({
    status: "success",
    data: {
      users: users.map(buildAdminUser),
    },
  });
});

// @desc    Get admin user detail
// @route   GET /api/admin/users/:userId
// @access  Private/Admin
const getAdminUserById = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.userId).select("-pin");

  if (!user) {
    return res.status(404).json({
      status: "error",
      message: "User not found",
    });
  }

  res.status(200).json({
    status: "success",
    data: {
      user: {
        ...buildAdminUser(user),
        profile: user.profile,
        verification: buildVerificationPayload(user),
      },
    },
  });
});

// @desc    Get admin jobs list
// @route   GET /api/admin/jobs
// @access  Private/Admin
const getAdminJobs = asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

  const jobs = await Job.find()
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate("postedBy", "phoneNumber profile.fullName")
    .select(
      "title urgency status jobType cost responsePreference scheduledDate scheduledTime postedBy interestedUsers createdAt",
    );

  res.status(200).json({
    status: "success",
    data: {
      jobs: jobs.map(buildAdminJob),
    },
  });
});

// @desc    Get admin job detail
// @route   GET /api/admin/jobs/:jobId
// @access  Private/Admin
const getAdminJobById = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.jobId)
    .populate("postedBy", "phoneNumber profile.fullName")
    .populate("interestedUsers.user", "phoneNumber profile.fullName");

  if (!job) {
    return res.status(404).json({
      status: "error",
      message: "Job not found",
    });
  }

  res.status(200).json({
    status: "success",
    data: {
      job: buildAdminJobDetail(job),
    },
  });
});

// @desc    Get verification requests
// @route   GET /api/admin/verifications
// @access  Private/Admin
const getVerificationRequests = asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

  const users = await User.find({
    "verification.status": { $in: ["under_review", "approved", "rejected"] },
  })
    .sort({ "verification.submittedAt": -1, createdAt: -1 })
    .limit(limit)
    .select("-pin");

  res.status(200).json({
    status: "success",
    data: {
      requests: users.map((user) => ({
        ...buildAdminUser(user),
        verification: buildVerificationPayload(user),
      })),
    },
  });
});

// @desc    Get pending business profile approval requests
// @route   GET /api/admin/business-profiles/pending
// @access  Private/Admin
const getPendingBusinessProfileRequests = asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);

  const profiles = await BusinessProfile.find({ status: "pending" })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate("user", "phoneNumber profile.fullName")
    .populate("category", "name slug")
    .populate("images")
    .select("businessName category address phoneNumber status rejectionReason user images createdAt updatedAt");

  res.status(200).json({
    status: "success",
    data: {
      requests: profiles.map(buildAdminBusinessProfile),
      total: profiles.length,
    },
  });
});

// @desc    Review a business profile approval request
// @route   PUT /api/admin/business-profiles/:profileId/review
// @access  Private/Admin
const reviewBusinessProfileRequest = asyncHandler(async (req, res) => {
  const { profileId } = req.params;
  const { status, rejectionReason = "" } = req.body;

  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({
      status: "error",
      message: "Status must be either 'approved' or 'rejected'",
    });
  }

  const trimmedReason = String(rejectionReason || "").trim();
  if (status === "rejected" && !trimmedReason) {
    return res.status(400).json({
      status: "error",
      message: "Rejection reason is required",
    });
  }

  const profile = await BusinessProfile.findById(profileId);
  if (!profile) {
    return res.status(404).json({
      status: "error",
      message: "Business profile not found",
    });
  }

  profile.status = status;
  profile.rejectionReason = status === "rejected" ? trimmedReason : null;
  await profile.save();

  try {
    await Notification.create({
      recipient: profile.user,
      type: "business_profile_review",
      title:
        status === "approved"
          ? "Business profile approved"
          : "Business profile rejected",
      message:
        status === "approved"
          ? `Your business profile ${profile.businessName} has been approved`
          : `Your business profile ${profile.businessName} has been rejected because: ${trimmedReason}`,
      relatedEntityType: "BusinessProfile",
      relatedEntityId: profile._id,
      navigationIdentifier: `business-profile:${profile._id}`,
      isRead: false,
    });
  } catch (notificationErr) {
    console.error(
      "[BusinessProfile] failed to create review notification:",
      notificationErr.message,
    );
  }

  const populated = await BusinessProfile.findById(profile._id)
    .populate("user", "phoneNumber profile.fullName")
    .populate("category", "name slug")
    .populate("images");

  res.status(200).json({
    status: "success",
    message:
      status === "approved"
        ? "Business profile approved successfully"
        : "Business profile rejected successfully",
    data: {
      profile: buildAdminBusinessProfile(populated),
    },
  });
});

// @desc    Review verification request
// @route   PUT /api/admin/verifications/:userId/review
// @access  Private/Admin
const reviewVerificationRequest = asyncHandler(async (req, res) => {
  const { status, reviewNotes = "" } = req.body;

  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({
      status: "error",
      message: "Status must be either 'approved' or 'rejected'",
    });
  }

  const user = await User.findById(req.params.userId);

  if (!user) {
    return res.status(404).json({
      status: "error",
      message: "User not found",
    });
  }

  if (!user.verification?.selfieImage || !user.verification?.idPhotoImage) {
    return res.status(400).json({
      status: "error",
      message: "Verification documents have not been submitted for this user",
    });
  }

  user.verification.status = status;
  user.verification.reviewedAt = new Date();
  user.verification.reviewNotes = reviewNotes;
  user.isVerified = status === "approved";

  await user.save();

  const verificationNotif = await Notification.create({
    recipient: user._id,
    type: "verification_review",
    title:
      status === "approved" ? "Verification approved" : "Verification rejected",
    message:
      status === "approved"
        ? "Your verification has been approved. You can now access verified features."
        : `Your verification was rejected.${reviewNotes ? ` Reason: ${reviewNotes}` : " Please review and submit again."}`,
    relatedEntityType: "User",
    relatedEntityId: user._id,
    navigationIdentifier: "verification:details",
  });
  sendPushToUserForNotification(user._id, verificationNotif, Device).catch((e) =>
    console.warn("[FCM] verification_review push failed", e && e.message),
  );

  res.status(200).json({
    status: "success",
    message: `Verification request ${status} successfully`,
    data: {
      user: {
        ...buildAdminUser(user),
        profile: user.profile,
        verification: buildVerificationPayload(user),
      },
    },
  });
});

module.exports = {
  getAdminSetupStatus,
  bootstrapAdmin,
  getDashboardSummary,
  getAdminUsers,
  getAdminUserById,
  getAdminJobs,
  getAdminJobById,
  getPendingBusinessProfileRequests,
  reviewBusinessProfileRequest,
  getVerificationRequests,
  reviewVerificationRequest,
};
