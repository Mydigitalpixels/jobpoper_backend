const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Job title is required'],
    trim: true,
    maxlength: [100, 'Job title cannot be more than 100 characters']
  },
  description: {
    type: String,
    required: false,
    trim: true,
    maxlength: [2000, 'Job description cannot be more than 2000 characters']
  },
  cost: {
    type: String,
    required: [true, 'Cost/budget is required'],
    trim: true,
    maxlength: [100, 'Cost cannot be more than 100 characters']
  },
  jobType: {
    type: String,
    required: [true, 'Job type is required'],
    enum: {
      values: ['Pickup', 'OnSite'],
      message: 'Job type must be one of: Pickup, OnSite'
    }
  },
   location: {
    type: mongoose.Schema.Types.Mixed,
    required: [true, 'Location is required'],
    validate: {
      validator: function(location) {
        if (this.jobType === 'OnSite') {
          // For OnSite, location should be a single location object
          return (
            location &&
            typeof location === 'object' &&
            location.id &&
            location.name &&
            location.fullAddress &&
            typeof location.latitude === 'number' &&
            typeof location.longitude === 'number'
          );
        } else if (this.jobType === 'Pickup') {
          // For Pickup, location should have source and destination
          return (
            location &&
            location.source &&
            location.destination &&
            location.source.id &&
            location.source.name &&
            location.source.fullAddress &&
            typeof location.source.latitude === 'number' &&
            typeof location.source.longitude === 'number' &&
            location.destination.id &&
            location.destination.name &&
            location.destination.fullAddress &&
            typeof location.destination.latitude === 'number' &&
            typeof location.destination.longitude === 'number'
          );
        }
        return false;
      },
      message: function(props) {
        const jobType = this.jobType;
        if (jobType === 'OnSite') {
          return 'OnSite jobs require a single location object with id, name, fullAddress, latitude, and longitude';
        } else if (jobType === 'Pickup') {
          return 'Pickup jobs require both source and destination locations with id, name, fullAddress, latitude, and longitude';
        }
        return 'Invalid location format for job type';
      }
    }
  },
  urgency: {
    type: String,
    required: [true, 'Urgency level is required'],
    enum: {
      values: ['Urgent','Normal'],
      message: 'Urgency must be one of: Urgent, Normal'
    }
  },
  scheduledDate: {
    type: Date,
    required: [true, 'Scheduled date is required']
  },
  scheduledTime: {
    type: String,
    required: [true, 'Scheduled time is required'],
    trim: true
  },
  responsePreference: {
    type: String,
    required: [true, 'Response preference is required'],
    enum: {
      values: ['direct_contact', 'show_interest'],
      message: 'Response preference must be one of: direct_contact, show_interest'
    }
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ServiceCategory',
    default: null,
  },
  attachments: {
    type: [String],
    validate: {
      validator: function(attachments) {
        return attachments.length <= 5;
      },
      message: 'Cannot have more than 5 attachments'
    }
  },
  voiceNote: {
    type: String,
    default: null,
  },
  distanceKm: {
    type: Number,
    min: [0, 'Distance cannot be negative'],
    default: null
  },
  status: {
    type: String,
    enum: ['open', 'completed', 'cancelled'],
    default: 'open'
  },
  postedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Job must be posted by a user']
  },
  postedOnBehalf: {
    type: Boolean,
    default: false,
  },
  externalContact: {
    name: {
      type: String,
      trim: true,
      maxlength: [100, 'Name cannot be more than 100 characters'],
    },
    phoneNumber: {
      type: String,
      trim: true,
      maxlength: [20, 'Phone number cannot be more than 20 characters'],
    },
  },
  isActive: {
    type: Boolean,
    default: true
  },
  completedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Track users who showed interest in a job
jobSchema.add({
  interestedUsers: [
    {
      user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      notedAt: { type: Date, default: Date.now }
    }
  ]
});

// Indexes for better performance
jobSchema.index({ postedBy: 1, createdAt: -1 });
jobSchema.index({ 'location.fullAddress': 'text', title: 'text', description: 'text' });
jobSchema.index({ 'location.source.fullAddress': 'text', 'location.destination.fullAddress': 'text', title: 'text', description: 'text' });
jobSchema.index({ scheduledDate: 1, status: 1 });
jobSchema.index({ urgency: 1, status: 1 });
jobSchema.index({ 'interestedUsers.user': 1 });

// Virtual for formatted scheduled date
jobSchema.virtual('formattedScheduledDate').get(function() {
  // Guard against missing or invalid scheduledDate to avoid runtime errors
  if (!this.scheduledDate || Object.prototype.toString.call(this.scheduledDate) !== '[object Date]') {
    return null;
  }

  return this.scheduledDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
});

// Virtual for contact info (phone number for manual contact)
jobSchema.virtual('contactInfo').get(function() {
  if (this.postedOnBehalf && this.externalContact?.phoneNumber) {
    return this.externalContact.phoneNumber;
  }
  return this.postedBy ? this.postedBy.phoneNumber : null;
});
// Virtual to get location based on job type
jobSchema.virtual('jobLocation').get(function() {
  if (this.jobType === 'OnSite') {
    return {
      type: 'single',
      data: this.location
    };
  } else if (this.jobType === 'Pickup') {
    return {
      type: 'pickup',
      source: this.location.source,
      destination: this.location.destination
    };
  }
  return null;
});
// Pre-save middleware to parse location string if needed
jobSchema.pre('save', function(next) {
  if (typeof this.location === 'string') {
    try {
      this.location = JSON.parse(this.location);
    } catch (error) {
      return next(new Error('Invalid location format'));
    }
  }
  next();
});
// Method to get display address based on job type
jobSchema.methods.getDisplayAddress = function() {
  if (this.jobType === 'OnSite') {
    return this.location.fullAddress;
  } else if (this.jobType === 'Pickup') {
    return `${this.location.source.fullAddress} → ${this.location.destination.fullAddress}`;
  }
  return 'No address available';
};
// Ensure virtual fields are serialized
// Ensure virtual fields are serialized
jobSchema.set('toJSON', { 
  virtuals: true,
  transform: function(doc, ret) {
    // Add displayAddress to JSON output
    ret.displayAddress = doc.getDisplayAddress();
    return ret;
  }
});


module.exports = mongoose.model('Job', jobSchema);
