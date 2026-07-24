const express = require("express");
const router = express.Router();
const {
  getAdminSetupStatus,
  bootstrapAdmin,
  getDashboardSummary,
  getAdminUsers,
  getAdminUserById,
  deleteProfessionalWorkImage,
  getAdminJobs,
  getAdminJobById,
  getPendingBusinessProfileRequests,
  reviewBusinessProfileRequest,
  getVerificationRequests,
  reviewVerificationRequest,
  setUserBlockStatus,
  getAdminReports,
  updateReportStatus,
} = require("../controllers/adminController");
const { protect, authorize } = require("../middleware/auth");

router.get("/setup-status", getAdminSetupStatus);
router.post("/bootstrap", bootstrapAdmin);

router.use(protect, authorize("admin"));

router.get("/dashboard", getDashboardSummary);
router.get("/users", getAdminUsers);
router.get("/users/:userId", getAdminUserById);
router.delete("/users/:userId/work-images", deleteProfessionalWorkImage);
router.get("/jobs", getAdminJobs);
router.get("/jobs/:jobId", getAdminJobById);
router.get("/business-profiles/pending", getPendingBusinessProfileRequests);
router.put("/business-profiles/:profileId/review", reviewBusinessProfileRequest);
router.get("/verifications", getVerificationRequests);
router.put("/verifications/:userId/review", reviewVerificationRequest);

// Block / unblock a user (hard block toggles isActive)
router.patch("/users/:userId/block", setUserBlockStatus);

// Reports moderation
router.get("/reports", getAdminReports);
router.patch("/reports/:reportId", updateReportStatus);

module.exports = router;
