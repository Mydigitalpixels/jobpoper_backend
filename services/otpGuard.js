const OtpSendLog = require('../models/OtpSendLog');
const OtpBudget = require('../models/OtpBudget');

/**
 * Server-side OTP spend protection — hardened after the Sep 2026 SMS-pumping
 * incident.
 *
 * Layers (checked in order):
 *
 *   1. E.164 format only — junk numbers never reach Twilio.
 *   2. Country ALLOWLIST (OTP_ALLOWED_COUNTRY_CODES) — if set, only listed
 *      country codes may receive SMS. Falls back to the old blocklist
 *      (OTP_BLOCKED_COUNTRY_CODES) for backward compat.
 *   3. Per-number cooldown (default 60s).
 *   4. Per-number caps (3 / 15 min, 8 / 24 h).
 *   5. Per-IP hourly cap (default 3/hr) — stops phone-rotation from one IP.
 *   6. Per-country hourly cap for non-primary countries (default 5/hr).
 *   7. ATOMIC global hourly + daily cap via OtpBudget (no more TOCTOU race).
 *
 * Call assertCanSendOtp() BEFORE TwilioService.sendVerificationCode().
 * Call logOtpSend() on every outcome, including rejects.
 * Call releaseGlobalBudget(check) if Twilio send fails or the send is aborted
 * after a reservation (already registered, user not found, reused pending).
 */

const E164 = /^\+[1-9]\d{6,14}$/;

// ── Config readers ───────────────────────────────────────────────────────────

