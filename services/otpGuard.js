const OtpSendLog = require('../models/OtpSendLog');
const OtpBudget = require('../models/OtpBudget');

/**
 * Server-side OTP spend protection.
 *
 * Hardened 10 Sep 2026 after the second SMS-pumping incident. What changed and
 * why (see docs/ for the full incident report):
 *
 *   - Country ALLOWLIST (OTP_ALLOWED_COUNTRY_CODES). The blocklist could only
 *     ever be armed after an attack, one country at a time. An allowlist is
 *     closed by default: a country you do not serve costs nothing to refuse.
 *     The blocklist is kept and still applies first.
 *   - Correct calling-code detection. countryPrefixOf() used to slice the
 *     first two digits, so Tanzania (+255) was logged as "+25" and every
 *     3-digit-code country was mis-grouped. Country caps and the abuse report
 *     were both wrong because of it.
 *   - ATOMIC caps via OtpBudget reservations instead of count-then-send. The
 *     old global cap was a race: concurrent requests all read the same
 *     pre-burst count and all passed.
 *   - Per-country hourly cap, so a brand-new pumping target trickles instead
 *     of flooding.
 *   - Per-IP hourly cap (Mongo, multi-process safe) so phone rotation from one
 *     network cannot spend the global budget.
 *   - clientIp() no longer trusts the raw X-Forwarded-For header, which any
 *     client can forge. It uses req.ip, which Express resolves using the
 *     trust-proxy setting in server.js.
 *
 * Call assertCanSendOtp() BEFORE TwilioService.sendVerificationCode().
 * If the send does NOT happen after an ok:true result (Twilio threw, or the
 * controller bailed out), call releaseOtpBudget(check) so the reservation is
 * handed back.
 * Call logOtpSend() on every outcome, including rejects, so the next incident
 * is reconstructable.
 */

const E164 = /^\+[1-9]\d{6,14}$/;

// ── env helpers ───────────────────────────────────────────────────────────────

const num = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const cooldownSeconds = () => num('OTP_COOLDOWN_SECONDS', 90);
const perPhoneWindowMax = () => num('OTP_PER_PHONE_WINDOW_MAX', 3);
const perPhoneDailyMax = () => num('OTP_PER_PHONE_DAILY_MAX', 5);
const globalHourlyCap = () => num('OTP_GLOBAL_HOURLY_CAP', 15);
const globalDailyCap = () => num('OTP_GLOBAL_DAILY_CAP', 120);
const secondaryCountryHourlyCap = () => num('OTP_SECONDARY_COUNTRY_HOURLY', 3);
const perIpHourlyCap = () => num('OTP_PER_IP_HOURLY_CAP', 3);

const parseCodeList = (raw) =>
  String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('+') ? s : `+${s.replace(/\D/g, '')}`))
    .filter((s) => s.length > 1);

const blockedPrefixes = () => parseCodeList(process.env.OTP_BLOCKED_COUNTRY_CODES);
const allowedPrefixes = () => parseCodeList(process.env.OTP_ALLOWED_COUNTRY_CODES);
const primaryPrefixes = () =>
  parseCodeList(process.env.OTP_PRIMARY_COUNTRY_CODES || '92,91,55');

// ── phone helpers ─────────────────────────────────────────────────────────────

const normalizeOtpPhone = (phoneNumber) =>
  String(phoneNumber || '').trim().replace(/[\s\-().]/g, '');

const maskPhone = (phoneNumber) => {
  const raw = String(phoneNumber || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length <= 4) return raw;
  const last4 = digits.slice(-4);
  return `+••• ${last4}`;
};

/**
 * ITU-T E.164 country calling codes. Checked shortest-first, which is correct
 * because no 2- or 3-digit code begins with "1" or "7" (the only 1-digit
 * codes), and no 3-digit code begins with any assigned 2-digit code.
 */
const CALLING_CODES = new Set(
  (
    '1 7 ' +
    '20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 ' +
    '57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98 ' +
    '211 212 213 216 218 220 221 222 223 224 225 226 227 228 229 230 231 232 ' +
    '233 234 235 236 237 238 239 240 241 242 243 244 245 246 247 248 249 250 ' +
    '251 252 253 254 255 256 257 258 260 261 262 263 264 265 266 267 268 269 ' +
    '290 291 297 298 299 350 351 352 353 354 355 356 357 358 359 370 371 372 ' +
    '373 374 375 376 377 378 379 380 381 382 383 385 386 387 389 420 421 423 ' +
    '500 501 502 503 504 505 506 507 508 509 590 591 592 593 594 595 596 597 ' +
    '598 599 670 672 673 674 675 676 677 678 679 680 681 682 683 685 686 687 ' +
    '688 689 690 691 692 800 808 850 852 853 855 856 870 878 880 881 882 883 ' +
    '886 888 960 961 962 963 964 965 966 967 968 970 971 972 973 974 975 976 ' +
    '977 979 992 993 994 995 996 998'
  ).split(/\s+/)
);

