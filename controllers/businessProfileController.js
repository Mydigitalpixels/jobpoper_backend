const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const BusinessProfile = require('../models/BusinessProfile');
const BusinessImage = require('../models/BusinessImage');

const MAX_PROFILES_PER_USER = 3;
const MAX_IMAGES = 5;

const buildImageUrl = (filename) => `/uploads/business-profiles/${filename}`;
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseCoordinate = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
};

const validateCoordinatePair = (latitude, longitude) => {
  const parsedLatitude = parseCoordinate(latitude);
  const parsedLongitude = parseCoordinate(longitude);
  const hasLatitude = parsedLatitude !== null;
  const hasLongitude = parsedLongitude !== null;

  if (Number.isNaN(parsedLatitude) || (hasLatitude && (parsedLatitude < -90 || parsedLatitude > 90))) {
    return { error: 'Latitude must be a valid number between -90 and 90' };
  }

  if (Number.isNaN(parsedLongitude) || (hasLongitude && (parsedLongitude < -180 || parsedLongitude > 180))) {
    return { error: 'Longitude must be a valid number between -180 and 180' };
  }

  if (hasLatitude !== hasLongitude) {
    return { error: 'Latitude and longitude must be provided together' };
  }

  return { latitude: parsedLatitude, longitude: parsedLongitude, hasCoordinates: hasLatitude && hasLongitude };
};

