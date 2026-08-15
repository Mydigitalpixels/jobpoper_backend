const OtpSendLog = require('../models/OtpSendLog');

/**
 * Server-side OTP spend protection.
 *
 * The app is worldwide, so there is NO default country allowlist. Protection
 * is rate / shape / budget based:
 *
 *   1. E.164 format only — junk numbers never reach Twilio.
 *   2. Optional OTP_BLOCKED_COUNTRY_CODES — empty by default; fill later if
 *      a specific country shows up in a pumping attack.
 *   3. Per-number cooldown (default 60s) — stops "same wrong number, many times".
 *   4. Per-number caps (3 / 15 min, 8 / 24 h).
 *   5. Global hourly cap (default 80 successful sends) — circuit breaker so
 *      a rotating-IP bot cannot empty the Twilio balance overnight.
 *
 * Call assertCanSendOtp() BEFORE TwilioService.sendVerificationCode().
 * Call logOtpSend() on every outcome, including rejects, so the next incident
 * is reconstructable.
 */

const E164 = /^\+[1-9]\d{6,14}$/;

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
  return Number.isFinite(n) && n > 0 ? n : 80;
};

const blockedPrefixes = () =>
  String(process.env.OTP_BLOCKED_COUNTRY_CODES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('+') ? s : `+${s.replace(/\D/g, '')}`))
    .filter((s) => s.length > 1);

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
 * Best-effort calling-code prefix for grouping logs (not a full libphonenumber
 * parse). 1-digit NANP, then 2, then 3.
 */
const countryPrefixOf = (e164) => {
  const digits = String(e164 || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('1') && digits.length >= 11) return '+1';
  if (digits.length >= 3) return `+${digits.slice(0, 2)}`;
  return `+${digits}`;
};

const clientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || '';
};

const denial = (status, code, message, extra = {}) => ({
  ok: false,
  status,
  code,
  message,
  ...extra,
});

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

  return { ok: true, phoneNumber: normalized, countryPrefix: countryPrefixOf(normalized) };
};

const countSentSince = (filter, since) =>
  OtpSendLog.countDocuments({
    ...filter,
    result: 'sent',
    createdAt: { $gte: since },
  });

/**
 * @param {{ phoneNumber: string, req: import('express').Request, endpoint: string, userId?: string|null }} args
 * @returns {Promise<{ ok: true, phoneNumber: string, countryPrefix: string, meta: object } | { ok: false, status: number, code: string, message: string, phoneNumber: string, countryPrefix: string, meta: object, retryAfterSeconds?: number }>}
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

  const hourlyGlobal = await countSentSince({}, new Date(now - 60 * 60 * 1000));
  const cap = globalHourlyCap();
  if (hourlyGlobal >= cap) {
    console.error('[OTP-GUARD] GLOBAL HOURLY CAP HIT', {
      sentLastHour: hourlyGlobal,
      cap,
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

  return { ok: true, phoneNumber: normalized, countryPrefix: prefix, meta };
};

const RESULT_BY_CODE = {
  INVALID_PHONE: 'invalid_phone',
  COUNTRY_BLOCKED: 'country_blocked',
  OTP_COOLDOWN: 'cooldown',
  PHONE_CAPPED: 'phone_capped',
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
  logOtpSend,
  resultForDenial,
  maskPhone,
  clientIp,
};
