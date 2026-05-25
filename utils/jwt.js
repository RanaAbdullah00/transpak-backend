const jwt = require("jsonwebtoken");

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || !String(secret).trim()) {
    throw new Error(
      "TransPak auth: JWT_SECRET is missing or empty. Set a strong JWT_SECRET in the server environment before starting the API."
    );
  }
  return String(secret).trim();
}

function getJwtExpiresIn() {
  return process.env.JWT_EXPIRES_IN || "7d";
}

/**
 * Sign a JWT for a user (identity snapshot only — authorization uses DB via requireAuth).
 */
function signToken(user) {
  const secret = getJwtSecret();
  const userId = user?.id || user?._id;
  if (!userId) throw new Error("TransPak auth: cannot sign token without user id");
  const idStr = String(userId);
  const payload = {
    sub: idStr,
    id: idStr
  };

  return jwt.sign(payload, secret, {
    expiresIn: getJwtExpiresIn()
  });
}

/**
 * Verify and decode a JWT.
 */
function verifyToken(token) {
  const secret = getJwtSecret();
  return jwt.verify(token, secret);
}

module.exports = {
  signToken,
  verifyToken
};

