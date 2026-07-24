const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Report = require('../models/Report');
const Job = require('../models/Job');

// @desc    File a report (against a worker / on a job)
// @route   POST /api/reports
// @access  Private
const createReport = asyncHandler(async (req, res) => {
  const { reportedUser, jobId, reason, description } = req.body;

  if ((!reason || !reason.trim()) && (!description || !description.trim())) {
    return res.status(400).json({
      status: 'error',
      message: 'Please provide a reason or description for the report',
    });
  }

  // Resolve the reported user from the job when not supplied explicitly.
  let resolvedReportedUser = reportedUser || null;
  let resolvedJobId = jobId || null;
  if (resolvedJobId && mongoose.Types.ObjectId.isValid(resolvedJobId)) {
    const job = await Job.findById(resolvedJobId).select('assignedWorker postedBy');
    if (job && !resolvedReportedUser && job.assignedWorker) {
      resolvedReportedUser = job.assignedWorker;
    }
  } else {
    resolvedJobId = null;
  }

  const images = (req.processedFileNames || []).map((name) => `reports/${name}`);

  const report = await Report.create({
    reporter: req.user._id,
    reportedUser:
      resolvedReportedUser && mongoose.Types.ObjectId.isValid(resolvedReportedUser)
        ? resolvedReportedUser
        : null,
    jobId: resolvedJobId,
    reason: (reason || '').trim(),
    description: (description || '').trim(),
    images,
  });

  res.status(201).json({
    status: 'success',
    message: 'Report submitted. Our team will review it shortly.',
    data: { report },
  });
});

// @desc    List the current user's own reports
// @route   GET /api/reports/me
// @access  Private
const getMyReports = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;

  const filter = { reporter: req.user._id };

  const reports = await Report.find(filter)
    .populate('reportedUser', 'profile.fullName profile.profileImage workerId')
    .populate('jobId', 'title status')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  const total = await Report.countDocuments(filter);
  const totalPages = Math.ceil(total / limit);

  res.status(200).json({
    status: 'success',
    data: {
      reports,
      pagination: {
        currentPage: page,
        totalPages,
        totalReports: total,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    },
  });
});

module.exports = {
  createReport,
  getMyReports,
};
