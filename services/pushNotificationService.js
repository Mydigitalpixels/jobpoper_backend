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
  if (
    t === "job_created" ||
    t === "job_interest" ||
    t === "verification_review" ||
    t === "business_profile_review" ||
    t === "order_received"
  )
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
 * Mask a token for logs — we never want full tokens in CloudWatch / Sentry.
 */
function maskToken(t) {
  if (!t || typeof t !== "string") return "(empty)";
  if (t.length <= 12) return t;
  return `${t.slice(0, 6)}…${t.slice(-6)}(len=${t.length})`;
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
  const userIdStr = userId && userId.toString ? userId.toString() : String(userId);
  const nid = notification?._id
    ? notification._id.toString()
    : String(notification?._id);
  const notifyType = String(notification?.type || "");
  const logCtx = {
    userId: userIdStr,
    notificationId: nid,
    type: notifyType,
    title: notification?.title,
  };

  const a = initAdmin();
  if (!a) {
    console.warn("[FCM] SKIP send — firebase-admin not initialised.", logCtx);
    return { sent: 0, skipped: true, reason: "admin_not_initialised" };
  }

  const data = {
    notificationId: nid,
    type: notifyType || "system",
    title: String(notification?.title || ""),
    body: String(notification?.message || ""),
  };
  if (notification?.navigationIdentifier) {
    data.navigationIdentifier = String(notification.navigationIdentifier);
  }
  if (notification?.relatedEntityId) {
    data.relatedEntityId = String(notification.relatedEntityId);
  }
  if (notification?.relatedEntityType) {
    data.relatedEntityType = String(notification.relatedEntityType);
  }

  const deviceQuery = {
    user: userId,
    pushNotificationToken: { $exists: true, $ne: "" },
  };
  // Logged-out devices stay isActive:false but keep token so verification (and similar)
  // can still notify the correct account on a shared physical device.
  if (notifyType !== "verification_review") {
    deviceQuery.isActive = true;
  }

  const devices = await Device.find(deviceQuery).lean();
  console.log("[FCM] Recipient lookup:", {
    ...logCtx,
    deviceMatches: devices.length,
    filter: notifyType !== "verification_review" ? "isActive:true" : "any",
  });

  if (!devices.length) {
    // Diagnostics: show what we DID find for this user, regardless of token state, so the
    // operator can immediately tell whether the user has no device at all vs. has one with
    // an empty token vs. has one with isActive:false.
    const allForUser = await Device.find({ user: userId })
      .select("deviceId platform isActive pushNotificationToken updatedAt")
      .lean();
    console.warn("[FCM] SKIP send — no matching device rows.", {
      ...logCtx,
      reason: "no_devices",
      anyRowsForUser: allForUser.length,
      rowsForUser: allForUser.map((d) => ({
        deviceId: d.deviceId,
        platform: d.platform,
        isActive: d.isActive,
        tokenLen: (d.pushNotificationToken || "").length,
        updatedAt: d.updatedAt,
      })),
    });
    return { sent: 0, skipped: true, reason: "no_devices" };
  }

  const valid = [
    ...new Set(
      devices
        .map((d) => d.pushNotificationToken)
        .filter(
          (t) =>
            t &&
            t !== "pending" &&
            typeof t === "string" &&
            t.length > 10,
        ),
    ),
  ];
  if (!valid.length) {
    console.warn("[FCM] SKIP send — devices found but no usable tokens.", {
      ...logCtx,
      deviceMatches: devices.length,
      tokens: devices.map((d) => maskToken(d.pushNotificationToken)),
    });
    return { sent: 0, skipped: true, reason: "no_tokens" };
  }

  const channelId = getAndroidChannelId(notification.type);
  const messaging = a.messaging();

  console.log("[FCM] Sending push:", {
    ...logCtx,
    channelId,
    tokens: valid.length,
    tokenPreviews: valid.map(maskToken),
  });

  const startedAt = Date.now();
  const results = [];
  let success = 0;
  let failure = 0;
  const failureCodes = {};

  for (const token of valid) {
    const sendStartedAt = Date.now();
    try {
      const messageId = await messaging.send({
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
          ttl: 60 * 60 * 1000, // 1 hour — drop if device is offline that long
          notification: {
            channelId,
            sound: "default",
            defaultSound: true,
            defaultVibrateTimings: true,
            notificationPriority: "PRIORITY_HIGH",
          },
        },
        apns: {
          headers: {
            "apns-priority": "10",
            "apns-push-type": "alert",
          },
          payload: {
            aps: {
              alert: {
                title: notification.title,
                body: notification.message,
              },
              sound: "default",
              badge: 1,
              "mutable-content": 1,
              "content-available": 1,
            },
          },
        },
      });
      success++;
      const tookMs = Date.now() - sendStartedAt;
      const entry = {
        ok: true,
        tokenTail: maskToken(token),
        messageId,
        tookMs,
      };
      results.push(entry);
      console.log("[FCM] ✓ send OK", { ...logCtx, ...entry });
    } catch (err) {
      failure++;
      const code = err?.code || err?.errorInfo?.code || "unknown";
      failureCodes[code] = (failureCodes[code] || 0) + 1;
      const tookMs = Date.now() - sendStartedAt;
      const entry = {
        ok: false,
        tokenTail: maskToken(token),
        code,
        message: (err && err.message) || String(err),
        details: err?.errorInfo || null,
        tookMs,
      };
      results.push(entry);
      console.warn("[FCM] ✗ send FAILED", { ...logCtx, ...entry });

      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token" ||
        code === "messaging/invalid-argument"
      ) {
        const upd = await Device.updateMany(
          { pushNotificationToken: token },
          { isActive: false, pushNotificationToken: "" },
        );
        console.warn("[FCM] Pruned stale token:", {
          tokenTail: maskToken(token),
          modified: upd?.modifiedCount,
          code,
        });
      }
    }
  }

  console.log("[FCM] Send summary:", {
    ...logCtx,
    tokens: valid.length,
    success,
    failure,
    failureCodes,
    totalMs: Date.now() - startedAt,
  });

  return {
    sent: success,
    failed: failure,
    skipped: false,
    tokens: valid.length,
    failureCodes,
    results,
  };
}

module.exports = {
  sendPushToUserForNotification,
  getAndroidChannelId,
};
