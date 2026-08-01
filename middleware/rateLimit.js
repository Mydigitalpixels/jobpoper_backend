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

module.exports = {
  validateLimiter: make(60 * 1000, 10),        // 10 / minute
  completeProfileLimiter: make(60 * 60 * 1000, 5), // 5 / hour
  exportLimiter: make(60 * 60 * 1000, 10),      // 10 / hour
};
