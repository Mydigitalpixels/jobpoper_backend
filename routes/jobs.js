const express = require('express');
const router = express.Router();
const { protect, optionalProtect } = require('../middleware/auth');
const { requirePhoneVerified } = require('../middleware/requirePhoneVerified');
const { uploadJobFiles } = require('../middleware/upload');
const {
  createJob,
  getAllJobs,
  getHotJobs,
  searchHotJobs,
  getNormalJobs,
  searchNormalJobs,
  getJobById,
  getMyJobs,
  getMyInterestedJobs,
  updateJob,
  deleteJob,
  updateJobStatus,
  showInterestInJob,
  expireOldJobs,
  lookupWorker,
  startJob,
  completeJob,
  submitReview,
  updateReview,
  getWorkerReviews,
} = require('../controllers/jobController');

// Public routes
router.get('/', optionalProtect, getAllJobs);
router.get('/hot', optionalProtect, getHotJobs);
router.get('/search/hot', optionalProtect, searchHotJobs);
router.get('/normal', optionalProtect, getNormalJobs);
router.get('/search/normal', optionalProtect, searchNormalJobs);
// Protect only these routes inline so they can appear before :id and avoid conflicts
router.get('/my-interests', protect, getMyInterestedJobs);
router.get('/my-jobs', protect, getMyJobs);

// Worker lookup (by workerId string) — public, no auth required
router.get('/workers/lookup/:workerId', lookupWorker);
// Worker reviews — public
router.get('/workers/:userId/reviews', getWorkerReviews);

router.get('/:id', optionalProtect, getJobById);

// Protected routes (require authentication)
router.use(protect);

// Creation actions require a verified phone number (no-op until
// ENFORCE_PHONE_VERIFICATION=true). Reads, edits and deletes are NOT gated.
router.post('/', requirePhoneVerified, uploadJobFiles, createJob);
router.post('/:id/interest', requirePhoneVerified, showInterestInJob);
router.post('/expire-old', expireOldJobs);
router.post('/:id/start', startJob);
router.post('/:id/complete', completeJob);
router.post('/:id/review', submitReview);
router.put('/:id/review', updateReview);
router.put('/:id', uploadJobFiles, updateJob);
router.delete('/:id', deleteJob);
router.put('/:id/status', updateJobStatus);

module.exports = router;
