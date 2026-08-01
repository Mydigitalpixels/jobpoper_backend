const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
  phoneNumber: {
    type: String,
    required: [true, 'Phone number is required'],
    unique: true,
    trim: true,
    // Allow local format (e.g. 03001234567) and international format (e.g. +923001234567)
    match: [/^\+?\d{7,15}$/, 'Please enter a valid phone number']
  },
  isPhoneVerified: {
    type: Boolean,
    default: false
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  pin: {
    type: String,
    required: [true, 'PIN is required']
  },
  profile: {
    fullName: {
      type: String,
      required: false,
      trim: true,
      maxlength: [100, 'Full name cannot be more than 100 characters']
    },
    email: {
      type: String,
      required: false,
      lowercase: true,
      trim: true,
      match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
    },
    location: {
      type: String,
      trim: true,
      maxlength: [200, 'Location cannot be more than 200 characters']
    },
    currentLocation: {
      fullAddress: {
        type: String,
        trim: true,
        maxlength: [200, 'Location cannot be more than 200 characters']
      },
      latitude: {
        type: Number
      },
      longitude: {
        type: Number
      },
      updatedAt: {
        type: Date
      }
    },
    profileImage: {
      type: String
    },
    isProfileComplete: {
      type: Boolean,
      default: false
    }
  },
  verification: {
    selfieImage: {
      type: String,
      default: null
    },
    idPhotoImage: {
      type: String,
      default: null
    },
    status: {
      type: String,
      enum: ['not_submitted', 'under_review', 'approved', 'rejected'],
      default: 'not_submitted'
    },
    submittedAt: {
      type: Date,
      default: null
    },
    reviewedAt: {
      type: Date,
      default: null
    },
    reviewNotes: {
      type: String,
      trim: true,
      default: ''
    }
  },
  vehiclePreference: {
    vehicleType: {
      type: String,
      enum: ['2_wheeler', '3_wheeler', '4_wheeler'],
      default: null
    },
    vehicleNumber: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: [20, 'Vehicle number cannot be more than 20 characters'],
      default: null
    },
    pricePerKm: {
      type: Number,
      min: [0, 'Price per km cannot be negative'],
      default: null
    },
    isSet: {
      type: Boolean,
      default: false
    },
    updatedAt: {
      type: Date,
      default: null
    }
  },
  workerId: {
    type: String,
    uppercase: true,
    trim: true,
    minlength: 5,
    maxlength: 5
    // Uniqueness is enforced by a PARTIAL unique index declared below
    // (partialFilterExpression: workerId is a string), NOT by a field-level
    // `unique`/`sparse` option. A plain sparse unique index still indexes
    // documents that store an explicit `null`, so legacy rows created before
    // the `default: null` was removed would collide on null and break saves.
    // A partial index only covers documents where workerId is an actual
    // string, so any number of users without a workerId can coexist.
    // NOTE: `default: null` is intentionally omitted so the field stays
    // genuinely absent until a Worker ID is assigned.
  },
  referralCode: {
    type: String,
    uppercase: true,
    trim: true,
    minlength: 5,
    maxlength: 5
    // Uniqueness enforced by a PARTIAL unique index below — never a
    // field-level `unique`/`sparse`, and never `default: null`. See the
    // workerId comment above and scripts/fixWorkerIdIndex.js for the
    // production incident this avoids. Assigned to EVERY user at registration.
  },
  referredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
    // The user whose referral code this account was created with.
    // Write-once: set during complete-profile, never changed afterwards.
  },
  referredAt: {
    type: Date,
    default: null
  },
  rating: {
    average: { type: Number, default: 0, min: 0, max: 5 },
    count: { type: Number, default: 0, min: 0 }
  },
  isProfessional: {
    type: Boolean,
    default: false
  },
  professionalProfile: {
    serviceCategories: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceCategory'
    }],
    workImages: {
      type: [String],
      default: [],
      validate: {
        validator: function(v) { return v.length <= 10; },
        message: 'Cannot have more than 10 work images'
      }
    },
    bio: {
      type: String,
      trim: true,
      maxlength: [500, 'Bio cannot be more than 500 characters'],
      default: ''
    },
    yearsOfExperience: {
      type: Number,
      min: [0, 'Years of experience cannot be negative'],
      default: null
    }
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastLogin: {
    type: Date
  }
}, {
  timestamps: true
});

// Hash PIN before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('pin')) return next();
  
  // Validate PIN format before hashing
  if (!/^\d{4}$/.test(this.pin)) {
    return next(new Error('PIN must be exactly 4 digits'));
  }
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.pin = await bcrypt.hash(this.pin, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Compare PIN method
userSchema.methods.comparePin = async function(candidatePin) {
  return await bcrypt.compare(candidatePin, this.pin);
};

// Index for better performance
// `phoneNumber` is declared with `unique: true` in the schema above which
// already creates an index; the explicit schema index was causing a duplicate
// index warning. Keep the unique constraint on the field and only keep the
// createdAt index here.
userSchema.index({ createdAt: -1 });

// Enforce workerId uniqueness only for documents that actually have one.
// A partial index (unlike a sparse index) ignores rows where workerId is
// null/absent, so users without an assigned Worker ID never collide.
userSchema.index(
  { workerId: 1 },
  { unique: true, partialFilterExpression: { workerId: { $type: 'string' } } }
);

// Referral code: mirrors the workerId index exactly. Only documents whose
// referralCode is an actual string participate, so any number of users
// without one can coexist (and legacy explicit-null rows never collide).
userSchema.index(
  { referralCode: 1 },
  { unique: true, partialFilterExpression: { referralCode: { $type: 'string' } } }
);

// Powers the paginated "Referred Users" list and its count in one index.
// referredBy is the equality prefix; createdAt gives the sort for free.
userSchema.index({ referredBy: 1, createdAt: -1 });

module.exports = mongoose.model('User', userSchema);
