# TransPak safety test suite

Automated checks for RBAC, bid lifecycle, concurrency, expiry, notifications, and admin observability.

## Prerequisites

1. **PostgreSQL** with migrations applied (`npm run db:migrate`).
2. **API running** locally or at `QA_BASE_URL` (default `http://127.0.0.1:10000`).
3. **Test accounts** in `.env`:

```env
QA_BASE_URL=http://127.0.0.1:10000

E2E_SHIPPER_EMAIL=shipper@example.com
E2E_SHIPPER_PASSWORD=...

E2E_CARRIER_EMAIL=carrier@example.com
E2E_CARRIER_PASSWORD=...

# Required for concurrency test only
E2E_CARRIER2_EMAIL=carrier2@example.com
E2E_CARRIER2_PASSWORD=...

# Required for admin smoke / timing
E2E_ADMIN_EMAIL=admin@example.com
E2E_ADMIN_PASSWORD=...
```

Accounts must be **verified**, **profile-complete** (shipper to post, carrier with truck to bid).

For **self-exclusion** RBAC test, the shipper account needs both `shipper` and `carrier` in `users.roles[]`.

## Commands

From `transpak-backend/`:

```bash
# All tests
npm test

# By area
npm run test:smoke
npm run test:rbac
npm run test:expiry
npm run test:concurrency
npm run test:notifications
npm run test:performance

# Legacy script (login + create load only)
npm run check:api-smoke
```

## What runs without HTTP

- `test/expiry.marketplace.test.js` — only needs `DATABASE_URL` + `E2E_SHIPPER_EMAIL` (to resolve shipper id).

## What is not covered here

- Socket.io reconnect (manual / browser E2E)
- Cloudinary demo video upload bytes
- OTP email delivery
- Multi-instance WebSocket counts on Render
