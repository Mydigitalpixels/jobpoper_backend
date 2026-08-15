const twilio = require("twilio");
const PhoneVerification = require("../models/PhoneVerification");

// Lazy initialization of Twilio client
let client = null;
let clientInitialized = false;

function getTwilioClient() {
  if (!clientInitialized) {
    clientInitialized = true;
    if (
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_ACCOUNT_SID.startsWith("AC")
    ) {
      client = twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN,
      );
      console.log("✅ Twilio client initialized successfully");
    } else {
      console.log(
        "⚠️  Twilio client NOT initialized - missing credentials or invalid SID",
      );
    }
  }
  return client;
}

const TEST_OTP = "000000";
const TEST_PHONE_NUMBER = "+923204099356";

// SECURITY: this used to default to ENABLED, which meant the hardcoded OTP
// "000000" verified ANY phone number in production (ALLOW_TEST_OTP was never
// set, so the old `=== "false"` check never matched). Phone verification is now
// the trust gate for posting tasks and revealing contact details, so the test
// bypass is opt-in AND can never be switched on in production.
function isProduction() {
  return process.env.NODE_ENV === "production";
}

function isTestOtpEnabled() {
  if (isProduction()) return false;
  return process.env.ALLOW_TEST_OTP === "true";
}

// The designated test phone previously bypassed verification even when test OTP
// was disabled. It is now subject to the same production guard.
function isTestPhone(normalizedPhone) {
  return !isProduction() && normalizedPhone === TEST_PHONE_NUMBER;
}

class TwilioService {
  // Generate a 6-digit verification code
  static generateVerificationCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  // Send SMS verification code using Twilio Verify
  static async sendVerificationCode(phoneNumber) {
    try {
      const { validateOtpPhoneFormat, normalizeOtpPhone } = require("./otpGuard");
      const format = validateOtpPhoneFormat(phoneNumber);
      if (!format.ok) {
        throw new Error(format.message);
      }
      const normalizedPhone = format.phoneNumber || normalizeOtpPhone(phoneNumber);

      // Special test phone, or ALLOW_TEST_OTP: skip Twilio and use hardcoded code.
      // Both are hard-disabled when NODE_ENV === "production".
      if (isTestPhone(normalizedPhone) || isTestOtpEnabled()) {
        const verificationCode = TEST_OTP;
        console.log(
          `🔐 Test OTP Override - Use verification code: ${verificationCode} for ${phoneNumber}`,
        );

        const twilioSid = isTestPhone(normalizedPhone)
          ? "test-phone-override"
          : "test-otp-mode";

        const verification = new PhoneVerification({
          phoneNumber,
          verificationCode,
          twilioSid,
        });

        await verification.save();

        return {
          success: true,
          message: "Verification code generated (test mode)",
          twilioSid,
          verificationCode,
        };
      }

      const client = getTwilioClient();
      const twilioUnconfigured =
        !client ||
        !process.env.TWILIO_SERVICE_ID ||
        process.env.TWILIO_SERVICE_ID === "your-verify-service-id";

      // In production, a missing/placeholder Twilio config must be a loud
      // failure. Silently minting a hardcoded 000000 code would hand out
      // "verified" status to anyone — and verification now gates task posting
      // and contact details, not just signup.
      if (twilioUnconfigured && isProduction()) {
        throw new Error(
          "SMS verification is temporarily unavailable. Please try again later.",
        );
      }

      // Check if Twilio is configured and not a trial account
      if (twilioUnconfigured) {
        // For development/testing without Twilio - use hardcoded test code
        const verificationCode = TEST_OTP;
        console.log(
          `🔐 Development Mode - Use verification code: ${verificationCode} for ${phoneNumber}`,
        );

        // Save verification record to database
        const verification = new PhoneVerification({
          phoneNumber,
          verificationCode,
          twilioSid: "dev-mode",
        });

        await verification.save();

        return {
          success: true,
          message: "Verification code generated (development mode)",
          twilioSid: "dev-mode",
          verificationCode, // Return the hardcoded test code
        };
      }

      // Use Twilio Verify service.
      // Do NOT pass customFriendlyName — that requires Twilio's paid
      // "Custom Company Name" feature (error 60204 if enabled without approval).
      // Set the SMS brand in Twilio Console → Verify → Service → Friendly Name
      // (e.g. "MakeMy Task") instead.
      const verification = await client.verify.v2
        .services(process.env.TWILIO_SERVICE_ID)
        .verifications.create({
          to: normalizedPhone,
          channel: "sms",
        });

      // Save verification record to database (without code since Twilio handles it)
      const verificationRecord = new PhoneVerification({
        phoneNumber: normalizedPhone,
        verificationCode: "twilio-verify", // Placeholder since Twilio handles the code
        twilioSid: verification.sid,
      });

      await verificationRecord.save();

      return {
        success: true,
        message: "Verification code sent successfully via Twilio Verify",
        twilioSid: verification.sid,
      };
    } catch (error) {
      // Log detailed error information for debugging
      console.error("❌ Twilio Verify Error Details:");
      console.error("  Error Code:", error.code);
      console.error("  Error Message:", error.message);
      console.error("  More Info:", error.moreInfo);
      console.error("  Status:", error.status);
      console.error("  Phone Number:", phoneNumber);
      console.error("  Full Error:", error);

      // Known scenarios to fallback to manual/dev mode:
      // 21608: Trial account - unverified recipient
      // 60200: Invalid parameter `To`
      // 21211: Invalid 'To' phone number
      // 21408: Permission to send an SMS has not been enabled for the region indicated by the 'To' number
      const fallbackErrorCodes = new Set([21608, 60200, 21211, 21408]);

      // Never fall back to a hardcoded code in production. Doing so would let
      // anyone whose number trips one of these Twilio errors (invalid number,
      // unsupported region) verify with 000000 — i.e. mark an unreachable
      // number as "verified" and then post tasks and pull contact details.
      // In production these surface as a normal failure the client can retry.
      if (fallbackErrorCodes.has(error.code) && !isProduction()) {
        console.log(
          "🔄 Falling back to development mode for Twilio limitation or invalid number",
        );

        // Use hardcoded test code for easy testing
        const verificationCode = "000000";
        console.log(
          `🔐 Test Mode - Use verification code: ${verificationCode} for ${phoneNumber}`,
        );

        // Save verification record to database using hardcoded test code
        const verification = new PhoneVerification({
          phoneNumber,
          verificationCode,
          twilioSid: `test-fallback-${error.code || "unknown"}`,
        });

        await verification.save();

        return {
          success: true,
          message: "Verification code generated (test mode)",
          twilioSid: `test-fallback-${error.code || "unknown"}`,
          verificationCode, // Return the hardcoded test code
        };
      }

      // Throw a more detailed error message
      const errorMessage = error.message || "Failed to send verification code";
      const errorDetails = error.code ? ` (Twilio Error ${error.code})` : "";
      throw new Error(`${errorMessage}${errorDetails}`);
    }
  }

