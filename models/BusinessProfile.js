const mongoose = require('mongoose');

/**
 * BusinessProfile
 * ----------------
 * A business listing owned by a user.
 *
 * Rules enforced here:
 *   - All fields are required (rejectionReason is the documented exception:
 *     it is nullable per spec and only meaningful when status === "rejected").
 *   - Each profile has 1..5 images. `images` holds refs to BusinessImage
 *     documents — the actual image records live in `business_images`.
 *   - A user can own at most 3 profiles (pre-save hook).
 *
 * Naming note: project convention is camelCase, so the spec's snake_case
 * (`user_id`, `business_name`, `category_id`, `phone_number`) is mapped to
 * `user`, `businessName`, `category`, `phoneNumber`. `createdAt`/`updatedAt`
 * come from `timestamps: true`.
 */
const businessProfileSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Owner user is required'],
      index: true,
    },
    businessName: {
      type: String,
      required: [true, 'Business name is required'],
      trim: true,
      maxlength: [150, 'Business name cannot be more than 150 characters'],
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BusinessCategory',
      required: [true, 'Business category is required'],
      index: true,
    },
    address: {
      type: String,
      required: [true, 'Address is required'],
      trim: true,
      maxlength: [500, 'Address cannot be more than 500 characters'],
    },
    phoneNumber: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true,
      match: [/^\+?[1-9]\d{1,14}$/, 'Please enter a valid phone number'],
    },
    status: {
      type: String,
      required: [true, 'Status is required'],
      enum: {
        values: ['pending', 'approved', 'rejected'],
        message: 'Status must be one of: pending, approved, rejected',
      },
      default: 'pending',
      index: true,
    },
    // Nullable by spec — only set when status === 'rejected'.
    rejectionReason: {
      type: String,
      trim: true,
      maxlength: [1000, 'Rejection reason cannot be more than 1000 characters'],
      default: null,
    },
    isActive: {
      type: Boolean,
      required: [true, 'isActive is required'],
      default: true,
    },
    images: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'BusinessImage',
        },
      ],
      required: [true, 'At least 1 image is required'],
      validate: [
        {
          validator: function (images) {
            return Array.isArray(images) && images.length >= 1;
          },
          message: 'At least 1 image is required',
        },
        {
          validator: function (images) {
            return Array.isArray(images) && images.length <= 5;
          },
          message: 'Cannot have more than 5 images',
        },
      ],
    },
  },
  { timestamps: true, collection: 'business_profiles' }
);

// --- Indexes ---------------------------------------------------------------

businessProfileSchema.index({ user: 1, createdAt: -1 });
businessProfileSchema.index({ category: 1, status: 1, isActive: 1 });
businessProfileSchema.index({ businessName: 'text', address: 'text' });

// --- Validation hooks ------------------------------------------------------

// Enforce max 3 profiles per user. Only checked on insert; updates to
// existing profiles aren't affected.
businessProfileSchema.pre('save', async function (next) {
  if (!this.isNew) return next();
  try {
    const count = await this.constructor.countDocuments({ user: this.user });
    if (count >= 3) {
      return next(new Error('A user can have at most 3 business profiles'));
    }
    next();
  } catch (err) {
    next(err);
  }
});

// Keep `rejectionReason` consistent with status — clear it whenever the
// profile is no longer rejected so stale reasons don't leak through.
businessProfileSchema.pre('save', function (next) {
  if (this.status !== 'rejected') {
    this.rejectionReason = null;
  }
  next();
});

module.exports = mongoose.model('BusinessProfile', businessProfileSchema);
