/** Resource access helpers — permissions from req.auth.roles[] only. */

function hasAdminRole(auth) {
  return (auth?.roles || []).includes("admin");
}

function canReadLoad(load, auth) {
  if (!load || !auth?.userId) return false;
  if (hasAdminRole(auth)) return true;
  const uid = String(auth.userId);
  const shipperId = String(load.shipper_id ?? load.shipperId ?? "");
  const carrierId = String(load.assigned_carrier_id ?? load.assignedCarrierId ?? "");
  return shipperId === uid || (carrierId && carrierId === uid);
}

module.exports = { hasAdminRole, canReadLoad };
