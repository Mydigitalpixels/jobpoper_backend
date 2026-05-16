# JobPoper Push Notifications — Production Diagnosis

**Date:** 2026-05-16  
**Scope:** Why production builds (App Store + Play Store) don't get push notifications even though local/dev builds work.

---

## TL;DR — Most likely root causes, ranked

| # | Cause | Where to look | Likelihood |
|---|---|---|---|
| 1 | **Backend is still using the *exposed/disabled* Firebase service-account key** | Server env `FIREBASE_SERVICE_ACCOUNT_PATH` / `FIREBASE_SERVICE_ACCOUNT` | **VERY HIGH** |
| 2 | **APNs Authentication Key (.p8) not uploaded to Firebase Console** | Firebase Console → Project Settings → Cloud Messaging → Apple app | **VERY HIGH (iOS only)** |
| 3 | **`aps-environment` was `development` when the App Store IPA was built** | `ios/JobPopper/JobPopper.entitlements` at build time | **HIGH (iOS only)** |
| 4 | **Production app never POSTs its FCM token to `/devices`** | `GET /api/devices/me` from the prod app session | HIGH |
| 5 | **Backend `FCM_*` not reachable / channel/icon missing on prod** | Server logs `[FCM] …` lines | MEDIUM |
| 6 | Duplicate Firebase Android app (`com.anonymous.jobpoper` lowercase) | `firebase/google-services.json` | LOW (cosmetic) |

The fact that "**simulator-creates-order → physical Play Store app receives it**" works tells us **Android FCM delivery is healthy** for that one device — so the wiring is at least partially correct. The remaining failures are almost entirely **iOS-side** plus **token-registration** problems on the published build.

---

## Evidence from your codebase

### A. Backend — `services/pushNotificationService.js`

Sends with `firebase-admin` → `messaging.send({ token, notification, data, android, apns })`. So:

- **Android pushes** go straight through FCM.
- **iOS pushes** go FCM → APNs (Firebase relays via the APNs auth key you upload to the console).

The send loop already deactivates stale tokens on `messaging/registration-token-not-registered` etc., and logs to stdout under `[FCM]`. **All your debugging answers are in those logs** — see "How to confirm in 5 minutes" below.

### B. App — `src/services/devices/deviceService.ts`

iOS flow:

1. `requestPermission`
2. `registerDeviceForRemoteMessages`
3. **Wait up to 15 s for the APNs device token** (`waitForApnsToken`)
4. If APNs token never arrives → **`return ""`** (skip register, no push possible)
5. Otherwise `getToken` (FCM exchange)
6. POST to `/devices` with token

This is the right flow, **but it has one strict rule**: if APNs returns nothing in 15 s, the prod app simply skips registering and the backend never gets a token. There is **no log surfaced to the user** — only to Metro/Xcode console which you can't see on a Play Store/TestFlight build.

The warning string from your own code spells out the iOS reasons:

```
• Wrong aps-environment for the build
• App ID missing 'Push Notifications' capability in Apple Developer
• No network access from the Mac to APNs
```

The first one is the most common in your situation.

### C. Firebase Console screenshot you sent

Two findings:

1. **iOS app** `com.appcrafters.jobpoper` matches `ios/JobPopper.entitlements` ✓ and `app.json` ios.bundleIdentifier ✓.

2. **Service account `firebase-adminsdk-fbsvc@jobpoper.iam.gserviceaccount.com` Keys page** shows:

   | Status | Disable reason | Key | Created |
   |---|---|---|---|
   | **Disabled** | **Exposed** | `3c2bebee…3087cb07` | Apr 25, 2026 |
   | **Active** | — | `35e96255…ee1bd9` | May 15, 2026 (yesterday) |

   Google auto-disabled the old key because it was leaked publicly. **If the production server is still loading that old key, `messaging.send()` will fail with an auth error for every push.** Local-only "works because you regenerated key locally / use a different creds path" is exactly the pattern your symptoms describe.

### D. `app.config.js` — APNs environment is computed at prebuild time

```js
const APS_ENVIRONMENT = (() => {
  const explicit = process.env.APS_ENVIRONMENT;
  if (explicit === "production" || explicit === "development") return explicit;
  if (process.env.NODE_ENV === "production" || process.env.EAS_BUILD_PROFILE === "production") {
    return "production";
  }
  return "development";
})();
```

