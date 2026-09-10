/**
 * OTP send activity report — run this after any Twilio spend spike.
 *
 * Usage (on the server, from the backend folder):
 *   node scripts/otpAbuseReport.js
 *   node scripts/otpAbuseReport.js --hours=48
 *   node scripts/otpAbuseReport.js --hours=72 --numbers      # full numbers
 *
 * Data comes from OtpSendLog (kept 90 days).
 *
 * NOTE ON THE IP COLUMN: before 10 Sep 2026 the guard recorded the first
 * X-Forwarded-For entry, which any client can forge. IPs logged before that
 * date are not evidence. From 10 Sep onward the column is req.ip as resolved
 * by Express, which is trustworthy as long as TRUST_PROXY stays off while the
 * API is exposed directly.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const OtpSendLog = require('../models/OtpSendLog');

const argOf = (name, fallback = '') => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const HOURS = Number(argOf('hours', '24')) || 24;
const SHOW_NUMBERS = process.argv.includes('--numbers');

const pad = (s, n) => String(s).padEnd(n);

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('[otp-report] MONGODB_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const since = new Date(Date.now() - HOURS * 60 * 60 * 1000);

  const rows = await OtpSendLog.find({ createdAt: { $gte: since } }).lean();
  const sent = rows.filter((r) => r.result === 'sent');

  const tally = (list, key, limit = 20) => {
    const map = new Map();
    for (const row of list) {
      const k = row[key] || '(empty)';
      map.set(k, (map.get(k) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  };

  console.log(`\n[otp-report] window: last ${HOURS}h (since ${since.toISOString()})`);
  console.log(`[otp-report] ${rows.length} attempts, ${sent.length} billed Twilio sends\n`);

  console.log('By result:');
  tally(rows, 'result').forEach(([k, n]) => console.log(`  ${pad(n, 6)}${k}`));

  console.log('\nBilled sends by country:');
  tally(sent, 'countryPrefix').forEach(([k, n]) => console.log(`  ${pad(n, 6)}${k}`));

  console.log('\nAll attempts by country (includes the ones the guard refused):');
  tally(rows, 'countryPrefix').forEach(([k, n]) => {
    const billed = sent.filter((r) => r.countryPrefix === k).length;
    console.log(`  ${pad(n, 6)}${pad(k, 8)}(${billed} billed, ${n - billed} refused)`);
  });

  console.log('\nBilled sends by endpoint:');
  tally(sent, 'endpoint').forEach(([k, n]) => console.log(`  ${pad(n, 6)}${k}`));

  console.log('\nBilled sends by IP:');
  tally(sent, 'ip').forEach(([k, n]) => console.log(`  ${pad(n, 6)}${k}`));

  console.log('\nBilled sends by user agent:');
  tally(sent, 'userAgent', 10).forEach(([k, n]) => console.log(`  ${pad(n, 6)}${k.slice(0, 90)}`));

  console.log(`\nBilled sends by number${SHOW_NUMBERS ? '' : ' (masked — pass --numbers for full)'}:`);
  tally(sent, SHOW_NUMBERS ? 'phoneNumber' : 'maskedPhone', 40)
    .forEach(([k, n]) => console.log(`  ${pad(n, 6)}${k}`));

  // ── hourly histogram: an attack is a spike, not a slope ────────────────────
  console.log('\nHourly shape (billed sends):');
  const byHour = new Map();
  for (const r of sent) {
    const h = new Date(r.createdAt).toISOString().slice(0, 13);
    byHour.set(h, (byHour.get(h) || 0) + 1);
  }
  const hours = [...byHour.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const peak = Math.max(1, ...hours.map(([, n]) => n));
  hours.forEach(([h, n]) =>
    console.log(`  ${h}Z  ${pad(n, 5)}${'█'.repeat(Math.round((n / peak) * 50))}`)
  );

  // ── burst detection ───────────────────────────────────────────────────────
  const stamps = sent.map((r) => new Date(r.createdAt).getTime()).sort((a, b) => a - b);
  let worst = 0;
  let worstAt = null;
  for (let i = 0; i < stamps.length; i++) {
    let j = i;
    while (j < stamps.length && stamps[j] - stamps[i] <= 10_000) j++;
    if (j - i > worst) { worst = j - i; worstAt = stamps[i]; }
  }
  if (worstAt) {
    console.log(
      `\nTightest burst: ${worst} billed sends within 10 seconds, starting ` +
      `${new Date(worstAt).toISOString()}`
    );
    if (worst >= 5) {
      console.log('  ^ that is scripted traffic. Humans do not do this.');
    }
  }

  // ── the pumping signature ─────────────────────────────────────────────────
  const nonPrimary = sent.filter(
    (r) => !['+92', '+91', '+55'].includes(r.countryPrefix)
  );
  if (nonPrimary.length) {
    console.log(
      `\nWARNING: ${nonPrimary.length} billed send(s) to countries outside PK/IN/BR. ` +
      'In both prior incidents that was the entire attack.'
    );
    const codes = [...new Set(nonPrimary.map((r) => r.countryPrefix))];
    console.log(`  countries: ${codes.join(', ')}`);
    console.log(`  block them:  OTP_BLOCKED_COUNTRY_CODES=${codes.map((c) => c.replace('+', '')).join(',')}`);
    console.log(`  purge them:  node scripts/purgeOtpAbusers.js --countries=${codes.map((c) => c.replace('+', '')).join(',')}`);
  }

  console.log('');
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('[otp-report] failed:', err);
  process.exit(1);
});