/** Real calling-code prefix, e.g. "+255" for Tanzania, "+1" for NANP. */
const countryPrefixOf = (e164) => {
  const digits = String(e164 || '').replace(/\D/g, '');
  if (!digits) return '';
  for (const len of [1, 2, 3]) {
    const candidate = digits.slice(0, len);
    if (candidate.length === len && CALLING_CODES.has(candidate)) {
      return `+${candidate}`;
    }
  }
  return `+${digits.slice(0, 3)}`;
};

/**
 * The caller's IP as resolved by Express using app.set('trust proxy', 1).
 *
 * Do NOT read X-Forwarded-For directly. The API is reachable on
 * http://<host>:3001 without a proxy in front, so any client can send its own
 * X-Forwarded-For and pick the IP that lands in this audit log — which is what
 * made the IP column of the last incident report untrustworthy.
 */
const clientIp = (req) => req.ip || req.connection?.remoteAddress || '';

const ipBucketId = (ip, hour) => {
  const safe = String(ip || 'unknown').replace(/[^a-fA-F0-9.:]/g, '_').slice(0, 80);
  return `ip:${safe}:h:${hour}`;
};

const denial = (status, code, message, extra = {}) => ({
  ok: false,
  status,
  code,
  message,
  ...extra,
});

// ── format / geography ────────────────────────────────────────────────────────

const validateOtpPhoneFormat = (phoneNumber) => {
  const normalized = normalizeOtpPhone(phoneNumber);
  if (!E164.test(normalized)) {
    return denial(
      400,
      'INVALID_PHONE',
      'Please enter a valid phone number with a country code.'
    );
  }

  const blocked = blockedPrefixes();
  if (blocked.some((prefix) => normalized.startsWith(prefix))) {
    return denial(
      400,
      'COUNTRY_BLOCKED',
      'SMS to this country is temporarily unavailable.'
    );
  }

  const allowed = allowedPrefixes();
  if (allowed.length && !allowed.some((prefix) => normalized.startsWith(prefix))) {
    return denial(
      400,
      'COUNTRY_BLOCKED',
      'SMS to this country is temporarily unavailable.'
    );
  }

  return {
    ok: true,
    phoneNumber: normalized,
    countryPrefix: countryPrefixOf(normalized),
  };
};

const countSentSince = (filter, since) =>
  OtpSendLog.countDocuments({
    ...filter,
    result: 'sent',
    createdAt: { $gte: since },
  });

// ── the guard ─────────────────────────────────────────────────────────────────

/**
 * @param {{ phoneNumber: string, req: import('express').Request, endpoint: string, userId?: string|null }} args
 * @returns {Promise<object>} ok:true carries `reservations` — pass the whole
 *          object to releaseOtpBudget() if the send does not happen.
 */
