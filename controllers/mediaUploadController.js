const { sendSuccess, sendError } = require("../utils/apiResponse");

function postMedia(req, res) {
  if (!req.file) {
    return sendError(res, 400, "No file uploaded. Use field name: file", null, "NO_FILE");
  }
  const url = req.file.path;
  const public_id = req.file.filename;
  if (!url || !public_id) {
    return sendError(res, 503, "Upload incomplete", null, "UPLOAD_FAILED");
  }
  return sendSuccess(res, 200, { url, public_id }, "Uploaded");
}

module.exports = { postMedia };
