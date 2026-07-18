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
    unique: true,
    sparse: true,
    uppercase: true,
    trim: true,
    minlength: 5,
    maxlength: 5
    // No `default: null` here on purpose: Mongoose would explicitly set this
    // field to null on every new user, and MongoDB's sparse index only
    // excludes documents where the field is truly absent (not explicit
    // null). With a default of null, only the first-ever user could be
    // created — every user after that hit a duplicate-key error on this
    // index during registration. Leaving it unset keeps the field genuinely
    // absent until a Worker ID is actually assigned.
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

module.exports = mongoose.model('User', userSchema);
