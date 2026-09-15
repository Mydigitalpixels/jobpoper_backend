/**
 * Rate limiters.
 *
 * Uses `express-rate-limit` (single Node process → default in-memory store is
 * fine). If the package is not yet installed, this module degrades to a no-op
 * so the server still boots — run `npm install express-rate-limit` to enable.
 *
 * ── READ THIS BEFORE TRUSTING ANY IP-KEYED LIMIT ────────────────────────────
 * Every limiter below that keys on req.ip is only as trustworthy as
 * app.set('trust proxy', ...) in server.js. If trust proxy is enabled while
 * the API is ALSO reachable directly (today the mobile app calls
 * http://<host>:3001 with no proxy in front), a client can send its own
 * X-Forwarded-For header and Express will believe it — one forged header per
 * request means an unlimited number of distinct "IPs" and no IP limit at all.
 * Keep TRUST_PROXY off until nginx/TLS terminates in front of Node and port
 * 3001 is firewalled off.
 * ─────────────────────────────────────────────────────────────────────────────
 */
let rateLimit = null;
try {
  rateLimit = require('express-rate-limit');
} catch (_) {
  console.warn(
    '[rateLimit] express-rate-limit not installed — rate limiting is DISABLED. ' +
    'Run `npm install express-rate-limit` to enable it.'
  );
}

const noop = (req, res, next) => next();

/**
 * Stable key for an IP. IPv6 is collapsed to its /64 network, otherwise a
 * single attacker with one IPv6 allocation gets billions of distinct keys.
 */
const ipKey = (req) => {
  const ip = String(req.ip || req.connection?.remoteAddress || 'unknown');
  if (ip.includes(':')) {
    const clean = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    if (!clean.includes(':')) return clean;
    return clean.split(':').slice(0, 4).join(':') + '::/64';
  }
  return ip;
};

// Key by authenticated user id (falls back to IP for unauthenticated paths).
const keyByUser = (req) => (req.user && String(req.user._id)) || ipKey(req);

/**
 * Key by the DESTINATION phone number plus the caller IP.
 *
 * This is the fix for the 05 Sep / 09 Sep incidents. The OTP send limiter used
 * to key on req.user._id, but POST /auth/register mints a fresh user id for
 * any phone number with no verification — so "3 sends per user" reset on every
 * single number the attacker pumped. Keying on the number being billed means
 * a new account buys the attacker nothing.
 */
const keyByPhoneAndIp = (req) => {
  const phone = String(
    (req.user && req.user.phoneNumber) || (req.body && req.body.phoneNumber) || ''
  ).trim().replace(/[\s\-().]/g, '');
  return `${phone || 'nophone'}|${ipKey(req)}`;
};

const build = (windowMs, max, keyGenerator, message) => {
  if (!rateLimit) return noop;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    // We supply our own keyGenerator (and normalise IPv6 ourselves), so the
    // library's built-in IP validators have nothing useful to say here.
    validate: { ip: false, xForwardedForHeader: false, trustProxy: false },
    handler: (req, res) =>
      res.status(429).json({
        status: 'error',
        code: 'RATE_LIMITED',
        message: message || 'Too many attempts. Please try again in a minute.',
      }),
  });
};

const make = (windowMs, max) => build(windowMs, max, keyByUser);
const makeByIp = (windowMs, max, message) =>
  build(windowMs, max, ipKey, message || 'Too many attempts. Please try again in a few minutes.');
const makeByPhoneAndIp = (windowMs, max, message) =>
  build(windowMs, max, keyByPhoneAndIp, message);

module.exports = {
  validateLimiter: make(60 * 1000, 10),            // 10 / minute / user
  completeProfileLimiter: make(60 * 60 * 1000, 5), // 5 / hour / user
  exportLimiter: make(60 * 60 * 1000, 10),         // 10 / hour / user

  // Cheap flood brake for every /auth request (login, me, OTP, profile).
  // OTP send routes have tighter limiters on top of this.
  authTrafficLimiter: makeByIp(10 * 60 * 1000, 120, 'Too many requests. Please try again later.'),

  // Hard IP cap on SMS-triggering routes, regardless of how many phones/accounts
  // share that IP. Complements otpSendLimiter (phone+IP) and the Mongo OTP_PER_IP cap.
  otpIpLimiter: makeByIp(
    60 * 60 * 1000,
    3,
    'Too many codes requested. Please try again later.'
  ),

  // In-app phone verification. Each send costs money.
  // KEYED ON THE DESTINATION NUMBER, not the user id — see keyByPhoneAndIp.
  otpSendLimiter: makeByPhoneAndIp(
    15 * 60 * 1000,
    3,
    'Too many codes requested. Please try again in a few minutes.'
  ),
  otpVerifyLimiter: make(15 * 60 * 1000, 10),      // 10 checks / 15 min / user

  // Legacy public OTP endpoints (still used by app builds <= 1.4.5).
  // Keyed on destination number + IP so a proxy rotation does not reset it.
  publicOtpLimiter: makeByPhoneAndIp(
    15 * 60 * 1000,
    3,
    'Too many codes requested. Please try again in a few minutes.'
  ),

  // /auth/register was public, unlimited and returned a JWT for any phone
  // number with no verification. That token was then spent on one Twilio SMS.
  // Registration is a once-per-person event; 3/hour/IP is generous for real
  // users and fatal to the register -> send-otp loop.
  registerLimiter: makeByIp(
    60 * 60 * 1000,
    3,
    'Too many sign-up attempts. Please try again later.'
  ),

  // /auth/check-phone is an unauthenticated account-enumeration oracle.
  checkPhoneLimiter: makeByIp(
    60 * 60 * 1000,
    20,
    'Too many requests. Please try again later.'
  ),

  // Brute-forcing a 4-digit PIN takes 10,000 tries. Slow it down.
  loginLimiter: makeByPhoneAndIp(
    15 * 60 * 1000,
    10,
    'Too many login attempts. Please try again in a few minutes.'
  ),
};
