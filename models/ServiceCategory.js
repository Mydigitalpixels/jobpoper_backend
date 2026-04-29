const mongoose = require('mongoose');

/**
 * Catalog of service categories users can pick from when posting a job.
 * Slug is the canonical, immutable identifier (used for migrations / external refs).
 */
const serviceCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Category name is required'],
      trim: true,
      maxlength: [100, 'Category name cannot be more than 100 characters'],
    },
    slug: {
      type: String,
      required: [true, 'Category slug is required'],
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: [120, 'Category slug cannot be more than 120 characters'],
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    icon: {
      type: String,
      trim: true,
      default: '',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

serviceCategorySchema.index({ name: 'text' });
serviceCategorySchema.index({ isActive: 1, sortOrder: 1, name: 1 });

module.exports = mongoose.model('ServiceCategory', serviceCategorySchema);
