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

module.exports = {
  validateLimiter: make(60 * 1000, 10),        // 10 / minute
  completeProfileLimiter: make(60 * 60 * 1000, 5), // 5 / hour
  exportLimiter: make(60 * 60 * 1000, 10),      // 10 / hour

  // In-app phone verification. Each send costs money, so it is the tighter of
  // the two. 3 per 15 min pairs with the client's 60s resend countdown: the
  // user can legitimately resend twice, then must wait.
  otpSendLimiter: make(15 * 60 * 1000, 3),      // 3 sends / 15 min / user
  otpVerifyLimiter: make(15 * 60 * 1000, 10),   // 10 checks / 15 min / user

  // Legacy public OTP endpoints (still used by app builds <= 1.4.5) had no
  // throttling at all. Keyed by IP since there is no authenticated user.
  publicOtpLimiter: makeByIp(15 * 60 * 1000, 5),
};
