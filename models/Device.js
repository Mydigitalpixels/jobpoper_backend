const mongoose = require("mongoose");

const deviceSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    deviceId: {
      type: String,
      required: [true, "Device id is required"],
      trim: true,
    },
    deviceName: { type: String, default: "" },
    platform: { type: String, default: "Android" },
    osVersion: { type: String, default: "" },
    appVersion: { type: String, default: "" },
    pushNotificationToken: {
      type: String,
      default: "",
      maxlength: 500,
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

deviceSchema.index({ user: 1, deviceId: 1 }, { unique: true });

module.exports = mongoose.model("Device", deviceSchema);
