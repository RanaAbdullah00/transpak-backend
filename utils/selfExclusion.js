/**
 * Prevent same userId from acting as both shipper and carrier on one commercial record.
 */

function assertNotSelfCommercial({ shipperId, carrierId, action = "interact with this load" }) {
  if (!shipperId || !carrierId) return;
  if (String(shipperId) === String(carrierId)) {
    const err = new Error(`You cannot ${action} on your own account's load`);
    err.statusCode = 403;
    err.code = "SELF_COMMERCIAL_FORBIDDEN";
    throw err;
  }
}

module.exports = { assertNotSelfCommercial };