const assertCanSendOtp = async ({ phoneNumber, req, endpoint, userId = null }) => {
  const format = validateOtpPhoneFormat(phoneNumber);
  const normalized = format.ok ? format.phoneNumber : normalizeOtpPhone(phoneNumber);
  const prefix = format.ok ? format.countryPrefix : countryPrefixOf(normalized);

  const meta = {
    phoneNumber: normalized || String(phoneNumber || '').trim(),
    maskedPhone: maskPhone(normalized || phoneNumber),
    countryPrefix: prefix,
    endpoint,
    ip: clientIp(req),
    userAgent: String(req.get('user-agent') || '').slice(0, 300),
    userId: userId || null,
  };

  if (!format.ok) {
    return { ...format, phoneNumber: meta.phoneNumber, countryPrefix: prefix, meta };
  }

  const deny = (status, code, message, extra = {}) => ({
    ...denial(status, code, message, extra),
    phoneNumber: normalized,
    countryPrefix: prefix,
    meta,
  });

  const now = Date.now();

  // ── 1. cheap, non-mutating checks first ────────────────────────────────────
  const coolSec = cooldownSeconds();
  const lastSent = await OtpSendLog.findOne({
    phoneNumber: normalized,
    result: 'sent',
    createdAt: { $gte: new Date(now - coolSec * 1000) },
  })
    .sort({ createdAt: -1 })
    .lean();

  if (lastSent) {
    const elapsed = Math.floor((now - new Date(lastSent.createdAt).getTime()) / 1000);
    const retryAfterSeconds = Math.max(coolSec - elapsed, 1);
    return deny(
      429,
      'OTP_COOLDOWN',
      `Please wait ${retryAfterSeconds}s before requesting another code.`,
      { retryAfterSeconds }
    );
  }

  const windowCount = await countSentSince(
    { phoneNumber: normalized },
    new Date(now - 15 * 60 * 1000)
  );
  if (windowCount >= perPhoneWindowMax()) {
    return deny(
      429,
      'PHONE_CAPPED',
      'Too many codes sent to this number. Please try again in a few minutes.'
    );
  }

  const dailyCount = await countSentSince(
    { phoneNumber: normalized },
    new Date(now - 24 * 60 * 60 * 1000)
  );
  if (dailyCount >= perPhoneDailyMax()) {
    return deny(
      429,
      'PHONE_CAPPED',
      'Too many codes sent to this number today. Please try again tomorrow.'
    );
  }

  // ── 2. atomic reservations — these are what a concurrent burst hits ────────
  const hour = OtpBudget.hourBucket();
  const day = OtpBudget.dayBucket();
  const reservations = [];

  const claim = async (bucketId, cap) => {
    const res = await OtpBudget.reserve(bucketId, cap);
    if (res.ok) reservations.push(bucketId);
    return res;
  };

  const abort = async (status, code, message, logLabel, detail) => {
    await OtpBudget.releaseAll(reservations);
    if (logLabel) console.error(`[OTP-GUARD] ${logLabel}`, { ...detail, endpoint, ip: meta.ip, phone: meta.maskedPhone });
    return deny(status, code, message);
  };

  const ipClaim = await claim(ipBucketId(meta.ip, hour), perIpHourlyCap());
  if (!ipClaim.ok) {
    return abort(
      429,
      'IP_CAPPED',
      'Too many verification requests from this network. Please try again later.',
      'IP HOURLY CAP HIT',
      { count: ipClaim.count, cap: perIpHourlyCap() }
    );
  }

  // Per-number hourly reservation — closes the race the per-phone log counts
  // above cannot close on their own.
  const phoneClaim = await claim(`phone:${normalized}:h:${hour}`, perPhoneWindowMax());
  if (!phoneClaim.ok) {
    return abort(
      429,
      'PHONE_CAPPED',
      'Too many codes sent to this number. Please try again in a few minutes.'
    );
  }

  // Per-country hourly cap for anything outside the primary markets.
  const primary = primaryPrefixes();
  if (!primary.includes(prefix)) {
    const cap = secondaryCountryHourlyCap();
    const countryClaim = await claim(`country:${prefix}:h:${hour}`, cap);
    if (!countryClaim.ok) {
      return abort(
        429,
        'COUNTRY_CAPPED',
        'Verification is temporarily unavailable. Please try again later.',
        'SECONDARY COUNTRY CAP HIT',
        { countryPrefix: prefix, count: countryClaim.count, cap }
      );
    }
  }

  const globalHour = await claim(`global:h:${hour}`, globalHourlyCap());
  if (!globalHour.ok) {
    return abort(
      429,
      'OTP_GLOBAL_CAP',
      'Verification is temporarily unavailable. Please try again later.',
      'GLOBAL HOURLY CAP HIT',
      { count: globalHour.count, cap: globalHourlyCap() }
    );
  }

  const globalDay = await claim(`global:d:${day}`, globalDailyCap());
  if (!globalDay.ok) {
    return abort(
      429,
      'OTP_GLOBAL_CAP',
      'Verification is temporarily unavailable. Please try again later.',
      'GLOBAL DAILY CAP HIT',
      { count: globalDay.count, cap: globalDailyCap() }
    );
  }

  return {
    ok: true,
    phoneNumber: normalized,
    countryPrefix: prefix,
    meta,
    reservations,
  };
};

/**
 * Hand budget back when an ok:true check did NOT result in a Twilio send —
 * Twilio threw, or the controller bailed out (already registered, not found).
 * Safe to call more than once; it clears the list.
 */
const releaseOtpBudget = async (check) => {
  if (!check || !Array.isArray(check.reservations) || !check.reservations.length) return;
  const ids = check.reservations;
  check.reservations = [];
  await OtpBudget.releaseAll(ids);
};

const RESULT_BY_CODE = {
  INVALID_PHONE: 'invalid_phone',
  COUNTRY_BLOCKED: 'country_blocked',
  COUNTRY_CAPPED: 'country_capped',
  OTP_COOLDOWN: 'cooldown',
  PHONE_CAPPED: 'phone_capped',
  IP_CAPPED: 'ip_capped',
  OTP_GLOBAL_CAP: 'global_capped',
};

const logOtpSend = async ({
  meta,
  result,
  twilioSid = '',
  errorCode = '',
  errorMessage = '',
}) => {
  try {
    await OtpSendLog.create({
      phoneNumber: meta.phoneNumber,
      maskedPhone: meta.maskedPhone,
      countryPrefix: meta.countryPrefix,
      endpoint: meta.endpoint,
      result,
      ip: meta.ip,
      userAgent: meta.userAgent,
      userId: meta.userId,
      twilioSid: twilioSid || '',
      errorCode: errorCode || '',
      errorMessage: String(errorMessage || '').slice(0, 300),
    });
  } catch (err) {
    console.error('[OTP-GUARD] failed to write audit log', err.message);
  }
};

const resultForDenial = (code) => RESULT_BY_CODE[code] || 'invalid_phone';

module.exports = {
  normalizeOtpPhone,
  validateOtpPhoneFormat,
  assertCanSendOtp,
  releaseOtpBudget,
  logOtpSend,
  resultForDenial,
  maskPhone,
  clientIp,
  countryPrefixOf,
};
