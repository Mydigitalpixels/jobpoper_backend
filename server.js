const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const connectDB = require("./config/database");
const path = require("path");

// Load environment variables
dotenv.config();

const app = express();

// Middleware
app.use(cors()); // Allow all origins
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static serving for uploaded files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/users"));
app.use("/api/jobs", require("./routes/jobs"));
app.use("/api/locations", require("./routes/locations"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/health", require("./routes/health"));

// Basic route
app.get("/", (req, res) => {
  res.json({
    message: "JobPoper Backend API is running!",
    version: "1.0.0",
    status: "success",
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
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
