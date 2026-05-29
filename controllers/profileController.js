const fs = require("fs");
const { validationResult } = require("express-validator");
const { query } = require("../db/pool");
const userRepo = require("../repositories/userRepo");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { uploadImageFile } = require("../src/services/cloudinaryService");
const { cleanupUploadedFiles } = require("../middleware/uploadProfileImages");
const { safeDestroyReplacedUrl } = require("../utils/cloudinaryUrl");
const { signToken } = require("../utils/jwt");
const { authData } = require("../utils/authPayload");
const { isAllowedImageUrl } = require("../utils/imageUrl");

const CNIC_REGEX = /^[0-9]{5}-[0-9]{7}-[0-9]{1}$/;
const UPLOAD_FAIL_USER_MSG = "File upload failed, please try again";
const INVALID_FILE_MSG = "Invalid or empty file";

/** pg bind: never pass undefined; empty string → null for text columns */
function pgText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function validationErrorResponse(req, res) {
  const result = validationResult(req);
  if (result.isEmpty()) return null;
  const errors = result.array();
  return sendError(res, 400, errors[0]?.msg || "Validation error", {
    fields: errors.map((e) => e.path)
  });
}

function computeProfileComplete(fields) {
  return (
    Boolean(fields.fullName) &&
    Boolean(fields.phone) &&
    Boolean(fields.cnicNumber) &&
    Boolean(fields.cnicImage) &&
    Boolean(fields.cnicImageBack) &&
    Boolean(fields.profileImage)
  );
}

function validateDiskFile(file) {
  if (!file || !file.path) return { ok: false, code: 400, message: INVALID_FILE_MSG };
  try {
    const st = fs.statSync(file.path);
    if (!st.isFile() || st.size < 1) return { ok: false, code: 400, message: INVALID_FILE_MSG };
  } catch {
    return { ok: false, code: 400, message: INVALID_FILE_MSG };
  }
  return { ok: true };
}

async function tryUploadImage(file, opts) {
  const v = validateDiskFile(file);
  if (!v.ok) return v;
  try {
    const uploaded = await uploadImageFile({
      filePath: file.path,
      mimeType: file.mimetype,
      folder: opts.folder,
      publicIdPrefix: opts.publicIdPrefix
    });
    return { ok: true, url: uploaded.url };
  } catch (err) {
    const sc = Number(err?.statusCode);
    if (sc === 400) {
      const m = String(err?.message || "").trim().slice(0, 120);
      return { ok: false, code: 400, message: m || UPLOAD_FAIL_USER_MSG };
    }
    return { ok: false, code: 503, message: UPLOAD_FAIL_USER_MSG };
  }
}

async function getProfile(req, res) {
  try {
    const user = await userRepo.findById(req.auth.userId);
    if (!user) return sendError(res, 401, "Unauthorized");
    return sendSuccess(res, 200, {
      id: user.id,
      email: user.email,
      activeRole: user.activeRole,
      roles: Array.isArray(user.roles) ? user.roles : [],
      full_name: user.fullName,
      phone: user.phone,
      cnic_number: user.cnicNumber,
      cnic_image: user.cnicImage,
      cnic_image_back: user.cnicImageBack,
      profile_image: user.profileImage,
      is_profile_complete: user.isProfileComplete
    });
  } catch {
    return sendError(res, 500, "Could not load profile");
  }
}

async function getProfileStatus(req, res) {
  try {
    const user = await userRepo.findById(req.auth.userId);
    if (!user) return sendError(res, 401, "Unauthorized");
    return sendSuccess(res, 200, { is_profile_complete: user.isProfileComplete });
  } catch {
    return sendError(res, 500, "Could not load profile status");
  }
}

