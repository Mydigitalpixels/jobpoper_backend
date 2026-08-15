/**
 * Print OTP send activity for the last 24 hours.
 *
 * Usage (on the server, from the backend folder):
 *   node scripts/otpAbuseReport.js
 *   node scripts/otpAbuseReport.js --hours 48
 *
 * Use this after a Twilio spend spike to see which countries, IPs and
 * numbers were hit. Data comes from OtpSendLog (kept 90 days).
 */

require('dotenv').config();
const mongoose = require('mongoose');
const OtpSendLog = require('../models/OtpSendLog');

const hoursArg = process.argv.find((a) => a.startsWith('--hours='));
const HOURS = hoursArg ? Number(hoursArg.split('=')[1]) : 24;

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

  const tally = (list, key) => {
    const map = new Map();
    for (const row of list) {
      const k = row[key] || '(empty)';
      map.set(k, (map.get(k) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  };

  console.log(`[otp-report] last ${HOURS}h — ${rows.length} attempts, ${sent.length} Twilio sends`);
  console.log('\nBy result:');
  tally(rows, 'result').forEach(([k, n]) => console.log(`  ${n}\t${k}`));

  console.log('\nSends by country prefix:');
  tally(sent, 'countryPrefix').forEach(([k, n]) => console.log(`  ${n}\t${k}`));

  console.log('\nSends by IP:');
  tally(sent, 'ip').forEach(([k, n]) => console.log(`  ${n}\t${k}`));

  console.log('\nSends by number:');
  tally(sent, 'phoneNumber').forEach(([k, n]) => console.log(`  ${n}\t${k}`));

  console.log('\nSends by endpoint:');
  tally(sent, 'endpoint').forEach(([k, n]) => console.log(`  ${n}\t${k}`));

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('[otp-report] failed:', err);
  process.exit(1);
});
