const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const Job = require("../models/Job");
const Location = require("../models/Location");
const Notification = require("../models/Notification");
const User = require("../models/User");
const Review = require("../models/Review");
const Device = require("../models/Device");
const {
  sendPushToUserForNotification,
} = require("../services/pushNotificationService");
const { generateUniqueJobPin } = require("../utils/generateUniqueId");

/**
 * Resolve a category query param (ObjectId hex string OR slug) to a Mongo ObjectId.
 * Returns null if input is empty/falsy or if the category doesn't exist.
 */
const resolveCategoryFilter = async (rawCategory) => {
  if (!rawCategory) return null;
  const value = String(rawCategory).trim();
  if (!value) return null;

  const ServiceCategory = require("../models/ServiceCategory");
  const isObjectId = /^[a-f\d]{24}$/i.test(value);
  const doc = await ServiceCategory.findOne(
    isObjectId ? { _id: value } : { slug: value.toLowerCase() }
  ).select("_id");
  return doc ? doc._id : null;
};

const PHONE_REGEX = /^\+?[1-9]\d{1,14}$/;

/**
 * Parse and validate "post on behalf of another person" fields from request body.
 * Returns { postedOnBehalf, externalContact } or { error: string }.
 */
const parsePostedOnBehalfFields = (body) => {
  const postedOnBehalf =
    body.postedOnBehalf === true || body.postedOnBehalf === "true";

  if (!postedOnBehalf) {
    return {
      postedOnBehalf: false,
      externalContact: undefined,
    };
  }

  const name = String(body.externalContactName || "").trim();
  const rawPhone = String(body.externalContactPhone || "").trim();
  const phoneNumber = rawPhone.replace(/[\s\-()]/g, "");

  if (!name) {
    return { error: "Name is required when posting for another person" };
  }
  if (!phoneNumber) {
    return {
      error: "Phone number is required when posting for another person",
    };
  }
  if (!PHONE_REGEX.test(phoneNumber)) {
    return { error: "Please enter a valid phone number for the task seeker" };
  }

  return {
    postedOnBehalf: true,
    externalContact: { name, phoneNumber },
  };
};

/** Compute haversine distance in kilometers between two lat/lng points. */
const haversineKm = (lat1, lon1, lat2, lon2) => {
  if (
    typeof lat1 !== "number" ||
    typeof lon1 !== "number" ||
    typeof lat2 !== "number" ||
    typeof lon2 !== "number"
  ) {
    return null;
  }
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;
  return Math.round(distance * 100) / 100; // 2 decimal places
};

/** Compute distance for a Pickup job from its source/destination coordinates. */
const computePickupDistance = (locationObj) => {
  if (
    !locationObj ||
    !locationObj.source ||
    !locationObj.destination ||
    typeof locationObj.source.latitude !== "number" ||
    typeof locationObj.source.longitude !== "number" ||
    typeof locationObj.destination.latitude !== "number" ||
    typeof locationObj.destination.longitude !== "number"
  ) {
    return null;
  }
  return haversineKm(
    locationObj.source.latitude,
    locationObj.source.longitude,
    locationObj.destination.latitude,
    locationObj.destination.longitude
  );
};

/** Get job coordinates for distance calculations. OnSite: single location; Pickup: source. */
const getJobCoordinates = (job) => {
  if (!job || !job.location) return null;
  let lat, lng;
  if (job.jobType === "OnSite") {
    lat = job.location.latitude;
    lng = job.location.longitude;
  } else if (job.jobType === "Pickup" && job.location.source) {
    lat = job.location.source.latitude;
    lng = job.location.source.longitude;
  } else {
    return null;
  }
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return { lat, lng };
};

// Helper function to extract location strings from job location
const extractLocationStrings = (jobLocation, jobType) => {
  const locations = [];

  if (jobType === "OnSite" && jobLocation) {
    if (jobLocation.name) locations.push(jobLocation.name);
    if (jobLocation.fullAddress) {
      locations.push(jobLocation.fullAddress);
      // Extract city/state from fullAddress for better matching
      // e.g., "123 Main St, New York, NY 10001" -> extract "New York, NY"
      const addressParts = jobLocation.fullAddress.split(",");
      if (addressParts.length >= 2) {
        // Get city and state (usually last two parts before zip)
        const cityState = addressParts.slice(-2).join(",").trim();
        if (cityState) locations.push(cityState);
        // Also try just the city
        const city = addressParts[addressParts.length - 2]?.trim();
        if (city) locations.push(city);
      }
    }
  } else if (jobType === "Pickup" && jobLocation) {
    if (jobLocation.source) {
      if (jobLocation.source.name) locations.push(jobLocation.source.name);
      if (jobLocation.source.fullAddress) {
        locations.push(jobLocation.source.fullAddress);
        // Extract city/state from source address
        const addressParts = jobLocation.source.fullAddress.split(",");
        if (addressParts.length >= 2) {
          const cityState = addressParts.slice(-2).join(",").trim();
          if (cityState) locations.push(cityState);
          const city = addressParts[addressParts.length - 2]?.trim();
          if (city) locations.push(city);
        }
      }
    }
    if (jobLocation.destination) {
      if (jobLocation.destination.name)
        locations.push(jobLocation.destination.name);
      if (jobLocation.destination.fullAddress) {
        locations.push(jobLocation.destination.fullAddress);
        // Extract city/state from destination address
        const addressParts = jobLocation.destination.fullAddress.split(",");
        if (addressParts.length >= 2) {
          const cityState = addressParts.slice(-2).join(",").trim();
          if (cityState) locations.push(cityState);
          const city = addressParts[addressParts.length - 2]?.trim();
          if (city) locations.push(city);
        }
      }
    }
  }

  // Remove duplicates and empty strings
  return [...new Set(locations.filter((loc) => loc && loc.trim().length > 0))];
};

