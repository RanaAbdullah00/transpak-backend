const { v2: cloudinary } = require("cloudinary");

function getCloudinaryConfigFromEnv() {
  const url = String(process.env.CLOUDINARY_URL || "").trim();
  if (url) return { cloudinaryUrl: url };
  const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || "").trim();
  const apiKey = String(process.env.CLOUDINARY_API_KEY || "").trim();
  const apiSecret = String(process.env.CLOUDINARY_API_SECRET || "").trim();
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      "Cloudinary config missing. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET."
    );
  }
  return { cloudName, apiKey, apiSecret };
}

let _configured = false;

function ensureConfigured() {
  if (_configured) return;
  const cfg = getCloudinaryConfigFromEnv();
  if (cfg.cloudinaryUrl) {
    cloudinary.config({ cloudinary_url: cfg.cloudinaryUrl });
  } else {
    cloudinary.config({
      cloud_name: cfg.cloudName,
      api_key: cfg.apiKey,
      api_secret: cfg.apiSecret
    });
  }
  _configured = true;
}

module.exports = {
  cloudinary,
  ensureConfigured,
  getCloudinaryConfigFromEnv
};
