# Security & ownership audit (Phase 1)

Authority model: see [RBAC.md](./RBAC.md). All checks use `req.auth.roles[]` and `req.auth.userId` — never `activeRole`.

## Central helpers

| Module | Purpose |
|--------|---------|
| `utils/resourceAuth.js` | `canReadLoad`, `canMutate*`, `sendForbidden`, party checks |
| `middleware/authorizeResource.js` | `requireLoadRead`, `requireLoadShipperMutate` |
| `middleware/authMiddleware.js` | JWT + `requireRole` / `requireAnyRole` |
| `middleware/sessionGuards.js` | `requireAdminSession` on `/api/admin/*` |
| `middleware/rejectForbiddenBodyFields.js` | Global mass-assignment guard on `/api` POST/PUT/PATCH |
| `middleware/forbidAdminOnlyCommercial.js` | Platform-only admin blocked from marketplace + operations |

## Route inventory (commercial)

| Area | Auth | Ownership |
|------|------|-----------|
| `GET /loads` | carrier | Open loads only (controller) |
| `GET /loads/mine` | shipper | `shipper_id = userId` |
| `GET /loads/:id` | any commercial | `canReadLoad` |
| `PATCH/DELETE /loads/:id` | shipper | `requireLoadShipperMutate` / owner + open |
| `POST /loads/:id/pass` | carrier | open load only |
| `GET/POST /bids` | role + viewAs | Scoped by carrier_id / load.shipper_id |
| `PUT /bids/:id/*` | shipper/carrier | Join loads; owner checks on bid row |
| `GET /shipments/*` | commercial | `shipper_id` or `assigned_carrier_id` |
| `PUT /shipments/:id/status` | carrier | Party + assigned carrier |
| `PUT /shipments/:id/location` | carrier | Assigned carrier only (GPS) |
| `GET/PUT /trucks/*` | carrier | `user_id = userId` (no admin bypass on commercial) |
| `GET/PATCH/DELETE /carrier-space/*` | role | `carrier_id` on listing |
| `PUT /space-booking/requests/*` | party | Carrier or shipper on request row |
| `GET/POST /notifications/*` | role | `receiver_id` + `notificationScopeClause` |
| `GET/POST /chat/*` | commercial | Conversation membership |
| `GET /profile/:id` | commercial | Public fields; PII gated |
| `POST /reviews` | commercial | Party on completed shipment/space |
| `POST /disputes` | commercial | Shipment party or admin |

## Admin surface

All `/api/admin/*` routes use `router.use(protect, requireAdminSession)` except routes registered before that middleware — verify `adminRoutes.js` order.

## Manual tampering tests

1. User A token + User B `loadId` on `GET /loads/:id` → 403 when not open marketplace and not party.
2. Carrier token + shipper `PATCH /loads/:id` → 403.
3. Carrier token + `PUT /bids/:id/accept` → 403.
4. User A + User B `truck` id on `PUT /trucks/:id` → 403.
5. User A + `PATCH /notifications/:id/read` for B's notification → 404/403.
6. Non-admin + `GET /admin/dashboard/live` → 403.
7. Carrier + closed load assigned to another carrier → 403 on tracking.
8. `PATCH /auth/active-role` with role not on account → 403 (no auto-append to `roles[]`).
9. `POST /loads` body with `shipper_id` / `roles` / `status` → 400 `FORBIDDEN_FIELD`.
10. Platform-only admin + `GET /api/loads` or `GET /api/operations/snapshot` → 403.

## Phase 1 exit checklist

- [ ] `npm run test:phase1` passes (static; HTTP needs `E2E_*` on `QA_BASE_URL`)
- [ ] `npm run deploy:check` passes (build sync + admin route exists + bundle API URL)
- [ ] `npm run deploy:qa` passes on production origins
- [ ] Production `npm run db:migrate` through latest migration
- [ ] Admin JWT → `GET /api/admin/dashboard/live` returns 200 with stats payload
- [ ] Redeploy backend + frontend; `VITE_API_URL` points at Render API (not Pages host)

Run live probe without E2E accounts:

```bash
PHASE1_PROBE_URL=https://transpak-backend-1.onrender.com npm run test:phase1
```

## Automated tests

`test/security.ownership.test.js` — static route guard checks + optional HTTP tampering when `E2E_*` env is set.
