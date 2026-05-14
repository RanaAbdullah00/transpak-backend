const { sendSuccess, sendError } = require("../utils/apiResponse");
const translationService = require("../src/services/translationService");

async function runtimeTranslate(req, res) {
  try {
    const raw = req.body?.text;
    const target = req.body?.target === "ur" ? "ur" : "en";
    if (raw == null || typeof raw !== "string") {
      return sendError(res, 400, "text is required");
    }
    const check = translationService.sanitizeText(raw);
    if (!check.ok) {
      return sendError(res, 400, check.error || "Invalid text");
    }
    const result = await translationService.translateRuntime(raw, { target });
    return sendSuccess(res, 200, result, "OK");
  } catch {
    return sendError(res, 500, "Translation failed");
  }
}

module.exports = { runtimeTranslate };