async function updateProfile(req, res) {
  const maybeError = validationErrorResponse(req, res);
  if (maybeError) return maybeError;

  const uploadFailures = [];

  try {
    const user = await userRepo.findById(req.auth.userId);
    if (!user) return sendError(res, 401, "Unauthorized");

    const fullName = req.body?.full_name != null ? String(req.body.full_name).trim() : null;
    const phone = req.body?.phone != null ? String(req.body.phone).trim() : null;
    const cnic = req.body?.cnic_number != null ? String(req.body.cnic_number).trim() : null;

    const cnicImageFile = req.files?.cnic_image?.[0] || null;
    const cnicImageBackFile = req.files?.cnic_image_back?.[0] || null;
    const profileImageFile = req.files?.profile_image?.[0] || null;

    const next = {
      full_name: fullName ?? user.fullName ?? null,
      phone: phone ?? user.phone ?? null,
      cnic_number: user.cnicNumber || null,
      cnic_image: user.cnicImage || null,
      cnic_image_back: user.cnicImageBack || null,
      profile_image: user.profileImage || null
    };

    if (cnic != null && cnic !== "") {
      if (!CNIC_REGEX.test(cnic)) return sendError(res, 400, "Invalid CNIC format");
      if (user.cnicNumber && user.cnicNumber !== cnic) {
        return sendError(res, 403, "CNIC cannot be edited after first save");
      }
      if (!user.cnicNumber) {
        const hasCnicProof = Boolean(cnicImageFile || user.cnicImage) && Boolean(cnicImageBackFile || user.cnicImageBack);
        if (!hasCnicProof) {
          return sendError(res, 400, "CNIC front and back images are required when saving CNIC");
        }
        next.cnic_number = cnic;
      }
    }

    const uploadAttemptedFields = [];
    if (cnicImageFile) uploadAttemptedFields.push("cnic_image");
    if (cnicImageBackFile) uploadAttemptedFields.push("cnic_image_back");
    if (profileImageFile) uploadAttemptedFields.push("profile_image");

    async function tryApplyUpload(fieldKey, file, folder, publicIdPrefix) {
      if (!file) return;
      const up = await tryUploadImage(file, { folder, publicIdPrefix });
      if (up.ok && up.url) {
        next[fieldKey] = String(up.url).trim();
        return;
      }
      uploadFailures.push({
        field: fieldKey,
        code: up.code || 503,
        message: up.message || UPLOAD_FAIL_USER_MSG
      });
    }

    await tryApplyUpload("cnic_image", cnicImageFile, "transpak/cnic", `cnic_front_${req.auth.userId}`);
    await tryApplyUpload("cnic_image_back", cnicImageBackFile, "transpak/cnic", `cnic_back_${req.auth.userId}`);
    await tryApplyUpload("profile_image", profileImageFile, "transpak/profile", `profile_${req.auth.userId}`);

    const failedFields = new Set(uploadFailures.map((f) => f.field));
    const allSubmittedFilesFailed =
      uploadAttemptedFields.length > 0 && uploadAttemptedFields.every((f) => failedFields.has(f));

    const hasTextOrCnicChange =
      (fullName != null && String(fullName).trim() !== String(user.fullName || "").trim()) ||
      (phone != null && String(phone).trim() !== String(user.phone || "").trim()) ||
      (cnic != null && cnic !== "" && !user.cnicNumber);

    if (allSubmittedFilesFailed && !hasTextOrCnicChange) {
      cleanupUploadedFiles(req);
      return sendError(
        res,
        503,
        UPLOAD_FAIL_USER_MSG,
        {
          upload_failures: uploadFailures.map((f) => ({ field: f.field, message: f.message }))
        },
        "UPLOAD_FAILED"
      );
    }

    const isComplete = computeProfileComplete({
      fullName: next.full_name,
      phone: next.phone,
      cnicNumber: next.cnic_number,
      cnicImage: next.cnic_image,
      cnicImageBack: next.cnic_image_back,
      profileImage: next.profile_image
    });

    for (const [field, val] of [
      ["cnic_image", next.cnic_image],
      ["cnic_image_back", next.cnic_image_back],
      ["profile_image", next.profile_image]
    ]) {
      if (val && !isAllowedImageUrl(val)) {
        cleanupUploadedFiles(req);
        return sendError(res, 400, `Invalid image URL for ${field}`, null, "INVALID_IMAGE_URL");
      }
    }

    let rows;
    try {
      const pCnicImg = pgText(next.cnic_image);
      const pCnicBack = pgText(next.cnic_image_back);
      const pProfileImg = pgText(next.profile_image);

      const result = await query(
        `UPDATE users
         SET full_name = $2,
             phone = $3,
             cnic_number = COALESCE(cnic_number, $4),
             cnic_image = COALESCE($5, cnic_image),
             cnic_image_back = COALESCE($6, cnic_image_back),
             profile_image = COALESCE($7, profile_image),
             is_profile_complete = $8,
             updated_at = now()
         WHERE id = $1
         RETURNING id`,
        [
          req.auth.userId,
          next.full_name ?? null,
          next.phone ?? null,
          next.cnic_number ?? null,
          pCnicImg,
          pCnicBack,
          pProfileImg,
          isComplete
        ]
      );
      rows = result.rows;
    } catch (dbErr) {
      // eslint-disable-next-line no-console
      console.error("[profile.update] DB error", dbErr?.code || "", dbErr?.message || dbErr);
      return sendError(res, 500, "Profile update failed", null, "SERVER_ERROR");
    }

    if (!rows?.[0]?.id) {
      return sendError(res, 500, "Profile update did not apply");
    }

    const uidStr = String(req.auth.userId);
    if (cnicImageFile && user.cnicImage && user.cnicImage !== next.cnic_image) {
      void safeDestroyReplacedUrl(uidStr, user.cnicImage, next.cnic_image, "image");
    }
    if (cnicImageBackFile && user.cnicImageBack && user.cnicImageBack !== next.cnic_image_back) {
      void safeDestroyReplacedUrl(uidStr, user.cnicImageBack, next.cnic_image_back, "image");
    }
    if (profileImageFile && user.profileImage && user.profileImage !== next.profile_image) {
      void safeDestroyReplacedUrl(uidStr, user.profileImage, next.profile_image, "image");
    }

    const finalUser = await userRepo.findById(rows[0].id);
    if (!finalUser) {
      return sendError(res, 500, "Profile update failed");
    }

    const token = signToken(finalUser);
    const payload = {
      ...authData(finalUser, token),
      profile: {
        full_name: finalUser.fullName,
        phone: finalUser.phone,
        email: finalUser.email,
        cnic_number: finalUser.cnicNumber,
        cnic_image: finalUser.cnicImage,
        cnic_image_back: finalUser.cnicImageBack,
        profile_image: finalUser.profileImage,
        is_profile_complete: finalUser.isProfileComplete
      }
    };

    if (uploadFailures.length) {
      payload.upload_failures = uploadFailures.map((f) => ({
        field: f.field,
        message: f.message
      }));
    }

    const summaryMsg = uploadFailures.length ? "Updated; some files could not be uploaded" : "Updated";

    return sendSuccess(res, 200, payload, summaryMsg);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[profile.updateProfile]", err?.statusCode, err?.message || err);
    const rawMsg = err?.message || "Update failed";
    if (/Cloudinary config missing/i.test(rawMsg) || /not configured/i.test(rawMsg)) {
      return sendError(res, 503, "File storage is not configured on the server", null, "UPLOAD_FAILED");
    }
    const code = Number(err?.statusCode);
    if (code === 400) return sendError(res, 400, "Validation error", null, "VALIDATION_ERROR");
    if (code === 502 || code === 503) return sendError(res, 503, UPLOAD_FAIL_USER_MSG, null, "UPLOAD_FAILED");
    return sendError(res, 500, "Profile update failed", null, "SERVER_ERROR");
  } finally {
    cleanupUploadedFiles(req);
  }
}