  // Verify the code entered by user
  static async verifyCode(phoneNumber, enteredCode) {
    try {
      const normalizedPhone = (phoneNumber || "").trim();

      // ── Test OTP bypass ────────────────────────────────────────────────────
      // Opt-in only (ALLOW_TEST_OTP=true) and never available in production.
      // The designated test phone is subject to the same production guard.
      const allowTestOtp =
        enteredCode === TEST_OTP &&
        (isTestPhone(normalizedPhone) || isTestOtpEnabled());

      if (allowTestOtp) {
        console.log(`🔐 Test OTP bypass: accepting ${TEST_OTP} for ${phoneNumber}`);

        let record = await PhoneVerification.findOne({
          phoneNumber,
          isVerified: false,
        }).sort({ createdAt: -1 });

        if (record) {
          await record.markAsVerified();
        } else {
          record = new PhoneVerification({
            phoneNumber,
            verificationCode: TEST_OTP,
            twilioSid: "test-otp-bypass",
            isVerified: true,
          });
          await record.save();
        }

        return { success: true, message: "Phone number verified successfully" };
      }
      // ──────────────────────────────────────────────────────────────────────

      // If there is a recent manual verification (fallback/dev), prefer manual verification path
      const latestPending = await PhoneVerification.findOne({
        phoneNumber,
        isVerified: false,
      }).sort({ createdAt: -1 });

      if (
        latestPending &&
        latestPending.verificationCode &&
        latestPending.verificationCode !== "twilio-verify"
      ) {
        // Manual code path (development/fallback)
        if (!latestPending.isValid()) {
          throw new Error(
            "Verification code has expired or exceeded maximum attempts",
          );
        }
        if (latestPending.verificationCode !== enteredCode) {
          await latestPending.incrementAttempts();
          throw new Error("Invalid verification code");
        }
        await latestPending.markAsVerified();
        return {
          success: true,
          message: "Phone number verified successfully",
        };
      }

      // Check if using Twilio Verify service
      const client = getTwilioClient();
      if (client && process.env.TWILIO_SERVICE_ID) {
        // Use Twilio Verify to check the code
        const verificationCheck = await client.verify.v2
          .services(process.env.TWILIO_SERVICE_ID)
          .verificationChecks.create({
            to: phoneNumber,
            code: enteredCode,
          });

        if (verificationCheck.status === "approved") {
          // Find and update our verification record
          const verification = await PhoneVerification.findOne({
            phoneNumber,
            isVerified: false,
          }).sort({ createdAt: -1 });

          if (verification) {
            await verification.markAsVerified();
          }

          return {
            success: true,
            message: "Phone number verified successfully",
          };
        } else {
          throw new Error("Invalid verification code");
        }
      }

      // Fallback to manual verification (development mode)
      const verification = await PhoneVerification.findOne({
        phoneNumber,
        isVerified: false,
      }).sort({ createdAt: -1 });

      if (!verification) {
        throw new Error("No verification code found for this phone number");
      }

      // Check if verification is still valid
      if (!verification.isValid()) {
        throw new Error(
          "Verification code has expired or exceeded maximum attempts",
        );
      }

      // Check if the code matches
      if (verification.verificationCode !== enteredCode) {
        await verification.incrementAttempts();
        throw new Error("Invalid verification code");
      }

      // Mark as verified
      await verification.markAsVerified();

      return {
        success: true,
        message: "Phone number verified successfully",
      };
    } catch (error) {
      console.error("Verification Error:", error);
      throw error;
    }
  }

  // Check if phone number is already verified
  static async isPhoneVerified(phoneNumber) {
    try {
      const verification = await PhoneVerification.findOne({
        phoneNumber,
        isVerified: true,
      }).sort({ createdAt: -1 });

      return !!verification;
    } catch (error) {
      console.error("Phone verification check error:", error);
      return false;
    }
  }

  // Clean up expired verification records
  static async cleanupExpiredRecords() {
    try {
      const result = await PhoneVerification.deleteMany({
        expiresAt: { $lt: new Date() },
      });

      console.log(
        `Cleaned up ${result.deletedCount} expired verification records`,
      );
      return result.deletedCount;
    } catch (error) {
      console.error("Cleanup error:", error);
      return 0;
    }
  }
}

module.exports = TwilioService;