`ios/JobPopper/JobPopper.entitlements` *currently* reads `production`, which is correct for App Store. But **every time you `npx expo prebuild` locally without `APS_ENVIRONMENT=production` (or with `NODE_ENV !== "production"`), that file gets overwritten to `development`**. If even one of your archived/uploaded builds was created from such a tree, that App Store IPA can't receive APNs pushes.

### E. Android — duplicate Firebase app entries

`firebase/google-services.json` contains **two** Android client entries:

- `com.anonymous.Jobpoper` (capital J) — matches your real `applicationId` in `android/app/build.gradle:92` ✓
- `com.anonymous.jobpoper` (lowercase) — orphan / unused

Not breaking, but worth deleting the lowercase one in Firebase Console for cleanliness. Mixed-case Android package names are unusual (convention is all-lowercase) but Android does allow them.

---

## Re-reading your "creating-time" scenario

> "I run the app on simulator locally and create order then on my mobile already downloaded app from Play Store and logged in and I receive push notification on my mobile."

This is actually **good news**:

- Simulator (= local dev customer) → posts `/orders`
- Backend creates `Notification`, calls `sendPushToUserForNotification(businessOwnerId, …)`
- Owner's physical Android phone is registered (it ran the Play Store build at least once and got POST'd to `/devices` successfully)
- FCM → Android push → delivered ✓

So the **Android delivery pipeline is alive**. The "production not working" symptom is therefore almost certainly one or more of:

