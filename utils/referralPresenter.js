/**
 * Shared helpers for presenting referred users to clients.
 *
 * Two projections of the same underlying document:
 *   - buildReferredUser()  -> peer-facing, contact details MASKED
 *   - buildAdminReferredUser() -> admin-facing, contact details in full
 *
 * Both derive a non-sensitive `accountStatus` label from identity verification
 * (`verified` | `not_verified`) and NEVER expose the raw isActive flag, the
 * PIN hash or any verification document path.
 */

// verified | not_verified — based on identity verification, not account block.
const deriveAccountStatus = (user) => {
  return user.isVerified === true ? 'verified' : 'not_verified';
};

// a•••••a@example.com — keep first & last local char and the full domain.
const maskEmail = (email) => {
  if (!email || typeof email !== 'string') return null;
  const at = email.indexOf('@');
  if (at < 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) {
    return `${local[0]}•${domain}`;
  }
  const middle = '•'.repeat(Math.max(3, local.length - 2));
  return `${local[0]}${middle}${local[local.length - 1]}${domain}`;
};

// +91 98••••3210 — keep a leading country prefix and the last four digits.
const maskPhone = (phone) => {
  if (!phone || typeof phone !== 'string') return null;
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.length < 6) return '•'.repeat(digits.length);
  const last4 = digits.slice(-4);
  const head = digits.slice(0, Math.min(3, digits.length - 4));
  return `${head}${'•'.repeat(4)}${last4}`;
};

// Peer-facing referred user (masked). Used by GET /referrals/my-referrals.
const buildReferredUser = (user) => ({
  id: user._id,
  fullName: (user.profile && user.profile.fullName) || 'MakeMy Task user',
  profileImage: (user.profile && user.profile.profileImage) || null,
  email: maskEmail(user.profile && user.profile.email),
  phoneNumber: maskPhone(user.phoneNumber),
  registeredAt: user.createdAt || null,
  accountStatus: deriveAccountStatus(user),
  isVerified: user.isVerified === true,
});

// Admin-facing referred user (unmasked).
const buildAdminReferredUser = (user) => ({
  id: user._id,
  fullName: (user.profile && user.profile.fullName) || '',
  profileImage: (user.profile && user.profile.profileImage) || null,
  email: (user.profile && user.profile.email) || '',
  phoneNumber: user.phoneNumber || '',
  registeredAt: user.createdAt || null,
  accountStatus: deriveAccountStatus(user),
  isVerified: user.isVerified === true,
  isProfessional: !!user.isProfessional,
});

// The exact whitelist every referred-user query must select. Never the whole
// document — that would leak PIN hashes and verification document paths.
const REFERRED_USER_SELECT =
  '_id profile.fullName profile.email profile.profileImage profile.isProfileComplete phoneNumber isActive isVerified isProfessional createdAt';

module.exports = {
  deriveAccountStatus,
  maskEmail,
  maskPhone,
  buildReferredUser,
  buildAdminReferredUser,
  REFERRED_USER_SELECT,
};