// Helper: create in-app notifications for users with a saved Location within 25km of the job (Haversine).
const createJobCreatedNotifications = async (job, jobCreatorId) => {
  const RADIUS_KM = 25;
  const MAX_RECIPIENTS = 500;

  try {
    const coords = getJobCoordinates(job);
    if (!coords) {
      console.log(
        "[NOTIFICATION] No job coordinates available, skipping notifications for job:",
        job._id,
      );
      return;
    }

    const jobLat = coords.lat;
    const jobLng = coords.lng;
    const creatorObjectId = new mongoose.Types.ObjectId(jobCreatorId);

    // Prefer each user's current profile location. Saved locations are only a
    // fallback for older users who have not selected a current location yet.
    const usersWithCurrentLocation = await User.find({
      _id: { $ne: creatorObjectId },
      "profile.currentLocation.latitude": { $type: "number" },
      "profile.currentLocation.longitude": { $type: "number" },
    }).select("_id");
    const usersWithCurrentLocationIds = usersWithCurrentLocation.map((u) => u._id);

    const currentLocationMatches = await User.aggregate([
      {
        $match: {
          _id: { $ne: creatorObjectId },
          isActive: true,
          "profile.currentLocation.latitude": { $type: "number" },
          "profile.currentLocation.longitude": { $type: "number" },
        },
      },
      {
        $addFields: {
          distance: {
            $let: {
              vars: {
                dLat: {
                  $degreesToRadians: {
                    $subtract: ["$profile.currentLocation.latitude", jobLat],
                  },
                },
                dLng: {
                  $degreesToRadians: {
                    $subtract: ["$profile.currentLocation.longitude", jobLng],
                  },
                },
                lat1: { $degreesToRadians: jobLat },
                lat2: { $degreesToRadians: "$profile.currentLocation.latitude" },
                radius: 6371,
              },
              in: {
                $multiply: [
                  "$$radius",
                  2,
                  {
                    $asin: {
                      $sqrt: {
                        $add: [
                          {
                            $pow: [
                              { $sin: { $divide: ["$$dLat", 2] } },
                              2,
                            ],
                          },
                          {
                            $multiply: [
                              { $cos: "$$lat1" },
                              { $cos: "$$lat2" },
                              {
                                $pow: [
                                  { $sin: { $divide: ["$$dLng", 2] } },
                                  2,
                                ],
                              },
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
      { $match: { distance: { $lte: RADIUS_KM } } },
      { $project: { _id: 1 } },
      { $limit: MAX_RECIPIENTS },
    ]);

    const remainingRecipientSlots = Math.max(
      MAX_RECIPIENTS - currentLocationMatches.length,
      0,
    );
    let savedLocationMatches = [];
    if (remainingRecipientSlots > 0) {
      // Haversine in aggregation: distance from each saved Location's lat/lng to (jobLat, jobLng)
      savedLocationMatches = await Location.aggregate([
        {
          $match: {
            user: {
              $ne: creatorObjectId,
              $nin: usersWithCurrentLocationIds,
            },
          },
        },
        {
          $addFields: {
            distance: {
              $let: {
                vars: {
                  dLat: {
                    $degreesToRadians: { $subtract: ["$latitude", jobLat] },
                  },
                  dLng: {
                    $degreesToRadians: { $subtract: ["$longitude", jobLng] },
                  },
                  lat1: { $degreesToRadians: jobLat },
                  lat2: { $degreesToRadians: "$latitude" },
                  radius: 6371,
                },
                in: {
                  $multiply: [
                    "$$radius",
                    2,
                    {
                      $asin: {
                        $sqrt: {
                          $add: [
                            {
                              $pow: [
                                { $sin: { $divide: ["$$dLat", 2] } },
                                2,
                              ],
                            },
                            {
                              $multiply: [
                                { $cos: "$$lat1" },
                                { $cos: "$$lat2" },
                                {
                                  $pow: [
                                    { $sin: { $divide: ["$$dLng", 2] } },
                                    2,
                                  ],
                                },
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
        { $match: { distance: { $lte: RADIUS_KM } } },
        { $group: { _id: "$user" } },
        { $limit: remainingRecipientSlots },
      ]);
    }

    const userIds = [
      ...currentLocationMatches.map((doc) => doc._id),
      ...savedLocationMatches.map((doc) => doc._id),
    ];
    if (userIds.length === 0) {
      console.log(
        "[NOTIFICATION] No nearby users (within",
        RADIUS_KM,
        "km), skipping for job:",
        job._id,
      );
      return;
    }

    // Only notify active users
    const activeUsers = await User.find({
      _id: { $in: userIds },
      isActive: true,
    }).select("_id");
    const activeIds = new Set(activeUsers.map((u) => u._id.toString()));

    const categoryName =
      (job.category && typeof job.category === "object" && job.category.name) ||
      null;
    const notificationMessage = categoryName
      ? `You have a new task in ${categoryName}`
      : "You have a new task nearby";

    const notifications = userIds
      .filter((id) => activeIds.has(id.toString()))
      .map((userId) => ({
        recipient: userId,
        type: "job_created",
        title: "New task near you",
        message: notificationMessage,
        relatedEntityType: "Job",
        relatedEntityId: job._id,
        navigationIdentifier: `job:${job._id}`,
        isRead: false,
      }));

    if (notifications.length === 0) return;

    const result = await Notification.insertMany(notifications);
    console.log(
      "[NOTIFICATION] Created",
      result.length,
      "job_created notifications for job:",
      job._id,
    );
    for (const doc of result) {
      sendPushToUserForNotification(doc.recipient, doc, Device).catch((e) =>
        console.warn("[FCM] job_created push failed", e && e.message),
      );
    }
  } catch (error) {
    console.error("[NOTIFICATION] Error creating job notifications:", error);
    console.error("[NOTIFICATION] Error stack:", error.stack);
  }
};

// @desc    Show interest in a job
// @route   POST /api/jobs/:id/interest
// @access  Private
const showInterestInJob = asyncHandler(async (req, res) => {
  const { id } = req.params;

  try {
    const job = await Job.findById(id);

    if (!job || !job.isActive || job.status !== "open") {
      return res.status(404).json({
        status: "error",
        message: "Task not found or not open",
      });
    }

    // Only allow interest when the poster requested show_interest
    if (job.responsePreference !== "show_interest") {
      return res.status(400).json({
        status: "error",
        message: "This task does not accept interest submissions",
      });
    }

    const alreadyInterested = (job.interestedUsers || []).some(
      (entry) => entry.user.toString() === req.user._id.toString(),
    );

    if (alreadyInterested) {
      return res.status(200).json({
        status: "success",
        message: "Interest already recorded",
      });
    }

    job.interestedUsers = job.interestedUsers || [];
    job.interestedUsers.push({ user: req.user._id, notedAt: new Date() });
    await job.save();

    // Create notification for job owner
    try {
      // Get interested user info
      const interestedUser = await User.findById(req.user._id).select(
        "profile.fullName",
      );
      const interestedUserName = interestedUser?.profile?.fullName || "Someone";

      // Create notification for job owner about this interest
      // Note: We don't check for duplicates here because the function already prevents
      // duplicate interests, so this will only be called for new interests
      const interestNotif = await Notification.create({
        recipient: job.postedBy,
        type: "job_interest",
        title: "New Interest in Your Task",
        message: `${interestedUserName} showed interest in your task: ${job.title}`,
        relatedEntityType: "Job",
        relatedEntityId: job._id,
        navigationIdentifier: `job:${job._id}`,
        isRead: false,
      });
      sendPushToUserForNotification(interestNotif.recipient, interestNotif, Device).catch(
        (e) => console.warn("[FCM] job_interest push failed", e && e.message),
      );
    } catch (error) {
      // Log error but don't fail the interest recording
      console.error("Error creating interest notification:", error);
    }

    res.status(201).json({
      status: "success",
      message: "Interest recorded successfully",
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Failed to record interest",
      error: error.message,
    });
  }
});

// @desc    Get jobs current user showed interest in
// @route   GET /api/jobs/my-interests
// @access  Private
const getMyInterestedJobs = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;
  const sortBy = req.query.sortBy || "scheduledDate";
  const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;

  const sort = {};
  sort[sortBy] = sortOrder;

  try {
    // A job should stay visible here past the "open" stage once this user is
    // the assigned worker - otherwise it disappears the moment the customer
    // taps "Verify & Start Job", and the worker never sees the "Enter Job
    // PIN to Complete" button. Jobs they merely expressed interest in (but
    // weren't assigned) only show while still open.
    const filter = {
      isActive: true,
      scheduledDate: { $exists: true },
      $or: [
        { status: "open", "interestedUsers.user": req.user._id },
        { assignedWorker: req.user._id },
      ],
    };

    const jobs = await Job.find(filter)
      .populate("postedBy", "phoneNumber profile.fullName profile.email")
      .populate("category", "_id name slug icon")
      .sort(sort)
      .skip(skip)
      .limit(limit);

    const total = await Job.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      status: "success",
      data: {
        jobs,
        pagination: {
          currentPage: page,
          totalPages,
          totalJobs: total,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Failed to fetch interested tasks",
      error: error.message,
    });
  }
});

// @desc    Create a new job
// @route   POST /api/jobs
// @access  Private
const createJob = asyncHandler(async (req, res) => {
  const {
    title,
    description,
    cost,
    location,
    jobType,
    urgency,
    scheduledDate,
    scheduledTime,
    responsePreference,
    distanceKm,
    category,
  } = req.body;

  // If location was sent as a JSON string (common with multipart/form-data), parse it.
  let locationObj = location;
  if (typeof location === "string") {
    try {
      locationObj = JSON.parse(location);
    } catch (err) {
      return res.status(400).json({
        status: "error",
        message:
          "Invalid location format. Send location as an object or a JSON string.",
      });
    }
  }

  // Validate required fields — collect every missing field so the client
  // can surface a specific, actionable message instead of a generic one.
  const requiredFieldLabels = {
    title: "Task title",
    cost: "Cost/budget",
    locationObj: "Location",
    jobType: "Task type",
    urgency: "Urgency",
    scheduledDate: "Scheduled date",
    scheduledTime: "Scheduled time",
    responsePreference: "Response preference",
  };
  const providedValues = {
    title,
    cost,
    locationObj,
    jobType,
    urgency,
    scheduledDate,
    scheduledTime,
    responsePreference,
  };
  const missingFields = Object.keys(requiredFieldLabels).filter(
    (key) => !providedValues[key],
  );
  if (missingFields.length) {
    const missingLabels = missingFields.map((key) => requiredFieldLabels[key]);
    return res.status(400).json({
      status: "error",
      message: `Missing required field(s): ${missingLabels.join(", ")}`,
      missingFields: missingLabels,
    });
  }

  // Validate jobType
  const validJobTypes = ["Pickup", "OnSite"];
  if (!validJobTypes.includes(jobType)) {
    return res.status(400).json({
      status: "error",
      message: "Invalid task type. Must be one of: Pickup, OnSite",
    });
  }

  // Validate urgency
  const validUrgencies = ["Urgent", "Normal"];
  if (!validUrgencies.includes(urgency)) {
    return res.status(400).json({
      status: "error",
      message: "Invalid urgency. Must be one of: Urgent, Normal",
    });
  }

  // Validate responsePreference
  const validResponsePreferences = ["direct_contact", "show_interest"];
  if (!validResponsePreferences.includes(responsePreference)) {
    return res.status(400).json({
      status: "error",
      message:
        "Invalid response preference. Must be one of: direct_contact, show_interest",
    });
  }

  // Validate scheduled date is not in the past
  const scheduledDateObj = new Date(scheduledDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (scheduledDateObj < today) {
    return res.status(400).json({
      status: "error",
      message: "Scheduled date cannot be in the past",
    });
  }

  // Build attachments from uploaded files (if any)
  const uploadedAttachments = (req.processedFileNames || []).map(
    (name) => `jobs/${name}`,
  );

  // Validate attachments limit
  if (uploadedAttachments.length > 5) {
    return res.status(400).json({
      status: "error",
      message: "Cannot have more than 5 attachments",
    });
  }
  // If the client did send files but zero could be used, log a warning for ops/debug
  if (req.files && req.files.length && uploadedAttachments.length === 0) {
    console.warn(
      "[WARN] createJob: attachments submitted but none processed. Check file types.",
    );
  }

  // Resolve distanceKm (only meaningful for Pickup jobs)
  let resolvedDistanceKm = null;
  if (jobType === "Pickup") {
    const parsedClientDistance =
      distanceKm !== undefined && distanceKm !== null && distanceKm !== ""
        ? Number(distanceKm)
        : null;

    if (
      parsedClientDistance !== null &&
      !Number.isNaN(parsedClientDistance) &&
      parsedClientDistance >= 0
    ) {
      resolvedDistanceKm = Math.round(parsedClientDistance * 100) / 100;
    } else {
      // Fallback: compute on the server from source/destination coordinates
      resolvedDistanceKm = computePickupDistance(locationObj);
    }
  }

  // Resolve service category — accepts either a Mongo ObjectId or a slug
  let categoryId = null;
  if (category) {
    const ServiceCategory = require("../models/ServiceCategory");
    const isObjectId = /^[a-f\d]{24}$/i.test(String(category));
    const categoryDoc = await ServiceCategory.findOne(
      isObjectId ? { _id: category } : { slug: String(category).toLowerCase() }
    );
    if (!categoryDoc) {
      return res.status(400).json({
        status: "error",
        message: "Selected service category does not exist",
      });
    }
    if (!categoryDoc.isActive) {
      return res.status(400).json({
        status: "error",
        message: "Selected service category is no longer available",
      });
    }
    categoryId = categoryDoc._id;
  }

  // Build voiceNote path from uploaded audio (if any)
  const voiceNotePath = req.processedAudioFileName
    ? `jobs/audio/${req.processedAudioFileName}`
    : null;

  const onBehalfFields = parsePostedOnBehalfFields(req.body);
  if (onBehalfFields.error) {
    return res.status(400).json({
      status: "error",
      message: onBehalfFields.error,
    });
  }

  try {
    // Generate a unique Job PIN for this job
    const jobPin = await generateUniqueJobPin(Job);

    const jobPayload = {
      title,
      description,
      cost,
      location: locationObj,
      jobType,
      urgency,
      scheduledDate: scheduledDateObj,
      scheduledTime,
      responsePreference,
      attachments: uploadedAttachments,
      voiceNote: voiceNotePath,
      postedBy: req.user._id,
      distanceKm: resolvedDistanceKm,
      category: categoryId,
      postedOnBehalf: onBehalfFields.postedOnBehalf,
      jobPin,
    };
    if (onBehalfFields.postedOnBehalf) {
      jobPayload.externalContact = onBehalfFields.externalContact;
    }

    const job = await Job.create(jobPayload);

    // Populate the postedBy field
    await job.populate(
      "postedBy",
      "phoneNumber profile.fullName profile.email",
    );
    // Populate category for the response so the client can display it immediately
    await job.populate("category", "_id name slug icon");

    // Create notifications for users in the same location (async, don't wait)
    createJobCreatedNotifications(job, req.user._id).catch((err) => {
      console.error("Error creating notifications for new job:", err);
    });

    res.status(201).json({
      status: "success",
      message: "Task created successfully",
      data: {
        job,
      },
    });
  } catch (error) {
    // Surface Mongoose validation errors (e.g. missing/invalid fields caught
    // at the schema level) as clear, field-specific 400 responses instead of
    // a generic 500 that hides what actually went wrong.
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((val) => val.message);
      return res.status(400).json({
        status: "error",
        message: messages.join(". "),
        errors: messages,
      });
    }
    console.error("Error creating job:", error);
    res.status(500).json({
      status: "error",
      message: "Failed to create task. Please try again.",
    });
  }
});

// @desc    Get all jobs with pagination and filtering
// @route   GET /api/jobs
// @access  Public
const getAllJobs = asyncHandler(async (req, res) => {
  const params = { ...req.query, ...req.body };
  const page = parseInt(params.page) || 1;
  const limit = parseInt(params.limit) || 10;
  const skip = (page - 1) * limit;
  const sortBy = params.sortBy || "createdAt";
  const sortOrder = params.sortOrder === "asc" ? 1 : -1;

  const { urgency, location, search, latitude, longitude } = params;

  try {
    // Build initial match conditions
    const initialMatch = {
      isActive: true,
      status: "open",
    };

    if (urgency) initialMatch.urgency = urgency;

    if (search) {
      initialMatch.$or = [
        { title: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { "location.source.fullAddress": { $regex: search, $options: "i" } },
        { "location.destination.fullAddress": { $regex: search, $options: "i" } },
      ];
    } else if (location) {
      initialMatch.$or = [
        { "location.source.fullAddress": { $regex: location, $options: "i" } },
        { "location.source.name": { $regex: location, $options: "i" } },
        { "location.destination.fullAddress": { $regex: location, $options: "i" } },
        { "location.destination.name": { $regex: location, $options: "i" } },
      ];
    }

    let pipeline = [
      {
        $match: initialMatch,
      },
    ];

    // Add distance filter if coordinates are provided
    if (latitude && longitude) {
      const userLat = parseFloat(latitude);
      const userLng = parseFloat(longitude);
      
      pipeline = [
        ...pipeline,
        ...getDistancePipeline(userLat, userLng),
        {
          $match: {
            distance: { $lte: 25 }, // 25km radius
          },
        },
      ];
    }

    // Look up user and format output
    pipeline.push(
      {
        $lookup: {
          from: "users",
          localField: "postedBy",
          foreignField: "_id",
          as: "postedByUser",
        },
      },
      {
        $unwind: "$postedByUser",
      },
      ...getCategoryLookupPipeline(),
      {
        $addFields: {
          postedBy: {
            phoneNumber: "$postedByUser.phoneNumber",
            profile: {
              fullName: "$postedByUser.profile.fullName",
              email: "$postedByUser.profile.email",
              profileImage: "$postedByUser.profile.profileImage",
            },
          },
        },
      },
      {
        $project: {
          postedByUser: 0,
          jobCoords: 0,
        },
      },
      {
        $sort: { [sortBy]: sortOrder },
      },
      {
        $facet: {
          jobs: [{ $skip: skip }, { $limit: limit }],
          totalCount: [{ $count: "count" }],
        },
      }
    );

    const result = await Job.aggregate(pipeline);
    const jobs = result[0].jobs;
    const total = result[0].totalCount[0]?.count || 0;
    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      status: "success",
      data: {
        jobs,
        pagination: {
          currentPage: page,
          totalPages,
          totalJobs: total,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Failed to fetch tasks",
      error: error.message,
    });
  }
});

// Helper: aggregation stages that join the job's `category` ObjectId with the
// `servicecategories` collection and replace `category` with a small embedded
// object {_id, name, slug, icon}, or null when the job has no category.
// Lets list endpoints return category info inline so the frontend can render
// it without a second round-trip.
const getCategoryLookupPipeline = () => [
  {
    $lookup: {
      from: 'servicecategories',
      localField: 'category',
      foreignField: '_id',
      as: 'categoryDoc',
    },
  },
  {
    $addFields: {
      category: {
        $cond: [
          { $gt: [{ $size: '$categoryDoc' }, 0] },
          {
            _id: { $arrayElemAt: ['$categoryDoc._id', 0] },
            name: { $arrayElemAt: ['$categoryDoc.name', 0] },
            slug: { $arrayElemAt: ['$categoryDoc.slug', 0] },
            icon: { $arrayElemAt: ['$categoryDoc.icon', 0] },
          },
          null,
        ],
      },
    },
  },
  {
    $project: {
      categoryDoc: 0,
    },
  },
];

// Helper to get distance calculation pipeline stages
// This uses the Haversine formula to calculate distance in km
const getDistancePipeline = (userLat, userLng) => {
  return [
    {
      $addFields: {
        // Normalize coordinates based on job type
        jobCoords: {
          $cond: {
            if: { $eq: ["$jobType", "OnSite"] },
            then: {
              lat: { $ifNull: ["$location.latitude", 0] },
              lng: { $ifNull: ["$location.longitude", 0] },
            },
            else: {
              lat: { $ifNull: ["$location.source.latitude", 0] },
              lng: { $ifNull: ["$location.source.longitude", 0] },
            },
          },
        },
      },
    },
    {
      $addFields: {
        // Calculate distance using Haversine formula
        // d = 2 * R * asin(sqrt(sin^2(dlat/2) + cos(lat1) * cos(lat2) * sin^2(dlon/2)))
        // R = 6371 km
        distance: {
          $let: {
            vars: {
              dLat: {
                $degreesToRadians: { $subtract: ["$jobCoords.lat", userLat] },
              },
              dLng: {
                $degreesToRadians: { $subtract: ["$jobCoords.lng", userLng] },
              },
              lat1: { $degreesToRadians: userLat },
              lat2: { $degreesToRadians: "$jobCoords.lat" },
              radius: 6371,
            },
            in: {
              $multiply: [
                "$$radius",
                2,
                {
                  $asin: {
                    $sqrt: {
                      $add: [
                        { $pow: [{ $sin: { $divide: ["$$dLat", 2] } }, 2] },
                        {
                          $multiply: [
                            { $cos: "$$lat1" },
                            { $cos: "$$lat2" },
                            { $pow: [{ $sin: { $divide: ["$$dLng", 2] } }, 2] },
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
};

// @desc    Get hot jobs (urgent jobs) with location filtering and pagination
// @route   GET /api/jobs/hot
// @access  Public
const getHotJobs = asyncHandler(async (req, res) => {
  const params = { ...req.query, ...req.body };
  const page = parseInt(params.page) || 1;
  const limit = parseInt(params.limit) || 10;
  const skip = (page - 1) * limit;
  const sortBy = params.sortBy || 'createdAt';
  const sortOrder = params.sortOrder === 'asc' ? 1 : -1;

  const { location, latitude, longitude } = params;

  // Validate required location parameter (lat/lng)
  if (!latitude || !longitude) {
    return res.status(400).json({
      status: 'error',
      message: 'Coordinates (latitude, longitude) are required'
    });
  }

  try {
    // First, update jobs that have passed their scheduled date/time to inactive
    const now = new Date();

    // Helper function to parse time string (format: "HH:MM AM/PM" or "HH:MM")
    const parseTime = (timeStr) => {
      if (!timeStr) return null;

      // Remove extra spaces and convert to uppercase for easier parsing
      const cleaned = timeStr.trim().toUpperCase();

      // Check if it has AM/PM
      const hasAMPM = cleaned.includes('AM') || cleaned.includes('PM');

      if (hasAMPM) {
        const match = cleaned.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/);
        if (match) {
          let hours = parseInt(match[1], 10);
          const minutes = parseInt(match[2], 10);
          const period = match[3];

          if (period === 'PM' && hours !== 12) {
            hours += 12;
          } else if (period === 'AM' && hours === 12) {
            hours = 0;
          }

          return { hours, minutes };
        }
      } else {
        const match = cleaned.match(/(\d{1,2}):(\d{2})/);
        if (match) {
          return {
            hours: parseInt(match[1], 10),
            minutes: parseInt(match[2], 10)
          };
        }
      }

      return null;
    };

    // Find jobs that might be expired (check date first, then time)
    const expiredJobIds = [];
    const jobsToCheck = await Job.find({
      isActive: true,
      status: 'open',
      urgency: 'Urgent',
      scheduledDate: { $exists: true, $lte: now },
      scheduledTime: { $exists: true }
    }).select('_id scheduledDate scheduledTime');

    // Check each job's full datetime (date + time)
    for (const job of jobsToCheck) {
      if (!job.scheduledDate || !job.scheduledTime) continue;

      const timeParts = parseTime(job.scheduledTime);
      if (!timeParts) continue;

      // Create full datetime by combining scheduledDate with scheduledTime
      const scheduledDateTime = new Date(job.scheduledDate);
      scheduledDateTime.setHours(timeParts.hours, timeParts.minutes, 0, 0);

      // If scheduled datetime is in the past, mark for update
      if (scheduledDateTime < now) {
        expiredJobIds.push(job._id);
      }
    }

    // Bulk update expired jobs to inactive
    if (expiredJobIds.length > 0) {
      await Job.updateMany(
        { _id: { $in: expiredJobIds } },
        { $set: { isActive: false } }
      );
    }

    // Use aggregation to match jobs with users whose location matches the query
    // Build initial match conditions
    const initialMatch = {
      isActive: true,
      status: 'open',
      urgency: 'Urgent'
    };
    if (req.user) {
      initialMatch.postedBy = { $ne: new mongoose.Types.ObjectId(req.user._id) };
    }
    // Optional category filter (?category=<idOrSlug>)
    const hotCategoryId = await resolveCategoryFilter(params.category);
    if (hotCategoryId) {
      initialMatch.category = hotCategoryId;
    }

    let pipeline = [
      {
        $match: initialMatch
      }
    ];

    // Add distance filter (coordinates are now guaranteed by validation)
    const userLat = parseFloat(latitude);
    const userLng = parseFloat(longitude);
    
    pipeline = [
      ...pipeline,
      ...getDistancePipeline(userLat, userLng),
      {
        $match: {
          distance: { $lte: 25 } // 25km radius
        }
      }
    ];

    // Continue pipeline
    pipeline.push(
      // Look up user
      {
        $lookup: {
          from: 'users',
          localField: 'postedBy',
          foreignField: '_id',
          as: 'postedByUser'
        }
      },
      {
        $unwind: '$postedByUser'
      },
      ...getCategoryLookupPipeline(),
      {
        $addFields: {
          postedBy: {
            phoneNumber: '$postedByUser.phoneNumber',
            profile: {
              fullName: '$postedByUser.profile.fullName',
              email: '$postedByUser.profile.email',
              profileImage: '$postedByUser.profile.profileImage'
            }
          }
        }
      },
      {
        $project: {
          postedByUser: 0,
          jobCoords: 0 // Remove temp field
        }
      },
      {
        $sort: { [sortBy]: sortOrder }
      },
      {
        $facet: {
          jobs: [
            { $skip: skip },
            { $limit: limit }
          ],
          totalCount: [
            { $count: 'count' }
          ]
        }
      }
    );

    const result = await Job.aggregate(pipeline);
    const jobs = result[0].jobs;
    const total = result[0].totalCount[0]?.count || 0;
    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      status: 'success',
      data: {
        jobs,
        location,
        latitude,
        longitude,
        urgency: 'Urgent',
        pagination: {
          currentPage: page,
          totalPages,
          totalJobs: total,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch hot tasks',
      error: error.message
    });
  }
});

// @desc    Search hot jobs (urgent jobs) by title with location filtering and pagination
// @route   GET /api/jobs/search/hot
// @access  Public
const searchHotJobs = asyncHandler(async (req, res) => {
  const params = { ...req.query, ...req.body };
  const page = parseInt(params.page) || 1;
  const limit = parseInt(params.limit) || 10;
  const skip = (page - 1) * limit;
  const sortBy = params.sortBy || 'createdAt';
  const sortOrder = params.sortOrder === 'asc' ? 1 : -1;

  const { location, search, latitude, longitude } = params;

  // Validate required parameters
  if (!latitude || !longitude) {
    return res.status(400).json({
      status: 'error',
      message: 'Coordinates (latitude, longitude) are required'
    });
  }

  if (!search) {
    return res.status(400).json({
      status: 'error',
      message: 'Search parameter is required'
    });
  }

  try {
    // First, update jobs that have passed their scheduled date/time to inactive
    const now = new Date();

    // Helper function to parse time string (format: "HH:MM AM/PM" or "HH:MM")
    const parseTime = (timeStr) => {
      if (!timeStr) return null;

      // Remove extra spaces and convert to uppercase for easier parsing
      const cleaned = timeStr.trim().toUpperCase();

      // Check if it has AM/PM
      const hasAMPM = cleaned.includes('AM') || cleaned.includes('PM');

      if (hasAMPM) {
        const match = cleaned.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/);
        if (match) {
          let hours = parseInt(match[1], 10);
          const minutes = parseInt(match[2], 10);
          const period = match[3];

          if (period === 'PM' && hours !== 12) {
            hours += 12;
          } else if (period === 'AM' && hours === 12) {
            hours = 0;
          }

          return { hours, minutes };
        }
      } else {
        const match = cleaned.match(/(\d{1,2}):(\d{2})/);
        if (match) {
          return {
            hours: parseInt(match[1], 10),
            minutes: parseInt(match[2], 10)
          };
        }
      }

      return null;
    };

    // Find jobs that might be expired (check date first, then time)
    const expiredJobIds = [];
    const jobsToCheck = await Job.find({
      isActive: true,
      status: 'open',
      urgency: 'Urgent',
      scheduledDate: { $exists: true, $lte: now },
      scheduledTime: { $exists: true }
    }).select('_id scheduledDate scheduledTime');

    // Check each job's full datetime (date + time)
    for (const job of jobsToCheck) {
      if (!job.scheduledDate || !job.scheduledTime) continue;

      const timeParts = parseTime(job.scheduledTime);
      if (!timeParts) continue;

      // Create full datetime by combining scheduledDate with scheduledTime
      const scheduledDateTime = new Date(job.scheduledDate);
      scheduledDateTime.setHours(timeParts.hours, timeParts.minutes, 0, 0);

      // If scheduled datetime is in the past, mark for update
      if (scheduledDateTime < now) {
        expiredJobIds.push(job._id);
      }
    }

    // Bulk update expired jobs to inactive
    if (expiredJobIds.length > 0) {
      await Job.updateMany(
        { _id: { $in: expiredJobIds } },
        { $set: { isActive: false } }
      );
    }

    // Build initial match conditions
    const initialMatch = {
      isActive: true,
      status: 'open',
      urgency: 'Urgent',
      title: { $regex: search, $options: 'i' } // Add title search
    };
    if (req.user) {
      initialMatch.postedBy = { $ne: new mongoose.Types.ObjectId(req.user._id) };
    }
    // Optional category filter
    const searchHotCategoryId = await resolveCategoryFilter(params.category);
    if (searchHotCategoryId) {
      initialMatch.category = searchHotCategoryId;
    }

    let pipeline = [
      {
        $match: initialMatch
      }
    ];

    // Add distance filter if coordinates are provided
    // Add distance filter (coordinates are now guaranteed by validation)
    const userLat = parseFloat(latitude);
    const userLng = parseFloat(longitude);
    
    pipeline = [
        ...pipeline,
        ...getDistancePipeline(userLat, userLng),
        {
            $match: {
                distance: { $lte: 25 } // 25km radius
            }
        }
    ];

    pipeline.push(
        // Look up user
        {
            $lookup: {
                from: 'users',
                localField: 'postedBy',
                foreignField: '_id',
                as: 'postedByUser'
            }
        },
        {
            $unwind: '$postedByUser'
        },
        ...getCategoryLookupPipeline(),
      {
        $addFields: {
          postedBy: {
            phoneNumber: '$postedByUser.phoneNumber',
            profile: {
              fullName: '$postedByUser.profile.fullName',
              email: '$postedByUser.profile.email',
              profileImage: '$postedByUser.profile.profileImage'
            }
          }
        }
      },
      {
        $project: {
          postedByUser: 0,
          jobCoords: 0
        }
      },
      {
        $sort: { [sortBy]: sortOrder }
      },
      {
        $facet: {
          jobs: [
            { $skip: skip },
            { $limit: limit }
          ],
          totalCount: [
            { $count: 'count' }
          ]
        }
      }
    );

    const result = await Job.aggregate(pipeline);
    const jobs = result[0].jobs;
    const total = result[0].totalCount[0]?.count || 0;
    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      status: 'success',
      data: {
        jobs,
        location,
        search,
        latitude,
        longitude,
        urgency: 'Urgent',
        pagination: {
          currentPage: page,
          totalPages,
          totalJobs: total,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to search hot tasks',
      error: error.message
    });
  }
});

// @desc    Get normal jobs with location filtering and pagination
// @route   GET /api/jobs/normal
// @access  Public
const getNormalJobs = asyncHandler(async (req, res) => {
  const params = { ...req.query, ...req.body };
  const page = parseInt(params.page) || 1;
  const limit = parseInt(params.limit) || 10;
  const skip = (page - 1) * limit;
  const sortBy = params.sortBy || 'createdAt';
  const sortOrder = params.sortOrder === 'asc' ? 1 : -1;

  const { location, latitude, longitude } = params;

  // Validate required location parameter
  if (!latitude || !longitude) {
    return res.status(400).json({
      status: 'error',
      message: 'Coordinates (latitude, longitude) are required'
    });
  }

  try {
    // Build initial match conditions
    const initialMatch = {
      isActive: true,
      status: 'open',
      urgency: 'Normal'
    };
    if (req.user) {
      initialMatch.postedBy = { $ne: new mongoose.Types.ObjectId(req.user._id) };
    }
    // Optional category filter
    const normalCategoryId = await resolveCategoryFilter(params.category);
    if (normalCategoryId) {
      initialMatch.category = normalCategoryId;
    }

    let pipeline = [
      {
        $match: initialMatch
      }
    ];

    // Add distance filter if coordinates are provided
    // Add distance filter (coordinates are now guaranteed by validation)
    const userLat = parseFloat(latitude);
    const userLng = parseFloat(longitude);

    pipeline = [
        ...pipeline,
        ...getDistancePipeline(userLat, userLng),
        {
            $match: {
                distance: { $lte: 25 } // 25km radius
            }
        }
    ];

    pipeline.push(
        // Look up user
        {
            $lookup: {
                from: 'users',
                localField: 'postedBy',
                foreignField: '_id',
                as: 'postedByUser'
            }
        },
        {
            $unwind: '$postedByUser'
        },
        ...getCategoryLookupPipeline(),
      {
        $addFields: {
          postedBy: {
            phoneNumber: '$postedByUser.phoneNumber',
            profile: {
              fullName: '$postedByUser.profile.fullName',
              email: '$postedByUser.profile.email',
              profileImage: '$postedByUser.profile.profileImage'
            }
          }
        }
      },
      {
        $project: {
          postedByUser: 0,
          jobCoords: 0
        }
      },
      {
        $sort: { [sortBy]: sortOrder }
      },
      {
        $facet: {
          jobs: [
            { $skip: skip },
            { $limit: limit }
          ],
          totalCount: [
            { $count: 'count' }
          ]
        }
      }
    );

    const result = await Job.aggregate(pipeline);
    const jobs = result[0].jobs;
    const total = result[0].totalCount[0]?.count || 0;
    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      status: 'success',
      data: {
        jobs,
        location,
        latitude,
        longitude,
        urgency: 'Normal',
        pagination: {
          currentPage: page,
          totalPages,
          totalJobs: total,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch normal tasks',
      error: error.message
    });
  }
});

// @desc    Search normal jobs by title with location filtering and pagination
// @route   GET /api/jobs/search/normal
// @access  Public
const searchNormalJobs = asyncHandler(async (req, res) => {
  const params = { ...req.query, ...req.body };
  const page = parseInt(params.page) || 1;
  const limit = parseInt(params.limit) || 10;
  const skip = (page - 1) * limit;
  const sortBy = params.sortBy || 'createdAt';
  const sortOrder = params.sortOrder === 'asc' ? 1 : -1;

  const { location, search, latitude, longitude } = params;

  // Validate required parameters
  if (!latitude || !longitude) {
    return res.status(400).json({
      status: 'error',
      message: 'Coordinates (latitude, longitude) are required'
    });
  }

  if (!search) {
    return res.status(400).json({
      status: 'error',
      message: 'Search parameter is required'
    });
  }

  try {
    // Build initial match conditions
    const initialMatch = {
      isActive: true,
      status: 'open',
      urgency: 'Normal',
      title: { $regex: search, $options: 'i' } // Add title search
    };
    if (req.user) {
      initialMatch.postedBy = { $ne: new mongoose.Types.ObjectId(req.user._id) };
    }
    // Optional category filter
    const searchNormalCategoryId = await resolveCategoryFilter(params.category);
    if (searchNormalCategoryId) {
      initialMatch.category = searchNormalCategoryId;
    }

    let pipeline = [
      {
        $match: initialMatch
      }
    ];

    // Add distance filter if coordinates are provided
    // Add distance filter (coordinates are now guaranteed by validation)
    const userLat = parseFloat(latitude);
    const userLng = parseFloat(longitude);
    
    pipeline = [
        ...pipeline,
        ...getDistancePipeline(userLat, userLng),
        {
            $match: {
                distance: { $lte: 25 } // 25km radius
            }
        }
    ];

    pipeline.push(
        // Look up user
        {
            $lookup: {
                from: 'users',
                localField: 'postedBy',
                foreignField: '_id',
                as: 'postedByUser'
            }
        },
        {
            $unwind: '$postedByUser'
        },
        ...getCategoryLookupPipeline(),
      {
        $addFields: {
          postedBy: {
            phoneNumber: '$postedByUser.phoneNumber',
            profile: {
              fullName: '$postedByUser.profile.fullName',
              email: '$postedByUser.profile.email',
              profileImage: '$postedByUser.profile.profileImage'
            }
          }
        }
      },
      {
        $project: {
          postedByUser: 0,
          jobCoords: 0
        }
      },
      {
        $sort: { [sortBy]: sortOrder }
      },
      {
        $facet: {
          jobs: [
            { $skip: skip },
            { $limit: limit }
          ],
          totalCount: [
            { $count: 'count' }
          ]
        }
      }
    );

    const result = await Job.aggregate(pipeline);
    const jobs = result[0].jobs;
    const total = result[0].totalCount[0]?.count || 0;
    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      status: 'success',
      data: {
        jobs,
        location,
        search,
        latitude,
        longitude,
        urgency: 'Normal',
        pagination: {
          currentPage: page,
          totalPages,
          totalJobs: total,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to search normal tasks',
      error: error.message
    });
  }
});

// @desc    Get a single job by ID
// @route   GET /api/jobs/:id
// @access  Public
const getJobById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  try {
    const job = await Job.findById(id)
      .populate(
        "postedBy",
        "phoneNumber profile.fullName profile.email profile.location profile.profileImage",
      )
      .populate({
        path: "interestedUsers.user",
        select: "profile.fullName profile.email phoneNumber profile.profileImage vehiclePreference isProfessional professionalProfile",
        populate: {
          path: "professionalProfile.serviceCategories",
          model: "ServiceCategory",
          select: "_id name slug icon",
        },
      })
      .populate("category", "_id name slug icon");

    if (!job) {
      return res.status(404).json({
        status: "error",
        message: "Task not found",
      });
    }

    res.status(200).json({
      status: "success",
      data: {
        job,
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Failed to fetch task",
      error: error.message,
    });
  }
});

// @desc    Get jobs posted by current user
// @route   GET /api/jobs/my-jobs
// @access  Private
const getMyJobs = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;
  const sortBy = req.query.sortBy || "createdAt";
  const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;

  const { status } = req.query;

  // Build filter object - show only active jobs posted by user
  const filter = {
    postedBy: req.user._id,
    isActive: true,
  };
  // if (status) filter.status = status;

  // Build sort object
  const sort = {};
  sort[sortBy] = sortOrder;

  try {
    const jobs = await Job.find(filter)
      .populate("category", "_id name slug icon")
      .populate("assignedWorker", "profile.fullName profile.profileImage workerId rating")
      .sort(sort)
      .skip(skip)
      .limit(limit);

    const total = await Job.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      status: "success",
      data: {
        jobs,
        pagination: {
          currentPage: page,
          totalPages,
          totalJobs: total,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Failed to fetch your tasks",
      error: error.message,
    });
  }
});

// @desc    Update a job
// @route   PUT /api/jobs/:id
// @access  Private
const updateJob = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    title,
    description,
    cost,
    location,
    jobType,
    urgency,
    scheduledDate,
    scheduledTime,
    responsePreference,
    attachments,
    newAttachments,
    existingAttachments,
    distanceKm,
    category,
    removeVoiceNote,
  } = req.body;

  try {
    const job = await Job.findById(id);

    if (!job) {
      return res.status(404).json({
        status: "error",
        message: "Task not found",
      });
    }

    // Check if user is the owner of the job
    if (job.postedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        status: "error",
        message: "Not authorized to update this task",
      });
    }

    // // Don't allow updating if job is completed or cancelled
    // if (job.status === 'completed' || job.status === 'cancelled') {
    //   return res.status(400).json({
    //     status: 'error',
    //     message: 'Cannot update completed or cancelled jobs'
    //   });
    // }

    // Build updateData object with only provided fields
    const updateData = {};

    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (cost !== undefined) updateData.cost = cost;
    if (jobType !== undefined) {
      // Validate jobType
      const validJobTypes = ["Pickup", "OnSite"];
      if (!validJobTypes.includes(jobType)) {
        return res.status(400).json({
          status: "error",
          message: "Invalid task type. Must be one of: Pickup, OnSite",
        });
      }
      updateData.jobType = jobType;
    }
    if (urgency !== undefined) {
      // Validate urgency
      const validUrgencies = ["Urgent", "Normal"];
      if (!validUrgencies.includes(urgency)) {
        return res.status(400).json({
          status: "error",
          message: "Invalid urgency. Must be one of: Urgent, Normal",
        });
      }
      updateData.urgency = urgency;
    }
    if (scheduledDate !== undefined) {
      // Validate scheduled date is not in the past
      const scheduledDateObj = new Date(scheduledDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (scheduledDateObj < today) {
        return res.status(400).json({
          status: "error",
          message: "Scheduled date cannot be in the past",
        });
      }
      updateData.scheduledDate = scheduledDateObj;
    }
    if (scheduledTime !== undefined) {
      updateData.scheduledTime = scheduledTime;
    }
    if (responsePreference !== undefined) {
      // Validate responsePreference
      const validResponsePreferences = ["direct_contact", "show_interest"];
      if (!validResponsePreferences.includes(responsePreference)) {
        return res.status(400).json({
          status: "error",
          message:
            "Invalid response preference. Must be one of: direct_contact, show_interest",
        });
      }
      updateData.responsePreference = responsePreference;
    }

    // Handle location parsing (if location was sent as a JSON string)
    if (location !== undefined) {
      let locationObj = location;
      if (typeof location === "string") {
        try {
          locationObj = JSON.parse(location);
        } catch (err) {
          return res.status(400).json({
            status: "error",
            message:
              "Invalid location format. Send location as an object or a JSON string.",
          });
        }
      }
      updateData.location = locationObj;
    }

    // Handle service category — accept ObjectId or slug. Empty string clears it.
    if (category !== undefined) {
      if (category === null || category === "") {
        updateData.category = null;
      } else {
        const ServiceCategory = require("../models/ServiceCategory");
        const isObjectId = /^[a-f\d]{24}$/i.test(String(category));
        const categoryDoc = await ServiceCategory.findOne(
          isObjectId ? { _id: category } : { slug: String(category).toLowerCase() }
        );
        if (!categoryDoc) {
          return res.status(400).json({
            status: "error",
            message: "Selected service category does not exist",
          });
        }
        if (!categoryDoc.isActive) {
          return res.status(400).json({
            status: "error",
            message: "Selected service category is no longer available",
          });
        }
        updateData.category = categoryDoc._id;
      }
    }

    // Handle distanceKm (Pickup jobs only). Use the value from client if valid,
    // otherwise compute from source/destination coordinates as a fallback.
    const effectiveJobType =
      updateData.jobType !== undefined ? updateData.jobType : job.jobType;
    if (effectiveJobType === "Pickup") {
      const parsedClientDistance =
        distanceKm !== undefined && distanceKm !== null && distanceKm !== ""
          ? Number(distanceKm)
          : null;

      if (
        parsedClientDistance !== null &&
        !Number.isNaN(parsedClientDistance) &&
        parsedClientDistance >= 0
      ) {
        updateData.distanceKm = Math.round(parsedClientDistance * 100) / 100;
      } else if (updateData.location) {
        // Recompute from new location object if distance not provided
        const computed = computePickupDistance(updateData.location);
        if (computed !== null) {
          updateData.distanceKm = computed;
        }
      }
    } else if (effectiveJobType === "OnSite") {
      // OnSite jobs don't have a meaningful pickup distance
      updateData.distanceKm = null;
    }

    // Handle attachments: combine newAttachments (uploaded files) and existingAttachments

    const { newAttachments, existingAttachments } = req.body;
    const combinedAttachments = [];

    // Add newly uploaded files (processed by upload middleware)
    if (req.processedFileNames && req.processedFileNames.length > 0) {
      const uploadedAttachments = req.processedFileNames.map(
        (name) => `jobs/${name}`,
      );
      combinedAttachments.push(...uploadedAttachments);
    }

    // Add existing attachments (already saved paths)
    let existingAttachmentsArr = existingAttachments;
    if (typeof existingAttachments === "string") {
      try {
        existingAttachmentsArr = JSON.parse(existingAttachments);
      } catch (err) {
        return res.status(400).json({
          status: "error",
          message:
            "Invalid existingAttachments format. Must be an array or JSON string.",
        });
      }
    }
    if (existingAttachmentsArr && Array.isArray(existingAttachmentsArr)) {
      combinedAttachments.push(...existingAttachmentsArr);
    }

    // If combined attachments provided, validate and save
    if (combinedAttachments.length > 0) {
      if (combinedAttachments.length > 5) {
        return res.status(400).json({
          status: "error",
          message: "Cannot have more than 5 attachments",
        });
      }
      updateData.attachments = combinedAttachments;
    } else if (attachments !== undefined) {
      // Fallback: if neither newAttachments nor existingAttachments are present,
      // but attachments field is provided, use it (for backwards compatibility)
      if (Array.isArray(attachments)) {
        if (attachments.length > 5) {
          return res.status(400).json({
            status: "error",
            message: "Cannot have more than 5 attachments",
          });
        }
        updateData.attachments = attachments;
      } else {
        return res.status(400).json({
          status: "error",
          message: "Attachments must be an array",
        });
      }
    }

    // Handle voiceNote: new upload takes priority, then removeVoiceNote flag clears it
    if (req.processedAudioFileName) {
      updateData.voiceNote = `jobs/audio/${req.processedAudioFileName}`;
    } else if (removeVoiceNote === 'true' || removeVoiceNote === true) {
      updateData.voiceNote = null;
    }

    let onBehalfUpdate = null;
    if (
      req.body.postedOnBehalf !== undefined ||
      req.body.externalContactName !== undefined ||
      req.body.externalContactPhone !== undefined
    ) {
      onBehalfUpdate = parsePostedOnBehalfFields(req.body);
      if (onBehalfUpdate.error) {
        return res.status(400).json({
          status: "error",
          message: onBehalfUpdate.error,
        });
      }
      updateData.postedOnBehalf = onBehalfUpdate.postedOnBehalf;
      if (onBehalfUpdate.postedOnBehalf) {
        updateData.externalContact = onBehalfUpdate.externalContact;
      }
    }

    // Always reset status to 'open' and isActive to true when job is updated
    updateData.status = "open";
    updateData.isActive = true;

    // If no fields to update (excluding status and isActive), return error
    if (Object.keys(updateData).length === 2) {
      // Only status and isActive are set
      return res.status(400).json({
        status: "error",
        message: "No fields provided to update",
      });
    }

    // Apply updates on the document so that custom validators and pre-save hooks run correctly
    Object.assign(job, updateData);
    if (onBehalfUpdate && !onBehalfUpdate.postedOnBehalf) {
      job.set("externalContact", undefined);
    }
    const updatedJob = await job.save();
    await updatedJob.populate(
      "postedBy",
      "phoneNumber profile.fullName profile.email",
    );
    await updatedJob.populate("category", "_id name slug icon");

    res.status(200).json({
      status: "success",
      message: "Task updated successfully",
      data: {
        job: updatedJob,
      },
    });
  } catch (error) {
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((val) => val.message);
      return res.status(400).json({
        status: "error",
        message: messages.join(". "),
        errors: messages,
      });
    }
    console.error("Error updating job:", error);
    res.status(500).json({
      status: "error",
      message: "Failed to update task. Please try again.",
    });
  }
});

// @desc    Delete a job
// @route   DELETE /api/jobs/:id
// @access  Private
const deleteJob = asyncHandler(async (req, res) => {
  const { id } = req.params;

  try {
    const job = await Job.findById(id);

    if (!job) {
      return res.status(404).json({
        status: "error",
        message: "Task not found",
      });
    }

    // Check if user is the owner of the job
    if (job.postedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        status: "error",
        message: "Not authorized to delete this task",
      });
    }

    // Soft delete by setting isActive to false
    job.isActive = false;
    await job.save();

    res.status(200).json({
      status: "success",
      message: "Task deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Failed to delete task",
      error: error.message,
    });
  }
});

// @desc    Update job status
// @route   PUT /api/jobs/:id/status
// @access  Private
const updateJobStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  // This endpoint is intentionally restricted to cancellation only.
  // "job_started" is set exclusively by POST /jobs/:id/start (after Worker ID
  // verification) and "completed" is set exclusively by POST /jobs/:id/complete
  // (after the worker enters the correct Job PIN). Allowing either of those
  // values here would let the job owner bypass PIN verification entirely.
  const validStatuses = ["cancelled"];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({
      status: "error",
      message:
        "This endpoint can only be used to cancel a task. Use the Verify Worker flow to start a task and the Task PIN flow to complete one.",
    });
  }

  try {
    const job = await Job.findById(id);

    if (!job) {
      return res.status(404).json({
        status: "error",
        message: "Task not found",
      });
    }

    // Check if user is the owner of the job
    if (job.postedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        status: "error",
        message: "Not authorized to update this task status",
      });
    }

    if (job.status !== "open") {
      return res.status(400).json({
        status: "error",
        message: `Only open tasks can be cancelled (current status: ${job.status})`,
      });
    }

    job.status = "cancelled";
    await job.save();

    res.status(200).json({
      status: "success",
      message: "Task status updated to cancelled",
      data: {
        job: {
          id: job._id,
          status: job.status,
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Failed to update task status",
      error: error.message,
    });
  }
});

// @desc    Deactivate jobs whose scheduled date/time is in the past
// @route   POST /api/jobs/expire-old
// @access  Private
const expireOldJobs = asyncHandler(async (req, res) => {
  try {
    const now = new Date();

    // Helper function to parse time string (format: "HH:MM AM/PM" or "HH:MM")
    const parseTime = (timeStr) => {
      if (!timeStr) return null;

      const cleaned = timeStr.trim().toUpperCase();
      const hasAMPM = cleaned.includes("AM") || cleaned.includes("PM");

      if (hasAMPM) {
        const match = cleaned.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/);
        if (match) {
          let hours = parseInt(match[1], 10);
          const minutes = parseInt(match[2], 10);
          const period = match[3];

          if (period === "PM" && hours !== 12) {
            hours += 12;
          } else if (period === "AM" && hours === 12) {
            hours = 0;
          }

          return { hours, minutes };
        }
      } else {
        const match = cleaned.match(/(\d{1,2}):(\d{2})/);
        if (match) {
          return {
            hours: parseInt(match[1], 10),
            minutes: parseInt(match[2], 10),
          };
        }
      }

      return null;
    };

    // Find candidate jobs: open (regardless of isActive), with scheduled date/time not in the future (by date)
    const jobsToCheck = await Job.find({
      status: "open",
      scheduledDate: { $exists: true, $lte: now },
      scheduledTime: { $exists: true },
    }).select("_id scheduledDate scheduledTime");

    const expiredJobIds = [];

    for (const job of jobsToCheck) {
      if (!job.scheduledDate || !job.scheduledTime) continue;

      const timeParts = parseTime(job.scheduledTime);
      if (!timeParts) continue;

      const scheduledDateTime = new Date(job.scheduledDate);
      scheduledDateTime.setHours(timeParts.hours, timeParts.minutes, 0, 0);

      if (scheduledDateTime < now) {
        expiredJobIds.push(job._id);
      }
    }

    let updatedCount = 0;
    if (expiredJobIds.length > 0) {
      const result = await Job.updateMany(
        { _id: { $in: expiredJobIds } },
        {
          $set: {
            isActive: false,
            status: "cancelled",
          },
        },
      );
      updatedCount = result.modifiedCount || result.nModified || 0;
    }

    res.status(200).json({
      status: "success",
      message: "Expired tasks processed successfully",
      data: {
        checkedJobs: jobsToCheck.length,
        expiredJobs: expiredJobIds.length,
        updatedJobs: updatedCount,
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Failed to process expired tasks",
      error: error.message,
    });
  }
});

// ─── Worker Verification & Job Lifecycle ────────────────────────────────────

// @desc    Look up a professional by their Worker ID
// @route   GET /api/workers/lookup/:workerId
// @access  Private
const lookupWorker = asyncHandler(async (req, res) => {
  const { workerId } = req.params;
  if (!workerId || workerId.length !== 5) {
    return res.status(400).json({ status: "error", message: "Worker ID must be 5 characters" });
  }

  const worker = await User.findOne({
    workerId: workerId.toUpperCase(),
    isProfessional: true,
  })
    .select("profile.fullName profile.profileImage workerId rating isProfessional isVerified verification professionalProfile")
    .populate("professionalProfile.serviceCategories", "_id name slug icon");

  if (!worker) {
    return res.status(404).json({
      status: "error",
      message: "No registered professional found with this Worker ID",
    });
  }

  res.status(200).json({
    status: "success",
    data: {
      worker: {
        _id: worker._id,
        workerId: worker.workerId,
        isProfessional: worker.isProfessional,
        rating: worker.rating || { average: 0, count: 0 },
        profile: {
          fullName: worker.profile?.fullName,
          profileImage: worker.profile?.profileImage,
        },
        professionalProfile: {
          serviceCategories: (worker.professionalProfile?.serviceCategories || []).filter(Boolean),
          bio: worker.professionalProfile?.bio,
          yearsOfExperience: worker.professionalProfile?.yearsOfExperience,
        },
        verification: {
          status: worker.verification?.status || "not_submitted",
          // Selfie from identity verification — preferred over profileImage for trust
          selfieImage:
            worker.verification?.status === "approved"
              ? worker.verification?.selfieImage || null
              : null,
        },
      },
    },
  });
});

// @desc    Customer confirms worker and starts the job
// @route   POST /api/jobs/:id/start
// @access  Private (job owner)
const startJob = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { workerId } = req.body; // workerId = User._id of the assigned worker

  const job = await Job.findById(id);
  if (!job) return res.status(404).json({ status: "error", message: "Task not found" });
  if (job.postedBy.toString() !== req.user._id.toString()) {
    return res.status(403).json({ status: "error", message: "Not authorized" });
  }
  if (job.status !== "open") {
    return res.status(400).json({ status: "error", message: `Cannot start a task with status: ${job.status}` });
  }
  if (!workerId) {
    return res.status(400).json({ status: "error", message: "Worker ID (user _id) is required" });
  }

  // Re-verify server-side that this user is a registered professional with a
  // Worker ID, even though the client already looked them up. Prevents a
  // tampered request from assigning an arbitrary/unverified user to the job.
  const workerUser = await User.findById(workerId).select("isProfessional workerId");
  if (!workerUser || !workerUser.isProfessional || !workerUser.workerId) {
    return res.status(400).json({
      status: "error",
      message: "Selected worker is not a registered professional",
    });
  }

  job.status = "job_started";
  job.assignedWorker = workerId;
  job.startedAt = new Date();
  await job.save();

  // Notify the assigned worker
  try {
    const notif = await Notification.create({
      recipient: workerId,
      type: "job_started",
      title: "Task Started!",
      message: `The customer has confirmed you for: ${job.title}. Head over to complete the task!`,
      relatedEntityType: "Job",
      relatedEntityId: job._id,
      navigationIdentifier: `job:${job._id}`,
      isRead: false,
    });
    sendPushToUserForNotification(notif.recipient, notif, Device).catch(() => {});
  } catch (_) {}

  res.status(200).json({
    status: "success",
    message: "Task started successfully",
    data: { jobId: job._id, status: job.status, startedAt: job.startedAt },
  });
});

// @desc    Worker enters Job PIN to mark job as completed
// @route   POST /api/jobs/:id/complete
// @access  Private (assigned worker)
const completeJob = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { jobPin } = req.body;

  const job = await Job.findById(id);
  if (!job) return res.status(404).json({ status: "error", message: "Task not found" });
  if (job.status !== "job_started") {
    return res.status(400).json({ status: "error", message: "Task is not in progress" });
  }
  if (!job.assignedWorker || job.assignedWorker.toString() !== req.user._id.toString()) {
    return res.status(403).json({ status: "error", message: "You are not the assigned worker for this task" });
  }

  // Rate-limit: max 5 wrong attempts
  if (job.pinAttempts >= 5) {
    return res.status(429).json({ status: "error", message: "Too many incorrect PIN attempts. Contact the customer." });
  }

  if (!jobPin || jobPin.toUpperCase() !== job.jobPin) {
    job.pinAttempts = (job.pinAttempts || 0) + 1;
    await job.save();
    const remaining = 5 - job.pinAttempts;
    return res.status(400).json({
      status: "error",
      message: `Incorrect Task PIN. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.`,
    });
  }

  // PIN correct — mark completed
  job.status = "completed";
  job.completedAt = new Date();
  await job.save();

  // Notify the job owner to leave a review
  try {
    const notif = await Notification.create({
      recipient: job.postedBy,
      type: "job_completed",
      title: "Task Completed!",
      message: `Your task "${job.title}" has been completed. Please leave a review!`,
      relatedEntityType: "Job",
      relatedEntityId: job._id,
      navigationIdentifier: `job:${job._id}`,
      isRead: false,
    });
    sendPushToUserForNotification(notif.recipient, notif, Device).catch(() => {});
  } catch (_) {}

  res.status(200).json({
    status: "success",
    message: "Task completed successfully!",
    data: { jobId: job._id, status: job.status, completedAt: job.completedAt },
  });
});

// @desc    Customer submits a review for the worker after job completion
// @route   POST /api/jobs/:id/review
// @access  Private (job owner)
const submitReview = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rating, comment } = req.body;

  const job = await Job.findById(id).populate("assignedWorker", "_id rating");
  if (!job) return res.status(404).json({ status: "error", message: "Task not found" });
  if (job.postedBy.toString() !== req.user._id.toString()) {
    return res.status(403).json({ status: "error", message: "Not authorized" });
  }
  if (job.status !== "completed") {
    return res.status(400).json({ status: "error", message: "Task must be completed before submitting a review" });
  }
  if (job.isReviewed) {
    return res.status(400).json({ status: "error", message: "You have already submitted a review for this task" });
  }
  if (!job.assignedWorker) {
    return res.status(400).json({ status: "error", message: "No assigned worker found for this task" });
  }

  const ratingNum = Number(rating);
  if (!ratingNum || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ status: "error", message: "Rating must be between 1 and 5" });
  }

  // Create review
  await Review.create({
    jobId: id,
    reviewerId: req.user._id,
    workerId: job.assignedWorker._id,
    rating: ratingNum,
    comment: comment ? String(comment).trim() : "",
  });

  // Update worker's rating average and count atomically
  const worker = await User.findById(job.assignedWorker._id);
  if (worker) {
    const oldCount = worker.rating?.count || 0;
    const oldAvg = worker.rating?.average || 0;
    const newCount = oldCount + 1;
    const newAvg = Math.round(((oldAvg * oldCount + ratingNum) / newCount) * 10) / 10;
    worker.rating = { average: newAvg, count: newCount };
    await worker.save();
  }

  // Mark job as reviewed
  job.isReviewed = true;
  await job.save();

  res.status(201).json({
    status: "success",
    message: "Review submitted successfully. Thank you!",
  });
});

// @desc    Get paginated reviews for a worker
// @route   GET /api/workers/:userId/reviews
// @access  Public
const getWorkerReviews = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const worker = await User.findById(userId)
    .select(
      "profile.fullName profile.profileImage profile.location workerId rating isProfessional verification professionalProfile"
    )
    .populate("professionalProfile.serviceCategories", "_id name slug icon");
  if (!worker) return res.status(404).json({ status: "error", message: "Worker not found" });

  const reviews = await Review.find({ workerId: userId })
    .populate("reviewerId", "profile.fullName profile.profileImage")
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  const total = await Review.countDocuments({ workerId: userId });

  res.status(200).json({
    status: "success",
    data: {
      worker: {
        _id: worker._id,
        fullName: worker.profile?.fullName,
        profileImage: worker.profile?.profileImage,
        location: worker.profile?.location,
        workerId: worker.workerId,
        rating: worker.rating,
        verification: { status: worker.verification?.status || "not_submitted" },
        professionalProfile: {
          serviceCategories: (worker.professionalProfile?.serviceCategories || []).filter(Boolean),
          workImages: worker.professionalProfile?.workImages || [],
          bio: worker.professionalProfile?.bio || "",
          yearsOfExperience: worker.professionalProfile?.yearsOfExperience ?? null,
        },
      },
      reviews,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalReviews: total,
        hasNextPage: page < Math.ceil(total / limit),
        hasPrevPage: page > 1,
      },
    },
  });
});

// ────────────────────────────────────────────────────────────────────────────

module.exports = {
  createJob,
  getAllJobs,
  getHotJobs,
  searchHotJobs,
  getNormalJobs,
  searchNormalJobs,
  getJobById,
  getMyJobs,
  getMyInterestedJobs,
  updateJob,
  deleteJob,
  updateJobStatus,
  showInterestInJob,
  expireOldJobs,
  lookupWorker,
  startJob,
  completeJob,
  submitReview,
  getWorkerReviews,
};
