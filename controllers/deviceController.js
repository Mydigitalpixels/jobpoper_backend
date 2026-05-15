const asyncHandler = require("express-async-handler");
const Device = require("../models/Device");

// @desc    Register or update device (FCM token) for current user
// @route   POST /api/devices
// @access  Private
const registerDevice = asyncHandler(async (req, res) => {
  const { deviceId, deviceName, platform, osVersion, appVersion, pushNotificationToken } =
    req.body;

  if (!deviceId) {
    return res.status(400).json({ status: "error", message: "deviceId is required" });
  }

  const token =
    pushNotificationToken && pushNotificationToken !== "pending"
      ? String(pushNotificationToken)
      : "";
  if (token && token.length > 500) {
    return res.status(400).json({ status: "error", message: "pushNotificationToken too long" });
  }

  // CROSS-ACCOUNT FIX: when a fresh login happens on a physical device, any rows
  // for the SAME deviceId belonging to OTHER users must be set isActive:false so
  // pushes targeted at those previous users don't continue routing to this device.
  // We also strip the token from those rows so the recipient query (which filters
  // by non-empty token) no longer matches them — Firebase Console messages won't
  // suddenly resurrect a logged-out account either.
  const otherUsersResult = await Device.updateMany(
    { deviceId: String(deviceId), user: { $ne: req.user._id } },
    { $set: { isActive: false, pushNotificationToken: "" } },
  );
  if (otherUsersResult.modifiedCount) {
    console.log(
      "[DEVICES] Deactivated",
      otherUsersResult.modifiedCount,
      "previous user(s) on deviceId",
      String(deviceId),
      "for current user",
      req.user._id.toString(),
    );
  }

  const updated = await Device.findOneAndUpdate(
    { user: req.user._id, deviceId: String(deviceId) },
    {
      $set: {
        user: req.user._id,
        deviceId: String(deviceId),
        deviceName: (deviceName || "Unknown device").toString().slice(0, 200),
        platform: (platform || "Unknown").toString().slice(0, 20),
        osVersion: (osVersion || "").toString().slice(0, 50),
        appVersion: (appVersion || "").toString().slice(0, 30),
        pushNotificationToken: token,
        isActive: true,
      },
    },
    { upsert: true, new: true, runValidators: true },
  );

  console.log("[DEVICES] Registered/updated device:", {
    user: req.user._id.toString(),
    deviceId: String(deviceId),
    platform: updated?.platform,
    tokenPresent: !!token,
    tokenLen: token.length,
    tokenTail: token ? token.slice(-8) : null,
    isActive: updated?.isActive,
  });

  res.json({ status: "success", message: "Device registered" });
});

// @desc    Unregister a device (logout) — by client deviceId
// @route   DELETE /api/devices/:deviceId
// @access  Private
// Note: Keep pushNotificationToken so FCM can still reach this physical device for
// account-specific pushes (e.g. verification_review) after the user logs out. Rows stay
// isActive: false so routine pushes (jobs, etc.) still target only active sessions.
const unregisterDevice = asyncHandler(async (req, res) => {
  const { deviceId } = req.params;
  await Device.updateOne(
    { user: req.user._id, deviceId: String(deviceId) },
    { $set: { isActive: false } },
  );
  res.json({ status: "success", message: "Device unregistered" });
});

module.exports = { registerDevice, unregisterDevice };
