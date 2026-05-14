#!/usr/bin/env node
/**
 * Safe development utility: clears OTP / pending-signup state for ONE email you pass in.
 * Does not touch other users. Never deletes the users row unless you pass --delete-user AND
 * the email is listed in DEV_AUTH_TEST_EMAILS (double safety).
 *
 * Usage (from repo root or transpak-backend):
 *   node scripts/devResetTestAuth.js --email=tester@example.com
 *   node scripts/devResetTestAuth.js --email=tester@example.com --unverify-user
 *   node scripts/devResetTestAuth.js --email=tester@example.com --delete-user
 *
 * Refuses to run when NODE_ENV=production.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { isProductionRuntime, getDevAuthTestEmailSet } = require("../utils/devAuthMode");
const { resetTestAccountByEmail } = require("../services/devAuthTestState");

function parseArgs(argv) {
  const out = { email: null, unverifyUser: false, deleteUserRow: false, help: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--email=")) out.email = a.slice("--email=".length).trim().toLowerCase();
    else if (a === "--unverify-user") out.unverifyUser = true;
    else if (a === "--delete-user") out.deleteUserRow = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    // eslint-disable-next-line no-console
    console.log(`
devResetTestAuth.js — clear pending_registrations + OTP tables for one email.

  --email=you@domain.com   (required)
  --unverify-user          set users.verified = false for that email (row kept)
  --delete-user            DELETE users row — ONLY if email is in DEV_AUTH_TEST_EMAILS

Refused when NODE_ENV=production.
`);
    process.exit(0);
  }

  if (isProductionRuntime()) {
    // eslint-disable-next-line no-console
    console.error("[devResetTestAuth] Refusing to run: NODE_ENV is production.");
    process.exit(1);
  }

  if (!args.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email)) {
    // eslint-disable-next-line no-console
    console.error("[devResetTestAuth] Provide a valid --email=user@domain.com");
    process.exit(1);
  }

  if (args.deleteUserRow && !getDevAuthTestEmailSet().has(args.email)) {
    // eslint-disable-next-line no-console
    console.error(
      "[devResetTestAuth] --delete-user only allowed when the email is listed in DEV_AUTH_TEST_EMAILS (safety)."
    );
    process.exit(1);
  }

  await resetTestAccountByEmail({
    email: args.email,
    unverifyUser: args.unverifyUser,
    deleteUserRow: args.deleteUserRow
  });

  // eslint-disable-next-line no-console
  console.log("[devResetTestAuth] OK:", {
    email: args.email,
    cleared: ["pending_registrations", "email_otp_challenges", "auth_otp_codes"],
    unverifyUser: args.unverifyUser,
    deleteUserRow: args.deleteUserRow
  });
  process.exit(0);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("[devResetTestAuth] failed:", e?.message || e);
  process.exit(1);
});
