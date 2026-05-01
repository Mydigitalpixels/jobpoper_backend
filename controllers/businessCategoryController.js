const asyncHandler = require('express-async-handler');
const BusinessCategory = require('../models/BusinessCategory');

// @desc    Get all active business categories
// @route   GET /api/business-categories
// @access  Public
const getBusinessCategories = asyncHandler(async (req, res) => {
  const includeInactive = req.query.includeInactive === 'true';
  const filter = includeInactive ? {} : { isActive: true };

  const categories = await BusinessCategory.find(filter)
    .sort({ sortOrder: 1, name: 1 })
    .select('_id name slug description icon isActive sortOrder');

  res.status(200).json({
    status: 'success',
    message: 'Business categories fetched successfully',
    data: {
      categories,
      total: categories.length,
    },
  });
});

// @desc    Get a single business category by id or slug
// @route   GET /api/business-categories/:idOrSlug
// @access  Public
const getBusinessCategoryByIdOrSlug = asyncHandler(async (req, res) => {
  const { idOrSlug } = req.params;
  const isObjectId = /^[a-f\d]{24}$/i.test(idOrSlug);

  const category = await BusinessCategory.findOne(
    isObjectId ? { _id: idOrSlug } : { slug: idOrSlug.toLowerCase() }
  ).select('_id name slug description icon isActive sortOrder');

  if (!category) {
    return res.status(404).json({
      status: 'error',
      message: 'Business category not found',
    });
  }

  res.status(200).json({
    status: 'success',
    data: { category },
  });
});

module.exports = {
  getBusinessCategories,
  getBusinessCategoryByIdOrSlug,
};
