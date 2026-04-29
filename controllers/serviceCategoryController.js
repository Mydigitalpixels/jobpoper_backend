const asyncHandler = require('express-async-handler');
const ServiceCategory = require('../models/ServiceCategory');

// @desc    Get all active service categories
// @route   GET /api/service-categories
// @access  Public
const getServiceCategories = asyncHandler(async (req, res) => {
  const includeInactive = req.query.includeInactive === 'true';
  const filter = includeInactive ? {} : { isActive: true };

  const categories = await ServiceCategory.find(filter)
    .sort({ sortOrder: 1, name: 1 })
    .select('_id name slug description icon isActive sortOrder');

  res.status(200).json({
    status: 'success',
    message: 'Service categories fetched successfully',
    data: {
      categories,
      total: categories.length,
    },
  });
});

// @desc    Get a single service category by id or slug
// @route   GET /api/service-categories/:idOrSlug
// @access  Public
const getServiceCategoryByIdOrSlug = asyncHandler(async (req, res) => {
  const { idOrSlug } = req.params;
  const isObjectId = /^[a-f\d]{24}$/i.test(idOrSlug);

  const category = await ServiceCategory.findOne(
    isObjectId ? { _id: idOrSlug } : { slug: idOrSlug.toLowerCase() }
  ).select('_id name slug description icon isActive sortOrder');

  if (!category) {
    return res.status(404).json({
      status: 'error',
      message: 'Service category not found',
    });
  }

  res.status(200).json({
    status: 'success',
    data: { category },
  });
});

module.exports = {
  getServiceCategories,
  getServiceCategoryByIdOrSlug,
};
