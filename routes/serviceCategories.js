const express = require('express');
const router = express.Router();
const {
  getServiceCategories,
  getServiceCategoryByIdOrSlug,
} = require('../controllers/serviceCategoryController');

// Public list & lookup
router.get('/', getServiceCategories);
router.get('/:idOrSlug', getServiceCategoryByIdOrSlug);

module.exports = router;