async function getActivitySnapshot(req, res) {
  try {
    const uid = req.auth.userId;
    const roles = Array.isArray(req.auth.roles) ? req.auth.roles : [];
    const hasShipper = roles.includes("shipper");
    const hasCarrier = roles.includes("carrier");
    const isAdminPlatformOnly = roles.includes("admin") && !hasShipper && !hasCarrier;

    const out = {
      shipper: null,
      carrier: null,
      admin: null
    };

    if (isAdminPlatformOnly) {
      const [totalUsers, totalLoads, totalBids, activeShipments, totalReviews] = await Promise.all([
        query(`SELECT COUNT(*)::int AS c FROM users`),
        query(`SELECT COUNT(*)::int AS c FROM loads`),
        query(`SELECT COUNT(*)::int AS c FROM bids`),
        query(
          `SELECT COUNT(*)::int AS c FROM shipments WHERE status IN ('booked','pickedup','intransit','delivered')`
        ),
        query(`SELECT COUNT(*)::int AS c FROM ratings`)
      ]);
      out.admin = {
        totalUsers: totalUsers.rows[0]?.c ?? 0,
        totalLoads: totalLoads.rows[0]?.c ?? 0,
        totalBids: totalBids.rows[0]?.c ?? 0,
        activeShipments: activeShipments.rows[0]?.c ?? 0,
        totalReviews: totalReviews.rows[0]?.c ?? 0
      };
    }

    if (hasShipper) {
      const { rows } = await query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE lower(status) IN ('closed', 'delivered'))::int AS done
         FROM loads
         WHERE shipper_id = $1`,
        [uid]
      );
      const s = rows[0] || {};
      out.shipper = { loadsTotal: s.total ?? 0, loadsDone: s.done ?? 0 };
    }

    if (hasCarrier) {
      const { rows: bRows } = await query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted
         FROM bids
         WHERE carrier_id = $1`,
        [uid]
      );
      const { rows: tRows } = await query(`SELECT COUNT(*)::int AS c FROM trucks WHERE user_id = $1`, [uid]);
      const b = bRows[0] || {};
      const t = tRows[0] || {};
      out.carrier = {
        bidsTotal: b.total ?? 0,
        bidsAccepted: b.accepted ?? 0,
        fleetCount: t.c ?? 0
      };
    }

    return sendSuccess(res, 200, out, "OK");
  } catch {
    return sendError(res, 500, "Could not load activity snapshot");
  }
}

module.exports = {
  getProfile,
  updateProfile,
  getProfileStatus,
  getActivitySnapshot,
  CNIC_REGEX
};
