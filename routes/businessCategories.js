const express = require('express');
const router = express.Router();
const {
  getBusinessCategories,
  getBusinessCategoryByIdOrSlug,
} = require('../controllers/businessCategoryController');

// Public list & lookup
router.get('/', getBusinessCategories);
router.get('/:idOrSlug', getBusinessCategoryByIdOrSlug);

module.exports = router;
