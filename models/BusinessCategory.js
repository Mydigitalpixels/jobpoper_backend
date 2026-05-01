const mongoose = require('mongoose');

/**
 * Catalog of business categories that businesses can be tagged with
 * (e.g. restaurants, salons, electricians, retail shops, etc.).
 *
 * Slug is the canonical, immutable identifier (used for migrations / external refs).
 * Collection name is pinned to `business_categories` so it matches the agreed
 * data model regardless of Mongoose's default pluralization rules.
 */
const businessCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Category name is required'],
      trim: true,
      maxlength: [120, 'Category name cannot be more than 120 characters'],
    },
    slug: {
      type: String,
      required: [true, 'Category slug is required'],
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: [140, 'Category slug cannot be more than 140 characters'],
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
  {
    timestamps: true,
    collection: 'business_categories',
  }
);

businessCategorySchema.index({ name: 'text' });
businessCategorySchema.index({ isActive: 1, sortOrder: 1, name: 1 });

module.exports = mongoose.model('BusinessCategory', businessCategorySchema);
