const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Recipient is required'],
    index: true
  },
  type: {
    type: String,
    required: [true, 'Notification type is required'],
    enum: {
      values: [
        'job_created',
        'job_interest',
        'job_started',
        'job_completed',
        'verification_review',
        'business_profile_review',
        'order_received',
      ],
      message: 'Notification type must be one of: job_created, job_interest, job_started, job_completed, verification_review, business_profile_review, order_received'
    },
    index: true
  },
  title: {
    type: String,
    required: [true, 'Title is required'],
    trim: true,
    maxlength: [200, 'Title cannot be more than 200 characters']
  },
  message: {
    type: String,
    required: [true, 'Message is required'],
    trim: true,
    maxlength: [500, 'Message cannot be more than 500 characters']
  },
  relatedEntityType: {
    type: String,
    required: [true, 'Related entity type is required'],
    enum: {
      values: ['Job', 'User', 'BusinessProfile', 'Order'],
      message: 'Related entity type must be: Job, User, BusinessProfile, or Order'
    }
  },
  relatedEntityId: {
    type: mongoose.Schema.Types.ObjectId,
    required: [true, 'Related entity ID is required'],
    refPath: 'relatedEntityType'
  },
  navigationIdentifier: {
    type: String,
    required: [true, 'Navigation identifier is required'],
    trim: true
  },
  isRead: {
    type: Boolean,
    default: false,
    index: true
  },
  readAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Compound index for efficient queries
notificationSchema.index({ recipient: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, createdAt: -1 });

// Method to mark as read
notificationSchema.methods.markAsRead = function() {
  this.isRead = true;
  this.readAt = new Date();
  return this.save();
};

module.exports = mongoose.model('Notification', notificationSchema);
