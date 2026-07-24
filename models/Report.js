const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema(
  {
    // Who filed the report
    reporter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Reporter is required'],
    },
    // The user being reported (usually the professional on the job)
    reportedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // Optional job the report relates to
    jobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Job',
      default: null,
    },
    reason: {
      type: String,
      trim: true,
      maxlength: [120, 'Reason cannot exceed 120 characters'],
      default: '',
    },
    description: {
      type: String,
      trim: true,
      maxlength: [2000, 'Description cannot exceed 2000 characters'],
      default: '',
    },
    // Stored relative image paths (uploads/reports/...)
    images: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: ['open', 'resolved'],
      default: 'open',
    },
    // Admin note when resolving
    resolutionNote: {
      type: String,
      trim: true,
      maxlength: [1000, 'Resolution note cannot exceed 1000 characters'],
      default: '',
    },
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

reportSchema.index({ reporter: 1, createdAt: -1 });
reportSchema.index({ status: 1, createdAt: -1 });
reportSchema.index({ reportedUser: 1 });

module.exports = mongoose.model('Report', reportSchema);
