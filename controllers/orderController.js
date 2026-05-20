const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const BusinessProfile = require("../models/BusinessProfile");
const Notification = require("../models/Notification");
const Device = require("../models/Device");
const User = require("../models/User");
const {
  sendPushToUserForNotification,
} = require("../services/pushNotificationService");

// @desc    Raise a new order against a business profile
// @route   POST /api/orders
// @access  Private (any logged-in user)
//
// Body:
//   businessProfileId (required) — ObjectId of the BusinessProfile being ordered from
//   name              (required) — Customer name (auto-filled, editable on the client)
//   phoneNumber       (required) — Customer phone (auto-filled, editable on the client)
//   location          (optional) — Customer full address string
//   latitude          (optional) — Customer location latitude
//   longitude         (optional) — Customer location longitude
//   serviceDetail     (optional) — What service/product the customer wants
const parseCoordinate = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
};

const createOrder = asyncHandler(async (req, res) => {
  const {
    businessProfileId,
    name,
    phoneNumber,
    location,
    latitude,
    longitude,
    customerLatitude,
    customerLongitude,
    locationName,
    addressDetails,
    serviceDetail,
  } = req.body || {};

  if (!businessProfileId) {
    return res
      .status(400)
      .json({ status: "error", message: "businessProfileId is required" });
  }
  if (!mongoose.isValidObjectId(businessProfileId)) {
    return res
      .status(400)
      .json({ status: "error", message: "Invalid businessProfileId" });
  }
  if (!name || !String(name).trim()) {
    return res
      .status(400)
      .json({ status: "error", message: "Name is required" });
  }
  if (!phoneNumber || !String(phoneNumber).trim()) {
    return res
      .status(400)
      .json({ status: "error", message: "Phone number is required" });
  }
  // Light client-side format check; the schema enforces E.164 strictly.
  if (!/^\+?[1-9]\d{1,14}$/.test(String(phoneNumber).trim())) {
    return res.status(400).json({
      status: "error",
      message: "Phone number is not in a valid format",
    });
  }

  const parsedLatitude = parseCoordinate(customerLatitude ?? latitude);
  const parsedLongitude = parseCoordinate(customerLongitude ?? longitude);
  const hasLatitude = parsedLatitude !== null;
  const hasLongitude = parsedLongitude !== null;

  if (Number.isNaN(parsedLatitude) || (hasLatitude && (parsedLatitude < -90 || parsedLatitude > 90))) {
    return res.status(400).json({
      status: "error",
      message: "Latitude must be a valid number between -90 and 90",
    });
  }

  if (Number.isNaN(parsedLongitude) || (hasLongitude && (parsedLongitude < -180 || parsedLongitude > 180))) {
    return res.status(400).json({
      status: "error",
      message: "Longitude must be a valid number between -180 and 180",
    });
  }

  if (hasLatitude !== hasLongitude) {
    return res.status(400).json({
      status: "error",
      message: "Latitude and longitude must be provided together",
    });
  }

  // Resolve the business profile + owner. We require it be approved/active so
  // customers can't raise orders against pending or removed listings.
  const profile = await BusinessProfile.findById(businessProfileId).populate(
    "user",
    "_id profile.fullName phoneNumber",
  );
  if (!profile || !profile.isActive) {
    return res
      .status(404)
      .json({ status: "error", message: "Business profile not found" });
  }
  if (profile.status !== "approved") {
    return res.status(400).json({
      status: "error",
      message: "Cannot raise an order on a profile that is not approved",
    });
  }

  // Don't let the business owner order from themselves — that's almost
  // certainly an accident on the client and produces noisy notifications.
  if (profile.user && profile.user._id.toString() === req.user._id.toString()) {
    return res.status(400).json({
      status: "error",
      message: "You cannot raise an order on your own business",
    });
  }

  try {
    const order = await Order.create({
      businessProfile: profile._id,
      businessOwner: profile.user._id,
      customer: req.user._id,
      customerName: String(name).trim(),
      customerPhone: String(phoneNumber).trim(),
      customerLocation: location ? String(location).trim() : "",
      customerLatitude: hasLatitude ? parsedLatitude : null,
      customerLongitude: hasLongitude ? parsedLongitude : null,
      locationName: locationName ? String(locationName).trim() : "",
      addressDetails: addressDetails ? String(addressDetails).trim() : "",
      serviceDetail: serviceDetail ? String(serviceDetail).trim() : "",
    });

    // Best-effort in-app + push notification to the business owner. We do
    // this asynchronously and we don't fail the order if it errors — the
    // order has already been saved at this point and that's the source of
    // truth.
    try {
      const customerDisplayName = String(name).trim() || "A customer";
      const businessName = profile.businessName || "your business";

      const notification = await Notification.create({
        recipient: profile.user._id,
        type: "order_received",
        title: "New Order Received",
        message: `You received a new order for ${businessName} from ${customerDisplayName}`,
        relatedEntityType: "Order",
        relatedEntityId: order._id,
        navigationIdentifier: `order:${order._id}`,
        isRead: false,
      });
      sendPushToUserForNotification(
        notification.recipient,
        notification,
        Device,
      ).catch((err) =>
        console.warn("[FCM] order_received push failed", err && err.message),
      );
    } catch (notifErr) {
      console.error(
        "[Order] Failed to create notification for order",
        order._id,
        notifErr,
      );
    }

    res.status(201).json({
      status: "success",
      message: "Order raised successfully",
      data: { order },
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Failed to raise order",
      error: error.message,
    });
  }
});