const cooldownSeconds = () => {
  const n = Number(process.env.OTP_COOLDOWN_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : 60;
};

const perPhoneWindowMax = () => {
  const n = Number(process.env.OTP_PER_PHONE_WINDOW_MAX);
  return Number.isFinite(n) && n > 0 ? n : 3;
};

const perPhoneDailyMax = () => {
  const n = Number(process.env.OTP_PER_PHONE_DAILY_MAX);
  return Number.isFinite(n) && n > 0 ? n : 8;
};

const globalHourlyCap = () => {
  const n = Number(process.env.OTP_GLOBAL_HOURLY_CAP);
  return Number.isFinite(n) && n > 0 ? n : 15;   // was 80 — lowered after incident
};

const globalDailyCap = () => {
  const n = Number(process.env.OTP_GLOBAL_DAILY_CAP);
  return Number.isFinite(n) && n > 0 ? n : 100;
};

const secondaryCountryHourlyCap = () => {
  const n = Number(process.env.OTP_SECONDARY_COUNTRY_HOURLY);
  return Number.isFinite(n) && n > 0 ? n : 5;
};

const perIpHourlyCap = () => {
  const n = Number(process.env.OTP_PER_IP_HOURLY_CAP);
  return Number.isFinite(n) && n > 0 ? n : 3;
};

const parseCsvEnv = (key) =>
  String(process.env[key] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Countries whose OTP traffic is expected — no per-country throttle. */
const primaryCountryCodes = () => {
  const raw = parseCsvEnv('OTP_PRIMARY_COUNTRY_CODES');
  return (raw.length ? raw : ['92', '91', '55']).map((s) =>
    s.startsWith('+') ? s : `+${s.replace(/\D/g, '')}`
  );
};

/** ALLOWLIST — if non-empty, ONLY these countries may receive SMS. */
const allowedPrefixes = () => {
  const raw = parseCsvEnv('OTP_ALLOWED_COUNTRY_CODES');
  if (!raw.length) return [];  // allowlist not active
  return raw.map((s) => (s.startsWith('+') ? s : `+${s.replace(/\D/g, '')}`));
};

/** BLOCKLIST — backward compat, only checked when allowlist is empty. */
const blockedPrefixes = () => {
  const raw = parseCsvEnv('OTP_BLOCKED_COUNTRY_CODES');
  return raw
    .map((s) => (s.startsWith('+') ? s : `+${s.replace(/\D/g, '')}`))
    .filter((s) => s.length > 1);
};

// ── Helpers ──────────────────────────────────────────────────────────────────

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
 * Best-effort calling-code prefix (not a full libphonenumber parse).
 * Prefer the longest configured prefix (so +420 / +234 stay 3-digit), then
 * fall back to NANP (+1), Kazakhstan/Russia (+7), then 2-digit.
 */
const countryPrefixOf = (e164) => {
  const digits = String(e164 || '').replace(/\D/g, '');
  if (!digits) return '';
  const normalized = `+${digits}`;
  const known = [
    ...new Set([
      ...allowedPrefixes(),
      ...primaryCountryCodes(),
      ...blockedPrefixes(),
    ]),
  ].sort((a, b) => b.length - a.length);
  const hit = known.find((p) => normalized.startsWith(p));
  if (hit) return hit;
  if (digits.startsWith('1') && digits.length >= 11) return '+1';
  if (digits.startsWith('7') && digits.length >= 11) return '+7';
  if (digits.length >= 3) return `+${digits.slice(0, 2)}`;
  return `+${digits}`;
};

/**
 * FIXED: Use req.ip which respects app.set("trust proxy", 1) and picks the
 * LAST untrusted hop — not the first X-Forwarded-For entry which the attacker
 * controls.
 */
const clientIp = (req) => req.ip || req.connection?.remoteAddress || '';

const denial = (status, code, message, extra = {}) => ({
  ok: false,
  status,
  code,
  message,
  ...extra,
});

// ── Alert helper ─────────────────────────────────────────────────────────────
// Loud console.error that ops tools (PM2 logs, CloudWatch, etc.) can alert on.
// Extend this to push Firebase / Slack / email notifications as needed.
const alertAdmin = (tag, data) => {
  console.error(`[OTP-GUARD] *** ALERT *** ${tag}`, JSON.stringify(data));
  // TODO: add Firebase push / email / Slack webhook here for real-time alerts
};

// ── Validation ───────────────────────────────────────────────────────────────

const validateOtpPhoneFormat = (phoneNumber) => {
  const normalized = normalizeOtpPhone(phoneNumber);
  if (!E164.test(normalized)) {
    return denial(
      400,
      'INVALID_PHONE',
      'Please enter a valid phone number with a country code.'
    );
  }

  const prefix = countryPrefixOf(normalized);

  // ALLOWLIST check — if configured, only these countries are allowed
  const allowed = allowedPrefixes();
  if (allowed.length > 0) {
    if (!allowed.some((a) => normalized.startsWith(a))) {
      return denial(
        400,
        'COUNTRY_BLOCKED',
        'SMS to this country is currently unavailable.'
      );
    }
    // Allowlist passed — skip blocklist
    return { ok: true, phoneNumber: normalized, countryPrefix: prefix };
  }

  // BLOCKLIST fallback — only when allowlist is not configured
  const blocked = blockedPrefixes();
  if (blocked.some((b) => normalized.startsWith(b))) {
    return denial(
      400,
      'COUNTRY_BLOCKED',
      'SMS to this country is temporarily unavailable.'
    );
  }

  return { ok: true, phoneNumber: normalized, countryPrefix: prefix };
};

const countSentSince = (filter, since) =>
  OtpSendLog.countDocuments({
    ...filter,
    result: 'sent',
    createdAt: { $gte: since },
  });

// ── Budget bucket IDs ────────────────────────────────────────────────────────
const hourBucket = () => `global:${new Date().toISOString().slice(0, 13)}`;
const dayBucket = () => `global-day:${new Date().toISOString().slice(0, 10)}`;
const countryHourBucket = (prefix) =>
  `country:${prefix}:${new Date().toISOString().slice(0, 13)}`;
const ipHourBucket = (ip) => {
  const safe = String(ip || 'unknown').replace(/[^a-fA-F0-9.:]/g, '_').slice(0, 80);
  return `ip:${safe}:${new Date().toISOString().slice(0, 13)}`;
};

const releaseReservations = async (buckets = []) => {
  for (const id of buckets) {
    try {
      await OtpBudget.release(id);
    } catch (err) {
      console.error('[OTP-GUARD] budget release failed', id, err.message);
    }
  }
};

// ── Main guard ───────────────────────────────────────────────────────────────

/**
 * @param {{ phoneNumber: string, req: import('express').Request, endpoint: string, userId?: string|null }} args
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

  const now = Date.now();
  const reservedBuckets = [];

  // ── Per-number cooldown ──────────────────────────────────────────────────
  const coolSec = cooldownSeconds();
  const lastSent = await OtpSendLog.findOne({
    phoneNumber: normalized,
    result: 'sent',
    createdAt: { $gte: new Date(now - coolSec * 1000) },
  }).sort({ createdAt: -1 }).lean();

  if (lastSent) {
    const elapsed = Math.floor((now - new Date(lastSent.createdAt).getTime()) / 1000);
    const retryAfterSeconds = Math.max(coolSec - elapsed, 1);
    return {
      ...denial(
        429,
        'OTP_COOLDOWN',
        `Please wait ${retryAfterSeconds}s before requesting another code.`
      ),
      retryAfterSeconds,
      phoneNumber: normalized,
      countryPrefix: prefix,
      meta,
    };
  }

  // ── Per-number 15-min window ─────────────────────────────────────────────
  const windowCount = await countSentSince(
    { phoneNumber: normalized },
    new Date(now - 15 * 60 * 1000)
  );
  if (windowCount >= perPhoneWindowMax()) {
    return {
      ...denial(
        429,
        'PHONE_CAPPED',
        'Too many codes sent to this number. Please try again in a few minutes.'
      ),
      phoneNumber: normalized,
      countryPrefix: prefix,
      meta,
    };
  }

  // ── Per-number daily ─────────────────────────────────────────────────────
  const dailyCount = await countSentSince(
    { phoneNumber: normalized },
    new Date(now - 24 * 60 * 60 * 1000)
  );
  if (dailyCount >= perPhoneDailyMax()) {
    return {
      ...denial(
        429,
        'PHONE_CAPPED',
        'Too many codes sent to this number today. Please try again tomorrow.'
      ),
      phoneNumber: normalized,
      countryPrefix: prefix,
      meta,
    };
  }

  // ── Per-IP hourly cap (survives PM2 / multi-process, unlike express-rate-limit)
  const ipCap = perIpHourlyCap();
  const ipBucket = ipHourBucket(meta.ip);
  const ipRes = await OtpBudget.reserve(ipBucket, ipCap, 7200_000);
  if (!ipRes.allowed) {
    alertAdmin('IP_HOURLY_CAP_HIT', {
      ip: meta.ip,
      count: ipRes.count,
      cap: ipCap,
      phone: meta.maskedPhone,
      endpoint,
    });
    return {
      ...denial(
        429,
        'IP_CAPPED',
        'Too many verification requests from this network. Please try again later.'
      ),
      phoneNumber: normalized,
      countryPrefix: prefix,
      meta,
    };
  }
  reservedBuckets.push(ipBucket);

  // ── Per-country hourly cap (non-primary countries only) ──────────────────
  const primary = primaryCountryCodes();
  if (!primary.some((p) => normalized.startsWith(p))) {
    const countryCap = secondaryCountryHourlyCap();
    const countryBucket = countryHourBucket(prefix);
    const countryRes = await OtpBudget.reserve(countryBucket, countryCap, 7200_000);
    if (!countryRes.allowed) {
      await releaseReservations(reservedBuckets);
      alertAdmin('SECONDARY_COUNTRY_CAP_HIT', {
        prefix,
        count: countryRes.count,
        cap: countryCap,
        ip: meta.ip,
        phone: meta.maskedPhone,
        endpoint,
      });
      return {
        ...denial(
          429,
          'COUNTRY_CAPPED',
          'Verification is temporarily unavailable. Please try again later.'
        ),
        phoneNumber: normalized,
        countryPrefix: prefix,
        meta,
      };
    }
    reservedBuckets.push(countryBucket);
  }

  // ── ATOMIC global hourly cap ─────────────────────────────────────────────
  const hCap = globalHourlyCap();
  const hBucket = hourBucket();
  const hourlyRes = await OtpBudget.reserve(hBucket, hCap, 7200_000);
  if (!hourlyRes.allowed) {
    await releaseReservations(reservedBuckets);
    alertAdmin('GLOBAL_HOURLY_CAP_HIT', {
      sentLastHour: hourlyRes.count,
      cap: hCap,
      ip: meta.ip,
      phone: meta.maskedPhone,
      endpoint,
    });
    return {
      ...denial(
        429,
        'OTP_GLOBAL_CAP',
        'Verification is temporarily unavailable. Please try again later.'
      ),
      phoneNumber: normalized,
      countryPrefix: prefix,
      meta,
    };
  }
  reservedBuckets.push(hBucket);

  // ── ATOMIC global daily cap ──────────────────────────────────────────────
  const dCap = globalDailyCap();
  const dBucket = dayBucket();
  const dailyRes = await OtpBudget.reserve(dBucket, dCap, 90_000_000); // ~25 hours
  if (!dailyRes.allowed) {
    await releaseReservations(reservedBuckets);
    alertAdmin('GLOBAL_DAILY_CAP_HIT', {
      sentToday: dailyRes.count,
      cap: dCap,
      ip: meta.ip,
      phone: meta.maskedPhone,
      endpoint,
    });
    return {
      ...denial(
        429,
        'OTP_GLOBAL_CAP',
        'Verification is temporarily unavailable. Please try again later.'
      ),
      phoneNumber: normalized,
      countryPrefix: prefix,
      meta,
    };
  }
  reservedBuckets.push(dBucket);

  return {
    ok: true,
    phoneNumber: normalized,
    countryPrefix: prefix,
    meta,
    reservedBuckets,
  };
};

// ── Budget release (call when Twilio send fails) ─────────────────────────────

const releaseGlobalBudget = async (check) => {
  if (check && Array.isArray(check.reservedBuckets) && check.reservedBuckets.length) {
    await releaseReservations(check.reservedBuckets);
    return;
  }
  await releaseReservations([hourBucket(), dayBucket()]);
};

// ── Logging ──────────────────────────────────────────────────────────────────

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

    // ── Volume alerting ────────────────────────────────────────────────────
    // Alert if more than 10 sends in the last hour (real traffic is 1-2/day).
    const lastHourCount = await countSentSince({}, new Date(Date.now() - 3600_000));
    if (lastHourCount >= 10 && lastHourCount % 5 === 0) {
      alertAdmin('HIGH_VOLUME', {
        sendsLastHour: lastHourCount,
        latestPhone: meta.maskedPhone,
        latestIp: meta.ip,
        endpoint: meta.endpoint,
      });
    }
  } catch (err) {
    console.error('[OTP-GUARD] failed to write audit log', err.message);
  }
};

const resultForDenial = (code) => RESULT_BY_CODE[code] || 'invalid_phone';

module.exports = {
  normalizeOtpPhone,
  validateOtpPhoneFormat,
  assertCanSendOtp,
  logOtpSend,
  releaseGlobalBudget,
  resultForDenial,
  maskPhone,
  clientIp,
};
