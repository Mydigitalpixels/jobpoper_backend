const express = require('express');
const router = express.Router();
const { createReport, getMyReports } = require('../controllers/reportController');
const { protect } = require('../middleware/auth');
const { uploadReportImages } = require('../middleware/upload');

router.use(protect);

// File a report (optional images via multipart field "images")
router.post('/', ...uploadReportImages, createReport);

// The current user's own reports (with status)
router.get('/me', getMyReports);

module.exports = router;
