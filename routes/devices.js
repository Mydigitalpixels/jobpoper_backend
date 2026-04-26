const express = require("express");
const { registerDevice, unregisterDevice } = require("../controllers/deviceController");
const { protect } = require("../middleware/auth");

const router = express.Router();

router.post("/", protect, registerDevice);
router.delete("/:deviceId", protect, unregisterDevice);

module.exports = router;
