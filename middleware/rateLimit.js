/**
 * Per-account rate limiters for the referral feature.
 *
 * Uses `express-rate-limit` (single Node process → default in-memory store is
 * fine). If the package is not yet installed, this module degrades to a no-op
 * so the server still boots — run `npm install express-rate-limit` to enable.
 */
let rateLimit = null;
try {
  rateLimit = require('express-rate-limit');
} catch (_) {
  console.warn(
    '[rateLimit] express-rate-limit not installed — referral rate limiting is DISABLED. ' +
    'Run `npm install express-rate-limit` to enable it.'
  );
}

const noop = (req, res, next) => next();

// Key by authenticated user id (falls back to IP for unauthenticated paths).
const keyByUser = (req) => (req.user && String(req.user._id)) || req.ip;

const make = (windowMs, max) => {
  if (!rateLimit) return noop;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: keyByUser,
    handler: (req, res) =>
      res.status(429).json({
        status: 'error',
        code: 'RATE_LIMITED',
        message: 'Too many attempts. Please try again in a minute.',
      }),
  });
};

// Key by IP only — for public (unauthenticated) endpoints where req.user is
// never set and keyByUser would collapse every caller onto the same bucket.
const makeByIp = (windowMs, max) => {
  if (!rateLimit) return noop;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) =>
      res.status(429).json({
        status: 'error',
        code: 'RATE_LIMITED',
        message: 'Too many attempts. Please try again in a few minutes.',
      }),
  });
};

// Key by destination phone number + IP — so a new user ID does NOT reset the
// counter. This is the fix for the SMS-pumping amplifier: the attacker can
// mint unlimited user IDs, but they cannot rotate their IP *and* phone at the
// same time without real cost.
const keyByPhoneAndIp = (req) => {
  const phone = (req.user && req.user.phoneNumber) || req.body?.phoneNumber || '';
  return `${phone}|${req.ip}`;
};

const makeByPhoneAndIp = (windowMs, max) => {
  if (!rateLimit) return noop;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: keyByPhoneAndIp,
    handler: (req, res) =>
      res.status(429).json({
        status: 'error',
        code: 'RATE_LIMITED',
        message: 'Too many attempts. Please try again in a few minutes.',
      }),
  });
};

module.exports = {
  validateLimiter: make(60 * 1000, 10),        // 10 / minute
  completeProfileLimiter: make(60 * 60 * 1000, 5), // 5 / hour
  exportLimiter: make(60 * 60 * 1000, 10),      // 10 / hour

  // Registration — the amplifier that made the attack possible. Without this,
  // an attacker mints unlimited accounts and each gets a fresh rate-limit bucket.
  registerLimiter: makeByIp(60 * 60 * 1000, 3), // 3 registrations / hour / IP
  loginLimiter: makeByIp(15 * 60 * 1000, 8),    // 8 logins / 15 min / IP

  // Cheap flood brake for every /auth request (login, me, OTP, profile).
  // OTP send routes have tighter limiters on top of this.
  authTrafficLimiter: makeByIp(10 * 60 * 1000, 120), // 120 / 10 min / IP

  // Hard IP cap on SMS-triggering routes, regardless of how many phones/accounts
  // share that IP. Complements otpSendLimiter (phone+IP) and the Mongo OTP_PER_IP cap.
  otpIpLimiter: makeByIp(60 * 60 * 1000, 3), // 3 OTP sends / hour / IP

  // In-app phone verification. Keyed by phone+IP so creating a new account
  // does NOT reset the counter (the old user-ID key was the core bug).
  otpSendLimiter: makeByPhoneAndIp(15 * 60 * 1000, 3), // 3 sends / 15 min / phone+IP
  otpVerifyLimiter: make(15 * 60 * 1000, 10),   // 10 checks / 15 min / user

  // Legacy public OTP endpoints (still used by app builds <= 1.4.5).
  // Tightened from 5/15min to 2/hour — these routes have near-zero legitimate
  // traffic from the current app version.
  publicOtpLimiter: makeByIp(60 * 60 * 1000, 2), // 2 / hour / IP
};
