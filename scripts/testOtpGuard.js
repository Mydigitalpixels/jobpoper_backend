/**
 * Offline behavioural test for services/otpGuard.js.
 *
 * Stubs OtpSendLog and OtpBudget in the require cache, so it needs no MongoDB
 * connection and can be run anywhere, including on the production box before a
 * restart:
 *
 *   node scripts/testOtpGuard.js
 *
 * The important case is #3: 40 simultaneous requests must produce exactly
 * OTP_GLOBAL_HOURLY_CAP sends. Under the old count-then-send guard all 40 read
 * the same pre-burst count and all 40 passed — that is the 05 Sep incident.
 */
const path = require('path');
const Module = require('module');

const BASE = path.join(__dirname, '..');
const logPath = require.resolve(path.join(BASE, 'models/OtpSendLog.js'));
const budgetPath = require.resolve(path.join(BASE, 'models/OtpBudget.js'));

// ── stub OtpSendLog ─────────────────────────────────────────────────────────
const sendLog = [];
const fakeLog = {
  countDocuments: async () => 0,
  findOne: () => ({ sort: () => ({ lean: async () => null }) }),
  create: async (doc) => { sendLog.push(doc); return doc; },
};
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: fakeLog };

// ── stub OtpBudget with a real in-memory atomic counter ─────────────────────
const buckets = new Map();
const fakeBudget = {
  reserve: async (id, cap) => {
    const count = (buckets.get(id) || 0) + 1;
    buckets.set(id, count);
    return { ok: count <= cap, count };
  },
  release: async (id) => buckets.set(id, (buckets.get(id) || 0) - 1),
  releaseAll: async (ids) => { for (const i of ids) buckets.set(i, (buckets.get(i) || 0) - 1); },
  hourBucket: () => '2026-09-09T20',
  dayBucket: () => '2026-09-09',
};
require.cache[budgetPath] = { id: budgetPath, filename: budgetPath, loaded: true, exports: fakeBudget };

const guard = require(path.join(BASE, 'services/otpGuard.js'));

const req = (ip = '1.2.3.4', xff = null) => ({
  ip,
  connection: { remoteAddress: ip },
  headers: xff ? { 'x-forwarded-for': xff } : {},
  get: () => 'attack-bot/1.0',
});

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

(async () => {
  console.log('\n1. Country allowlist');
  process.env.OTP_ALLOWED_COUNTRY_CODES = '92,91,55';
  process.env.OTP_BLOCKED_COUNTRY_CODES = '255';
  process.env.OTP_PRIMARY_COUNTRY_CODES = '92,91,55';
  process.env.OTP_GLOBAL_HOURLY_CAP = '15';
  process.env.OTP_GLOBAL_DAILY_CAP = '120';
  process.env.OTP_SECONDARY_COUNTRY_HOURLY = '3';
  process.env.OTP_PER_IP_HOURLY_CAP = '100';

  let r = await guard.assertCanSendOtp({ phoneNumber: '+255703123456', req: req(), endpoint: 'phone-send-otp' });
  check('Tanzania is refused', r.ok === false && r.code === 'COUNTRY_BLOCKED', JSON.stringify(r.code));

  r = await guard.assertCanSendOtp({ phoneNumber: '+8801712345678', req: req(), endpoint: 'phone-send-otp' });
  check('a country not on the allowlist is refused', r.ok === false && r.code === 'COUNTRY_BLOCKED', JSON.stringify(r.code));

  r = await guard.assertCanSendOtp({ phoneNumber: '+923001234567', req: req(), endpoint: 'phone-send-otp' });
  check('Pakistan is allowed', r.ok === true, JSON.stringify(r.code));
  check('country prefix logged correctly for PK', r.countryPrefix === '+92', r.countryPrefix);

  r = await guard.assertCanSendOtp({ phoneNumber: 'not-a-number', req: req(), endpoint: 'phone-send-otp' });
  check('junk input is refused before Twilio', r.ok === false && r.code === 'INVALID_PHONE');

  console.log('\n2. IP is no longer attacker-controlled');
  const spoofed = req('9.9.9.9', '203.0.113.7, 198.51.100.4');
  r = await guard.assertCanSendOtp({ phoneNumber: '+923001111111', req: spoofed, endpoint: 'phone-send-otp' });
  check('audit log records req.ip, not the forged X-Forwarded-For',
    r.meta.ip === '9.9.9.9', r.meta.ip);

  console.log('\n3. Global hourly cap under a concurrent burst (the 05 Sep shape)');
  buckets.clear();
  const burst = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      guard.assertCanSendOtp({ phoneNumber: `+9230012${String(i).padStart(5, '0')}`, req: req(), endpoint: 'phone-send-otp' })
    )
  );
  const allowed = burst.filter((x) => x.ok).length;
  check(`40 simultaneous requests -> exactly 15 allowed (got ${allowed})`, allowed === 15);

  console.log('\n4. Per-country cap for a non-primary market');
  buckets.clear();
  process.env.OTP_ALLOWED_COUNTRY_CODES = '92,91,55,255';   // pretend TZ is opened
  process.env.OTP_BLOCKED_COUNTRY_CODES = '';
  const tz = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      guard.assertCanSendOtp({ phoneNumber: `+2557031234${String(i).padStart(2, '0')}`, req: req(), endpoint: 'phone-send-otp' })
    )
  );
  const tzAllowed = tz.filter((x) => x.ok).length;
  check(`12 requests to a non-primary country -> only 3 allowed (got ${tzAllowed})`, tzAllowed === 3);
  check('the refusal is COUNTRY_CAPPED', tz.some((x) => x.code === 'COUNTRY_CAPPED'));

  console.log('\n5. Reservations are returned when the send does not happen');
  buckets.clear();
  const ok = await guard.assertCanSendOtp({ phoneNumber: '+923009999999', req: req(), endpoint: 'phone-send-otp' });
  const before = buckets.get('global:h:2026-09-09T20');
  await guard.releaseOtpBudget(ok);
  const after = buckets.get('global:h:2026-09-09T20');
  check(`budget handed back on a failed send (${before} -> ${after})`, before === 1 && after === 0);
  await guard.releaseOtpBudget(ok);
  check('release is idempotent', buckets.get('global:h:2026-09-09T20') === 0);

  console.log('\n6. A denial does not silently consume budget');
  buckets.clear();
  process.env.OTP_ALLOWED_COUNTRY_CODES = '92';
  await guard.assertCanSendOtp({ phoneNumber: '+919999999999', req: req(), endpoint: 'phone-send-otp' });
  check('a refused country leaves the global bucket untouched',
    (buckets.get('global:h:2026-09-09T20') || 0) === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
