const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const connectDB = require("./config/database");
const path = require("path");

// Load environment variables
dotenv.config();

const app = express();

// TRUST PROXY — read this before changing it.
//
// `trust proxy` tells Express to believe the X-Forwarded-For header. That is
// correct ONLY when every request really does arrive through a proxy you
// control. Today the mobile app calls http://<host>:3001 directly (see
// src/api/baseURL.ts), so there is no proxy in front of Node — and with
// trust proxy on, ANY client can set its own X-Forwarded-For and choose the
// IP that Express reports. That makes every IP-keyed rate limit bypassable
// with one extra header and every IP in the OTP audit log fabricated.
//
// So it now defaults to OFF and is opted into explicitly once nginx is
// terminating in front of Node AND port 3001 is closed to the internet:
//
//   TRUST_PROXY=1        -> trust exactly one proxy hop (nginx on this host)
//   TRUST_PROXY=<ip,ip>  -> trust these proxy addresses only
//   TRUST_PROXY unset    -> trust nothing (correct for direct exposure)
const trustProxy = String(process.env.TRUST_PROXY || "").trim();
if (trustProxy) {
  const numeric = Number(trustProxy);
  app.set("trust proxy", Number.isFinite(numeric) ? numeric : trustProxy);
  console.log(`[server] trust proxy = ${trustProxy}`);
} else {
  app.set("trust proxy", false);
  console.log("[server] trust proxy = false (X-Forwarded-For is ignored)");
}

// Middleware
app.use(cors()); // Allow all origins
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static serving for uploaded files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Public marketing pages (smart store redirect for referral shares)
app.use(express.static(path.join(__dirname, "public")));

const adminDistPath = path.join(__dirname, "admin-panel", "dist");
const hasAdminBuild = require("fs").existsSync(adminDistPath);

if (hasAdminBuild) {
  app.use("/admin", express.static(adminDistPath));
}

// Routes
const { authTrafficLimiter } = require("./middleware/rateLimit");
const authRouter = require("./routes/auth");
app.use("/api/auth", authTrafficLimiter, authRouter);
// Support legacy/non-API-prefixed auth routes (mobile clients may call /auth/*)
app.use("/auth", authTrafficLimiter, authRouter);
app.use("/api/admin", require("./routes/admin"));
app.use("/api/users", require("./routes/users"));
app.use("/api/jobs", require("./routes/jobs"));
app.use("/api/locations", require("./routes/locations"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/service-categories", require("./routes/serviceCategories"));
app.use("/service-categories", require("./routes/serviceCategories"));
app.use("/api/business-categories", require("./routes/businessCategories"));
app.use("/business-categories", require("./routes/businessCategories"));
app.use("/api/business-profiles", require("./routes/businessProfiles"));
app.use("/business-profiles", require("./routes/businessProfiles"));
const ordersRouter = require("./routes/orders");
app.use("/api/orders", ordersRouter);
app.use("/orders", ordersRouter);
const devicesRouter = require("./routes/devices");
app.use("/api/devices", devicesRouter);
// Same routes without /api prefix (client baseURL is .../api so /auth, /devices resolve to host:port/auth, host:port/devices)
app.use("/devices", devicesRouter);
const reportsRouter = require("./routes/reports");
app.use("/api/reports", reportsRouter);
app.use("/reports", reportsRouter);
const referralsRouter = require("./routes/referrals");
app.use("/api/referrals", referralsRouter);
app.use("/referrals", referralsRouter);
app.use("/api/health", require("./routes/health"));

// Basic route
app.get("/", (req, res) => {
  res.json({
    message: "MakeMy Task Backend API is running!",
    version: "1.0.0",
    status: "success",
  });
});

// Smart download page used in referral share messages.
// iOS / Android auto-redirect via public/download.html; desktop shows both buttons.
app.get(["/download", "/download/"], (req, res) => {
  res.sendFile(path.join(__dirname, "public", "download.html"));
});

if (hasAdminBuild) {
  app.get(/^\/admin(\/.*)?$/, (req, res) => {
    res.sendFile(path.join(adminDistPath, "index.html"));
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  if (err.name === "MulterError") {
    const isFileSize = err.code === "LIMIT_FILE_SIZE";
    return res.status(400).json({
      status: "error",
      message: isFileSize
        ? "Uploaded file is too large. Maximum size is 8MB."
        : err.message,
    });
  }
  if (/Only .*image uploads are allowed/i.test(err.message || "")) {
    return res.status(400).json({
      status: "error",
      message: err.message,
    });
  }
  res.status(500).json({
    status: "error",
    message: "Something went wrong!",
    error:
      process.env.NODE_ENV === "development"
        ? err.message
        : "Internal Server Error",
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    message: "Route not found",
    status: "error",
  });
});

const PORT = process.env.PORT || 3001;

async function start() {
  try {
    await connectDB();

    // Seed service categories on boot (idempotent — safe to run repeatedly).
    try {
      const { seedServiceCategories } = require("./services/seedServiceCategories");
      await seedServiceCategories();
    } catch (seedErr) {
      console.error("[ServiceCategory] Seed step error:", seedErr.message);
    }

    // Seed business categories on boot (idempotent — safe to run repeatedly).
    try {
      const { seedBusinessCategories } = require("./services/seedBusinessCategories");
      await seedBusinessCategories();
    } catch (seedErr) {
      console.error("[BusinessCategory] Seed step error:", seedErr.message);
    }

    app.listen(PORT, () => {
      console.log(`🚀 Server is running on port ${PORT}`);
      console.log(`📊 Environment: ${process.env.NODE_ENV}`);
      console.log(`🌐 CORS: allowed for all origins`);
    });
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    console.log("📝 Check MONGODB_URI in .env, network, and Atlas IP access list");
    process.exit(1);
  }
}

start();
