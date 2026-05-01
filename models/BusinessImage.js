const mongoose = require('mongoose');

/**
 * BusinessImage
 * --------------
 * A single image belonging to a BusinessProfile. Each profile must have
 * 1..5 images (the count cap is enforced from BusinessProfile.images via
 * schema validators; this model owns the actual image record).
 *
 * Relationship: BusinessImage → BusinessProfile (many-to-one).
 * The reverse direction (profile → image refs) is stored on BusinessProfile
 * so listing/validating image counts stays a single document read.
 */
const businessImageSchema = new mongoose.Schema(
  {
    businessProfile: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BusinessProfile',
      required: [true, 'businessProfile is required'],
      index: true,
    },
    url: {
      type: String,
      required: [true, 'Image url is required'],
      trim: true,
    },
    isPrimary: {
      type: Boolean,
      required: [true, 'isPrimary is required'],
      default: false,
    },
    uploadedAt: {
      type: Date,
      required: [true, 'uploadedAt is required'],
      default: () => new Date(),
    },
  },
  { timestamps: true, collection: 'business_images' }
);

// Only one primary image per profile. Partial index so non-primary rows
// don't collide with each other.
businessImageSchema.index(
  { businessProfile: 1, isPrimary: 1 },
  {
    unique: true,
    partialFilterExpression: { isPrimary: true },
    name: 'one_primary_image_per_profile',
  }
);

module.exports = mongoose.model('BusinessImage', businessImageSchema);