// @desc    Get orders received by the authenticated business owner
// @route   GET /api/orders/received
// @access  Private
//
// Returns newest-first orders that belong to any of the caller's business
// profiles. Used by the business-side Orders Screen.
const getReceivedOrders = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;

  try {
    const filter = { businessOwner: req.user._id };

    const orders = await Order.find(filter)
      .populate("businessProfile", "_id businessName images status")
      .populate({
        path: "businessProfile",
        populate: { path: "images", select: "_id url isPrimary" },
        select: "_id businessName images status",
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Order.countDocuments(filter);
    const totalPages = Math.ceil(total / limit) || 0;
    const unreadCount = await Order.countDocuments({
      businessOwner: req.user._id,
      isRead: false,
    });

    res.status(200).json({
      status: "success",
      data: {
        orders,
        unreadCount,
        pagination: {
          currentPage: page,
          totalPages,
          totalOrders: total,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Failed to fetch orders",
      error: error.message,
    });
  }
});

// @desc    Get the unread order count for the current business owner
// @route   GET /api/orders/unread-count
// @access  Private
//
// Powers the badge on the order icon in the header.
const getUnreadOrdersCount = asyncHandler(async (req, res) => {
  try {
    const count = await Order.countDocuments({
      businessOwner: req.user._id,
      isRead: false,
    });
    res.status(200).json({
      status: "success",
      data: { unreadCount: count },
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Failed to fetch unread orders count",
      error: error.message,
    });
  }
});

// @desc    Mark every received order for the current business owner as read
// @route   PUT /api/orders/read-all
// @access  Private
//
// Called when the user opens the Orders Screen — per the spec, the badge
// disappears the moment the screen opens.
const markAllOrdersAsRead = asyncHandler(async (req, res) => {
  try {
    const result = await Order.updateMany(
      { businessOwner: req.user._id, isRead: false },
      { $set: { isRead: true, readAt: new Date() } },
    );

    // Also clear the matching in-app `order_received` notifications so the
    // bell counter stays consistent with the order badge.
    try {
      await Notification.updateMany(
        {
          recipient: req.user._id,
          type: "order_received",
          isRead: false,
        },
        { $set: { isRead: true, readAt: new Date() } },
      );
    } catch (err) {
      // Non-fatal — the order side is the source of truth for the badge.
      console.warn(
        "[Order] Failed to mark order notifications as read",
        err && err.message,
      );
    }

    res.status(200).json({
      status: "success",
      message: "All orders marked as read",
      data: {
        updatedCount: result.modifiedCount || result.nModified || 0,
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Failed to mark orders as read",
      error: error.message,
    });
  }
});

module.exports = {
  createOrder,
  getReceivedOrders,
  getUnreadOrdersCount,
  markAllOrdersAsRead,
};
