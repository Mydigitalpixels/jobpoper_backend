const express = require("express");
const {
  registerDevice,
  unregisterDevice,
  listMyDevices,
  sendTestPush,
} = require("../controllers/deviceController");
const { protect } = require("../middleware/auth");

const router = express.Router();

router.post("/", protect, registerDevice);
router.get("/me", protect, listMyDevices);
router.post("/test-push", protect, sendTestPush);
router.delete("/:deviceId", protect, unregisterDevice);

module.exports = router;