const getBusinessDistancePipeline = (userLat, userLng) => [
  {
    $addFields: {
      distance: {
        $let: {
          vars: {
            dLat: { $degreesToRadians: { $subtract: ['$latitude', userLat] } },
            dLng: { $degreesToRadians: { $subtract: ['$longitude', userLng] } },
            lat1: { $degreesToRadians: userLat },
            lat2: { $degreesToRadians: '$latitude' },
            radius: 6371,
          },
          in: {
            $multiply: [
              '$$radius',
              2,
              {
                $asin: {
                  $sqrt: {
                    $add: [
                      { $pow: [{ $sin: { $divide: ['$$dLat', 2] } }, 2] },
                      {
                        $multiply: [
                          { $cos: '$$lat1' },
                          { $cos: '$$lat2' },
                          { $pow: [{ $sin: { $divide: ['$$dLng', 2] } }, 2] },
                        ],
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
    },
  },
];

const deleteBusinessImageFiles = async (images = []) => {
  await Promise.all(
    images.map(async (image) => {
      try {
        const fileName = path.basename(image.url || '');
        if (!fileName) return;
        const filePath = path.join(
          __dirname,
          '..',
          'uploads',
          'business-profiles',
          fileName
        );
        await fs.promises.unlink(filePath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.warn('[BusinessProfile] failed to delete image file:', err.message);
        }
      }
    })
  );
};

// @desc    Create a new business profile (status starts as "pending")
// @route   POST /api/business-profiles
// @access  Private
const createBusinessProfile = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  if (!req.user.isVerified) {
    return res.status(403).json({
      status: 'error',
      code: 'USER_NOT_VERIFIED',
      message: 'Only verified users can create business profiles',
    });
  }

  // Hard guard: max 3 profiles per user. The Mongoose pre-save hook also
  // catches this, but checking here gives a clean 409 response without
  // wasting the uploaded files.
  const existingCount = await BusinessProfile.countDocuments({ user: userId });
  if (existingCount >= MAX_PROFILES_PER_USER) {
    return res.status(409).json({
      status: 'error',
      code: 'PROFILE_LIMIT_REACHED',
      message: `A user can have at most ${MAX_PROFILES_PER_USER} business profiles`,
    });
  }

  const {
    businessName,
    category,
    address,
    phoneNumber,
    latitude,
    longitude,
    primaryIndex,
  } = req.body;

  if (!businessName || !category || !address || !phoneNumber) {
    return res.status(400).json({
      status: 'error',
      message: 'businessName, category, address, and phoneNumber are required',
    });
  }

  const coords = validateCoordinatePair(latitude, longitude);
  if (coords.error) {
    return res.status(400).json({ status: 'error', message: coords.error });
  }

  const fileNames = req.processedFileNames || [];
  if (fileNames.length < 1) {
    return res.status(400).json({
      status: 'error',
      message: 'At least 1 image is required',
    });
  }
  if (fileNames.length > MAX_IMAGES) {
    return res.status(400).json({
      status: 'error',
      message: `Cannot upload more than ${MAX_IMAGES} images`,
    });
  }

  const primaryIdx = Math.max(
    0,
    Math.min(parseInt(primaryIndex, 10) || 0, fileNames.length - 1)
  );

  // Two-step insert with manual rollback so we don't depend on transactions
  // (transactions require a replica set, which dev / standalone setups skip).
  let profile;
  let imageDocs = [];
  try {
    // 1) Create the profile shell with a placeholder image array. We use
    //    a freshly minted ObjectId so `images` validation (>=1) passes,
    //    then replace with real refs once images are saved.
    const placeholderId = new mongoose.Types.ObjectId();
    profile = await BusinessProfile.create({
      user: userId,
      businessName: String(businessName).trim(),
      category,
      address: String(address).trim(),
      phoneNumber: String(phoneNumber).trim(),
      latitude: coords.hasCoordinates ? coords.latitude : null,
      longitude: coords.hasCoordinates ? coords.longitude : null,
      status: 'pending',
      isActive: true,
      images: [placeholderId],
    });

    // 2) Insert the real BusinessImage docs pointing back to the profile.
    imageDocs = await BusinessImage.insertMany(
      fileNames.map((name, idx) => ({
        businessProfile: profile._id,
        url: buildImageUrl(name),
        isPrimary: idx === primaryIdx,
      }))
    );

    // 3) Swap the placeholder for the actual image refs and save.
    profile.images = imageDocs.map((doc) => doc._id);
    await profile.save();
  } catch (err) {
    // Best-effort rollback so we don't leave orphans.
    try {
      if (imageDocs.length) {
        await BusinessImage.deleteMany({
          _id: { $in: imageDocs.map((d) => d._id) },
        });
      }
      if (profile?._id) {
        await BusinessProfile.deleteOne({ _id: profile._id });
      }
    } catch (rollbackErr) {
      console.error('[BusinessProfile] rollback failed:', rollbackErr.message);
    }

    if (err?.message?.includes('at most 3 business profiles')) {
      return res.status(409).json({
        status: 'error',
        code: 'PROFILE_LIMIT_REACHED',
        message: err.message,
      });
    }
    throw err;
  }

  const populated = await BusinessProfile.findById(profile._id)
    .populate('category', 'name slug')
    .populate('images');

  return res.status(201).json({
    status: 'success',
    message: 'Business profile created and submitted for review',
    data: { profile: populated },
  });
});

// @desc    Public, paginated list of approved business profiles near the selected location
// @route   GET /api/business-profiles?page=1&limit=10&latitude=<lat>&longitude=<lng>&search=shop&category=<id>
// @access  Private (any authenticated user)
//
// Powers the user-facing "Business" tab. Only returns approved, active
// profiles within 25km of the caller's selected location. Default page size
// is 10 to match the tab's UI; the cap is 50 so misbehaving clients can't
// pull the whole table at once.
const listApprovedBusinessProfiles = asyncHandler(async (req, res) => {
  const DEFAULT_LIMIT = 10;
  const MAX_LIMIT = 50;
  const RADIUS_KM = 25;

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limitRaw = parseInt(req.query.limit, 10) || DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(limitRaw, MAX_LIMIT));
  const skip = (page - 1) * limit;

  const search = String(req.query.search || '').trim();
  const category = String(req.query.category || '').trim();
  const coords = validateCoordinatePair(req.query.latitude, req.query.longitude);

  if (!coords.hasCoordinates) {
    return res.status(400).json({
      status: 'error',
      message: 'Coordinates (latitude, longitude) are required',
    });
  }

  if (coords.error) {
    return res.status(400).json({ status: 'error', message: coords.error });
  }

  if (category && !mongoose.isValidObjectId(category)) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid business category id',
    });
  }

  const filter = {
    status: 'approved',
    isActive: true,
    latitude: { $type: 'number' },
    longitude: { $type: 'number' },
  };
  if (search) {
    filter.businessName = { $regex: escapeRegex(search), $options: 'i' };
  }
  if (category) {
    filter.category = new mongoose.Types.ObjectId(category);
  }

  const pipeline = [
    { $match: filter },
    ...getBusinessDistancePipeline(coords.latitude, coords.longitude),
    { $match: { distance: { $lte: RADIUS_KM } } },
    { $sort: { createdAt: -1 } },
    {
      $facet: {
        profiles: [
          { $skip: skip },
          { $limit: limit },
          {
            $lookup: {
              from: 'business_categories',
              localField: 'category',
              foreignField: '_id',
              as: 'category',
            },
          },
          { $unwind: { path: '$category', preserveNullAndEmptyArrays: true } },
          {
            $lookup: {
              from: 'business_images',
              localField: 'images',
              foreignField: '_id',
              as: 'images',
            },
          },
        ],
        totalCount: [{ $count: 'count' }],
      },
    },
  ];

  const result = await BusinessProfile.aggregate(pipeline);
  const profiles = result[0]?.profiles ?? [];
  const total = result[0]?.totalCount?.[0]?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return res.status(200).json({
    status: 'success',
    data: {
      profiles,
      location: req.query.location || '',
      latitude: coords.latitude,
      longitude: coords.longitude,
      radiusKm: RADIUS_KM,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    },
  });
});

// @desc    Get the authenticated user's business profiles
// @route   GET /api/business-profiles/me
// @access  Private
const getMyBusinessProfiles = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const profiles = await BusinessProfile.find({ user: userId })
    .sort({ createdAt: -1 })
    .populate('category', 'name slug')
    .populate('images');

  return res.status(200).json({
    status: 'success',
    data: {
      profiles,
      total: profiles.length,
      remainingSlots: Math.max(0, MAX_PROFILES_PER_USER - profiles.length),
      maxProfiles: MAX_PROFILES_PER_USER,
    },
  });
});

// @desc    Update an existing business profile (edit + resubmit)
// @route   PUT /api/business-profiles/:id
// @access  Private
//
// The edit-and-resubmit flow:
//   - Approved or rejected profiles can be edited; pending profiles cannot
//     (they are awaiting admin review and edits would invalidate that work).
//   - Any successful edit flips status back to "pending" so the admin can
//     re-review the new content. rejectionReason is cleared by the model's
//     pre-save hook whenever status !== "rejected".
//   - Images are optional on update. If new image files are uploaded we
//     replace the entire image set (mirroring the create flow). Otherwise
//     the existing images are kept untouched.
const updateBusinessProfile = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid business profile id',
    });
  }

  const profile = await BusinessProfile.findOne({ _id: id, user: userId });
  if (!profile) {
    return res.status(404).json({
      status: 'error',
      message: 'Business profile not found',
    });
  }

  // Pending profiles are locked while admin review is in flight.
  if (profile.status === 'pending') {
    return res.status(409).json({
      status: 'error',
      code: 'PROFILE_PENDING_REVIEW',
      message: 'You cannot edit a profile that is pending review',
    });
  }

  const {
    businessName,
    category,
    address,
    phoneNumber,
    latitude,
    longitude,
    primaryIndex,
  } = req.body;

  if (businessName != null) profile.businessName = String(businessName).trim();
  if (category != null) profile.category = category;
  if (address != null) profile.address = String(address).trim();
  if (phoneNumber != null) profile.phoneNumber = String(phoneNumber).trim();
  if (latitude !== undefined || longitude !== undefined) {
    const coords = validateCoordinatePair(latitude, longitude);
    if (coords.error) {
      return res.status(400).json({ status: 'error', message: coords.error });
    }
    profile.latitude = coords.hasCoordinates ? coords.latitude : null;
    profile.longitude = coords.hasCoordinates ? coords.longitude : null;
  }

  // Replace images only if the client sent new ones on this request.
  const newFileNames = req.processedFileNames || [];
  let newImageDocs = [];
  let oldImageIds = [];

  if (newFileNames.length > 0) {
    if (newFileNames.length > MAX_IMAGES) {
      return res.status(400).json({
        status: 'error',
        message: `Cannot upload more than ${MAX_IMAGES} images`,
      });
    }

    const primaryIdx = Math.max(
      0,
      Math.min(parseInt(primaryIndex, 10) || 0, newFileNames.length - 1)
    );

    try {
      newImageDocs = await BusinessImage.insertMany(
        newFileNames.map((name, idx) => ({
          businessProfile: profile._id,
          url: buildImageUrl(name),
          isPrimary: idx === primaryIdx,
        }))
      );
      oldImageIds = [...profile.images];
      profile.images = newImageDocs.map((doc) => doc._id);
    } catch (err) {
      // Rollback any partially-inserted new images.
      try {
        if (newImageDocs.length) {
          await BusinessImage.deleteMany({
            _id: { $in: newImageDocs.map((d) => d._id) },
          });
        }
      } catch (rollbackErr) {
        console.error(
          '[BusinessProfile] update rollback failed:',
          rollbackErr.message
        );
      }
      throw err;
    }
  }

  // Edit-and-resubmit: any successful edit moves the profile back to
  // pending. The pre-save hook clears rejectionReason for us.
  profile.status = 'pending';

  await profile.save();

  // Now that the save succeeded, garbage-collect the previous image rows.
  if (oldImageIds.length) {
    try {
      await BusinessImage.deleteMany({ _id: { $in: oldImageIds } });
    } catch (cleanupErr) {
      console.warn(
        '[BusinessProfile] failed to delete replaced images:',
        cleanupErr.message
      );
    }
  }

  const populated = await BusinessProfile.findById(profile._id)
    .populate('category', 'name slug')
    .populate('images');

  return res.status(200).json({
    status: 'success',
    message: 'Business profile updated and resubmitted for review',
    data: { profile: populated },
  });
});

// @desc    Delete an approved or rejected business profile
// @route   DELETE /api/business-profiles/:id
// @access  Private
const deleteBusinessProfile = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid business profile id',
    });
  }

  const profile = await BusinessProfile.findOne({ _id: id, user: userId })
    .populate('images');

  if (!profile) {
    return res.status(404).json({
      status: 'error',
      message: 'Business profile not found',
    });
  }

  if (profile.status === 'pending') {
    return res.status(409).json({
      status: 'error',
      code: 'PROFILE_PENDING_REVIEW',
      message: 'You cannot delete a profile that is pending review',
    });
  }

  const images = Array.isArray(profile.images) ? profile.images : [];
  const imageIds = images.map((image) => image._id);

  await BusinessProfile.deleteOne({ _id: profile._id });
  if (imageIds.length) {
    await BusinessImage.deleteMany({ _id: { $in: imageIds } });
    await deleteBusinessImageFiles(images);
  }

  return res.status(200).json({
    status: 'success',
    message: 'Business profile deleted successfully',
    data: { deletedId: profile._id },
  });
});

module.exports = {
  createBusinessProfile,
  getMyBusinessProfiles,
  updateBusinessProfile,
  deleteBusinessProfile,
  listApprovedBusinessProfiles,
};
