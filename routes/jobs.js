const express = require('express');
const router = express.Router();
const { protect, optionalProtect } = require('../middleware/auth');
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
  expireOldJobs
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
router.get('/:id', getJobById);

// Protected routes (require authentication)
router.use(protect);

router.post('/', uploadJobFiles, createJob);
router.post('/:id/interest', showInterestInJob);
router.post('/expire-old', expireOldJobs);
router.put('/:id', uploadJobFiles, updateJob);
router.delete('/:id', deleteJob);
router.put('/:id/status', updateJobStatus);

module.exports = router;
