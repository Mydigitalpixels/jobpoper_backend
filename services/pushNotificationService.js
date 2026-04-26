const path = require("path");
const fs = require("fs");
let admin = null;
let _initialized = false;
let _initErrorLogged = false;

/**
 * FCM for Android and iOS via Firebase Admin (same project as client apps).
 * Set GOOGLE_APPLICATION_CREDENTIALS to a service account JSON path, or
 * FIREBASE_SERVICE_ACCOUNT (inline JSON string) for production secrets.
 */
function getAndroidChannelId(type) {
  const t = (type || "").toString().toLowerCase();
  if (t === "job_created" || t === "job_interest" || t === "verification_review")
    return "jobpoper_jobs";
  return "jobpoper_default";
}

function initAdmin() {
  if (_initialized) return admin;
  _initialized = true;
  try {
    admin = require("firebase-admin");
  } catch (e) {
    if (!_initErrorLogged) {
      _initErrorLogged = true;
      console.warn(
        "[FCM] firebase-admin not installed. Run: npm install firebase-admin in jobpoper_backend",
      );
    }
    return null;
  }
  if (admin.apps.length) {
    return admin;
  }
  const jsonPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const jsonInline = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (jsonInline) {
    try {
      const creds = JSON.parse(
        jsonInline.indexOf("{") === 0
          ? jsonInline
          : Buffer.from(jsonInline, "base64").toString("utf8"),
      );
      admin.initializeApp({ credential: admin.credential.cert(creds) });
    } catch (e) {
      if (!_initErrorLogged) {
        _initErrorLogged = true;
        console.warn("[FCM] Invalid FIREBASE_SERVICE_ACCOUNT:", e.message);
      }
      return null;
    }
  } else if (jsonPath && fs.existsSync(path.resolve(jsonPath))) {
    const abs = path.resolve(jsonPath);
    const creds = require(abs);
    admin.initializeApp({ credential: admin.credential.cert(creds) });
  } else {
    if (!_initErrorLogged) {
      _initErrorLogged = true;
      console.warn(
        "[FCM] No credentials. Set FIREBASE_SERVICE_ACCOUNT_PATH to service account JSON or FIREBASE_SERVICE_ACCOUNT (base64 or JSON). Push disabled until configured.",
      );
    }
    return null;
  }
  return admin;
}

/**
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @param {{ _id: import('mongoose').Types.ObjectId, title: string, message: string, type: string, navigationIdentifier?: string, relatedEntityId?: any }} notification
 * @param {import('mongoose').Model} DeviceModel
 */
async function sendPushToUserForNotification(
  userId,
  notification,
  Device = require("../models/Device"),
) {
  const a = initAdmin();
  if (!a) return { sent: 0, skipped: true };
  const nid = notification._id ? notification._id.toString() : String(notification._id);
  const data = {
    notificationId: nid,
    type: String(notification.type || "system"),
    title: String(notification.title || ""),
    body: String(notification.message || ""),
  };
  if (notification.navigationIdentifier) {
    data.navigationIdentifier = String(notification.navigationIdentifier);
  }
  if (notification.relatedEntityId) {
    data.relatedEntityId = String(notification.relatedEntityId);
  }
  if (notification.relatedEntityType) {
    data.relatedEntityType = String(notification.relatedEntityType);
  }

  const devices = await Device.find({
    user: userId,
    isActive: true,
    pushNotificationToken: { $exists: true, $ne: "" },
  }).lean();

  const valid = devices
    .map((d) => d.pushNotificationToken)
    .filter(
      (t) =>
        t &&
        t !== "pending" &&
        typeof t === "string" &&
        t.length > 10,
    );
  if (!valid.length) {
    return { sent: 0, skipped: true, reason: "no_tokens" };
  }

  const channelId = getAndroidChannelId(notification.type);
  const messaging = a.messaging();
  let success = 0;
  for (const token of valid) {
    try {
      await messaging.send({
        token,
        notification: {
          title: notification.title,
          body: notification.message,
        },
        data: Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, v == null ? "" : String(v)]),
        ),
        android: {
          priority: "high",
          notification: { channelId, sound: "default" },
        },
        apns: {
          payload: {
            aps: { sound: "default", badge: 1 },
          },
        },
      });
      success++;
    } catch (err) {
      const code = err?.code || err?.errorInfo?.code;
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token" ||
        code === "messaging/invalid-argument"
      ) {
        await Device.updateMany(
          { pushNotificationToken: token },
          { isActive: false, pushNotificationToken: "" },
        );
      }
      console.warn(
        "[FCM] send failed for token …",
        (err && err.message) || err,
      );
    }
  }
  return { sent: success, skipped: false };
}

module.exports = {
  sendPushToUserForNotification,
  getAndroidChannelId,
};
