/**
 * Blocks actions that require a reachable, verified phone number.
 *
 * The bottom sheet in the app is a UX affordance, not a security control — a
 * modified client can call these endpoints directly — so the same rule is
 * enforced here.
 *
 * ROLLOUT: disabled by default. Deploying this file (and wiring it into routes)
 * is therefore a no-op until you set ENFORCE_PHONE_VERIFICATION=true, which
 * should happen only AFTER:
 *   1. scripts/backfillPhoneVerified.js has run (every existing user is marked
 *      verified, so nobody already using the app is ever blocked), and
 *   2. the new app build is live and stable in the stores.
 *
 * Flipping the env var back to anything other than "true" is the kill switch —
 * it needs a restart, not a redeploy.
 *
 * Deliberately NOT applied to any GET route: browsing tasks, viewing details
 * and reading business listings stay open. Nor to PUT/DELETE — editing or
 * removing something you already created should not be blocked. Creation only.
 */
const isEnforced = () => process.env.ENFORCE_PHONE_VERIFICATION === 'true';

const requirePhoneVerified = (req, res, next) => {
  if (!isEnforced()) return next();

  if (req.user && req.user.isPhoneVerified) return next();

  return res.status(403).json({
    status: 'error',
    code: 'PHONE_NOT_VERIFIED',
    message: 'Please verify your phone number to continue.',
  });
};

module.exports = { requirePhoneVerified, isEnforced };
