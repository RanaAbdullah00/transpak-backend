const express = require("express");
const { getInfo, streamVideo } = require("../src/controllers/demoVideoController");

const router = express.Router();

router.get("/info", getInfo);
router.get("/stream", streamVideo);

module.exports = router;
