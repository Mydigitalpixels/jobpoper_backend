const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const {
  createOrder,
  getReceivedOrders,
  getUnreadOrdersCount,
  markAllOrdersAsRead,
} = require("../controllers/orderController");

// All order routes require authentication.
router.use(protect);

// Customer side — raise an order against a business.
router.post("/", createOrder);

// Business-owner side — list of received orders + badge utilities.
router.get("/received", getReceivedOrders);
router.get("/unread-count", getUnreadOrdersCount);
router.put("/read-all", markAllOrdersAsRead);

module.exports = router;