1. **iOS** prod builds never get an APNs token, so they never register, so no push is ever delivered to them (causes #2 and #3 above).
2. **iOS or Android** prod builds register *initially* but the token rotates and the new token never reaches the backend (e.g. user is offline at the moment `onTokenRefresh` fires and the retry path doesn't fire later) — but your code handles this with `onTokenRefresh` + delayed retry, so this is less likely.
3. **Some kinds of pushes** silently fail in production because the server's service-account key is the exposed/disabled one (cause #1).

---

## How to confirm in 5 minutes

Do these in order — each step rules out one cause.

### Step 1 — Confirm the backend's service-account key is the new one

On the production server:

```bash
node -e "
const sa = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
  ? require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH)
  : JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT.indexOf('{')===0
        ? process.env.FIREBASE_SERVICE_ACCOUNT
        : Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT,'base64').toString()
    );
console.log('private_key_id =', sa.private_key_id);
console.log('client_email   =', sa.client_email);
"
```

`private_key_id` must equal **`35e96255b35fe9d52981b5fb1fd3d5c5f0ee1bd9`** (the active row in your screenshot), **not** `3c2bebee2b9cf92d71fd15388abb928d3087cb07` (the disabled one).

If it's the disabled one → regenerate (Firebase Console → Project Settings → Service accounts → Generate new private key), update the env var on your production host, restart `node`.

### Step 2 — Confirm APNs is wired in Firebase Console (iOS)

In Firebase Console → ⚙ Project Settings → **Cloud Messaging** tab → scroll to the iOS app block (`com.appcrafters.jobpoper`):

- "**Apple app configuration**" must show an **APNs Authentication Key** with a Key ID and Team ID. **`RG3W7PC39V`** must match what you see there (from your Xcode signing screenshot).
- If you only have legacy APNs Certificates, you need **both** Development AND Production uploaded — otherwise production tokens silently drop. A single **.p8 key** is the strongly preferred modern path and covers both environments.

If this is missing → in Apple Developer (developer.apple.com) → Keys → "+" → name it, tick "Apple Push Notifications service (APNs)", download the **`.p8`**, note the **Key ID** and your **Team ID** (`RG3W7PC39V`), then upload all three into Firebase Console.

### Step 3 — Confirm `aps-environment` in your last App Store build

For an installed TestFlight/App Store build, the IPA's entitlements need `aps-environment = production`. From the `.ipa`:

```bash
unzip -p YourApp.ipa Payload/JobPopper.app/embedded.mobileprovision \
  | security cms -D \
  | plutil -p - \
  | grep -E "aps-environment|application-identifier"
```

If it says `development` → next App Store build must be produced with `EAS_BUILD_PROFILE=production` (or `APS_ENVIRONMENT=production`) so the `app.config.js` block writes the right entitlement, and **after** that, prebuild + archive again.

For EAS builds, your `eas.json` should have:

```jsonc
{
  "build": {
    "production": {
      "env": { "APS_ENVIRONMENT": "production" },
      "ios": { "buildConfiguration": "Release" }
    }
  }
}
```

(I didn't find an `eas.json` in your repo — if you're using EAS, add it; otherwise make sure your local Xcode archive is run after `APS_ENVIRONMENT=production npx expo prebuild --clean`.)

### Step 4 — Ask the production app what token it actually registered

Log in on the published build, then from any HTTP client (or `curl` with the same bearer token):

```
GET https://<your-api>/api/devices/me
```

For the device row created by the prod-built app, you want to see:

```json
{ "platform": "iOS", "isActive": true, "tokenPresent": true, "tokenLen": ~140-180 }
```

If `tokenPresent: false` or the row doesn't exist → the app on that device couldn't get an FCM token. **Almost always the APNs entitlement or the Firebase APNs key issue (Step 2/3).**

### Step 5 — Fire a test push at that device

Still logged in on the production phone (so the auth header maps to the right user):

```
POST https://<your-api>/api/devices/test-push
Body: { "title": "test", "body": "hello", "includeInactive": true }
```

Then tail the backend logs and look for:

- `[FCM] Sending push:` with `tokens: 1, tokenPreviews: [...]` — good, attempt made
- `[FCM] ✓ send OK` — FCM accepted it (Android usually arrives in <5 s; iOS needs APNs configured)
- `[FCM] ✗ send FAILED` with `code: messaging/...` — gives you the exact reason. The codes worth knowing:
  - `messaging/registration-token-not-registered` → token belongs to a now-uninstalled app, or APNs rejected it (often the prod-vs-dev mismatch in Step 3)
  - `messaging/invalid-registration-token` / `messaging/invalid-argument` → corrupted token
  - `messaging/third-party-auth-error` → **classic "APNs key/cert missing or wrong in Firebase Console"** — this is the smoking gun for cause #2
  - `messaging/internal-error` → transient, retry

### Step 6 — If you see no `[FCM]` logs at all

Then `initAdmin()` short-circuited. Look earlier in the boot log for one of:

- `[FCM] firebase-admin not installed` → `npm install firebase-admin` on the server, redeploy
- `[FCM] No credentials. Set FIREBASE_SERVICE_ACCOUNT_PATH …` → env not set on the production host
- `[FCM] Invalid FIREBASE_SERVICE_ACCOUNT: …` → key JSON malformed (or base64 with bad padding)

---

## What I'd actually do, in order

1. **Verify and rotate the service-account key on the prod server** (Step 1 above). This is the single highest-probability fix given the "Exposed" row in your screenshot.
2. **Upload the APNs `.p8` key into Firebase Console** for `com.appcrafters.jobpoper`. Without this, iOS will never receive push from FCM regardless of how clean the rest of the code is.
3. **Rebuild iOS with `APS_ENVIRONMENT=production`** (clean prebuild, then archive/EAS). Re-upload to TestFlight. Install fresh, log in, then run Step 4 (`/api/devices/me`) and confirm the token row exists.
4. **Run `POST /api/devices/test-push`** on a known prod-installed device and watch backend logs. The `code:` in the failure entry tells you *exactly* what's wrong if anything still is.
5. Delete the lowercase `com.anonymous.jobpoper` Android app from Firebase Console (cosmetic, not urgent).

---

## What you may be "missing" overall

Mostly process/infrastructure rather than code. The Expo + RNFB + firebase-admin code in your repo looks correctly wired. The gaps that produce exactly the symptoms you described are:

- **No APNs `.p8` in Firebase Console** (or wrong Key ID / Team ID) — iOS prod will never work
- **Rotated service-account key not propagated to the production host** — pushes server-side silently fail
- **No CI/EAS guarantee that prod IPAs always have `aps-environment=production`** — easy to ship a release with the wrong entitlement
- **No alerting on the `[FCM] SKIP send — …` or `messaging/third-party-auth-error` log lines** — the system is failing quietly. Adding a simple Sentry/Slack alert for any non-success counter from `sendPushToUserForNotification` would have caught this within minutes of first occurrence.

Once Steps 1–3 above are done and Step 5 returns success, your pushes will start arriving on production builds.
