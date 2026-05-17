/**
 * Shared OTP email delivery envelope (backward-compatible field aliases).
 */

function otpDeliveryHint(reason, context = "generic") {
  const isDev = process.env.NODE_ENV !== "production";
  if (isDev && context === "register" && (!reason || reason === "exception")) {
    return "Development: OTP is printed in the server console if email could not be sent.";
  }

  switch (reason) {
    case "smtp_not_configured":
      return context === "register"
        ? "Email is not configured on the server (BREVO_API_KEY). Finish signup after it is set, or use resend when ready."
        : "Email was not sent: Brevo API is not configured (set BREVO_API_KEY).";
    case "mail_from_missing":
      return context === "register"
        ? "Email sender (BREVO_SENDER_EMAIL) is not configured. Complete verification after it is set."
        : "Email was not sent: set BREVO_SENDER_EMAIL to a verified Brevo sender address.";
    case "authentication_failed":
      return context === "register"
        ? "Brevo API key rejected the request. Use the REST API key (xkeysib-…) from Brevo → SMTP & API."
        : "Email was not sent: Brevo API key is invalid.";
    case "sender_not_verified":
      return context === "register"
        ? "The sender is not verified in Brevo. Verify the address under Senders & IP; BREVO_SENDER_EMAIL must match."
        : "Email was not sent: the sender is not verified in Brevo.";
    case "rate_limited":
      return context === "register"
        ? "Email was temporarily blocked by rate limits. Retry in a few minutes or check Brevo quotas."
        : "Email was not sent: rate limited. Wait and retry.";
    case "send_failed":
      return "Email was not sent. Check Brevo transactional logs or try resend.";
    case "exception":
      return "We could not deliver the verification email. Try resend in a moment.";
    default:
      return context === "register"
        ? "We could not deliver the verification email. Try resend in a moment or contact support if it continues."
        : "Email was not sent. Please try again or contact support.";
  }
}

/**
 * @param {{ delivered: boolean, reason?: string|null, devOtp?: string|null, extra?: object, context?: string, hintOverride?: string|null }} opts
 */
function buildOtpDeliveryData({ delivered, reason = null, devOtp = null, extra = {}, context = "generic", hintOverride = null }) {
  const emailDelivered = Boolean(delivered);
  const deliveryStatus = emailDelivered ? "sent" : "failed";
  const hasDevOtp = Boolean(devOtp);
  const hint =
    hintOverride != null
      ? hintOverride
      : emailDelivered
        ? undefined
        : otpDeliveryHint(reason, context);

  return {
    ...extra,
    sent: emailDelivered || hasDevOtp,
    emailSent: emailDelivered,
    emailDelivered,
    deliveryStatus,
    deliveryFailed: !emailDelivered && !hasDevOtp,
    deliveryReason: !emailDelivered ? reason || undefined : undefined,
    deliveryHint: hint || undefined,
    ...(hasDevOtp ? { devOtp } : {})
  };
}

function buildRegisterEmailVerification(otpPack) {
  const delivered = Boolean(otpPack?.delivery?.delivered);
  const reason = otpPack?.delivery?.reason || null;
  return {
    pending: true,
    ...buildOtpDeliveryData({
      delivered,
      reason,
      devOtp: otpPack?.devOtp || null,
      context: "register"
    })
  };
}

function buildFailedRegisterEmailVerification(message, reason = "exception") {
  return {
    pending: true,
    ...buildOtpDeliveryData({
      delivered: false,
      reason,
      devOtp: null,
      context: "register",
      hintOverride: message
    })
  };
}

function errorCodeForFailure(err) {
  const c = String(err?.code || "");
  if (/^[0-9]{2}/.test(c) || ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "57P01"].includes(c)) {
    return "DATABASE_UNAVAILABLE";
  }
  return "SERVER_ERROR";
}

function statusForErrorCode(code) {
  return code === "DATABASE_UNAVAILABLE" ? 503 : 500;
}

module.exports = {
  otpDeliveryHint,
  buildOtpDeliveryData,
  buildRegisterEmailVerification,
  buildFailedRegisterEmailVerification,
  errorCodeForFailure,
  statusForErrorCode
};
