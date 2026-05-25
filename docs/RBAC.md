# TransPak RBAC contract (production)

## Authority model

| Layer | Source | Purpose |
|-------|--------|---------|
| **roles[]** | PostgreSQL `users.roles` | **Only** permission source (`requireRole`, `requireAnyRole`) |
| **activeRole** | PostgreSQL `users.active_role` | **Frontend UI only** — returned on `user` in API payloads, never in `req.auth` |
| **JWT** | `sub` (user id) | **Identity only** — middleware loads DB via `buildAuthContextFromDB(sub)` |
| **viewAs** | Query `?viewAs=shipper\|carrier` | **Optional dataset hint** — must pass `validateViewAs()` middleware |

## Backend rules

1. Every protected business route uses `requireAuth` + (`requireRole` or `requireAnyRole`).
2. `req.auth` shape: `{ user, userId, roles }` — no `activeRole` on `req.auth`.
3. List endpoints scope data by `roles[]` and/or validated `req.commercialView` (from `validateViewAs`).
4. `validateViewAs`: if `?viewAs` is present, it must be `shipper` or `carrier` **and** `viewAs ∈ req.auth.roles`, else `403 FORBIDDEN_VIEW_AS`.
5. Resource overrides use `utils/resourceAuth.js` (`hasAdminRole`, `canReadLoad`) — admin requires `roles.includes('admin')`.
6. Notifications: SQL scoped by `notificationScopeClause({ roles })` only.
7. Admin routes: `router.use(protect, requireAdminSession)` where `requireAdminSession = requireRole('admin')`.

## Frontend rules

1. Route visibility: `user.roles` (e.g. `ProtectedRoute`, `canAccessAdminRoutes`).
2. Layout/workspace: `user.activeRole` only.
3. List APIs: may pass `viewAs` via `workspaceApi.viewAsQuery(user)` — hint only; server enforces.
4. Never block API calls based on frontend role alone.

## Files

| File | Role |
|------|------|
| `middleware/authMiddleware.js` | `requireAuth`, `requireRole`, `requireAnyRole`, exports `validateViewAs` |
| `middleware/validateViewAs.js` | Query param safety |
| `utils/authContext.js` | DB auth context builder |
| `utils/commercialViewRole.js` | Resolve list view after validation |
| `utils/notificationScope.js` | Inbox SQL scope by roles[] |
| `utils/resourceAuth.js` | Admin + load read helpers |

## Role switch

`PATCH /auth/active-role` updates `users.active_role` (DB) and returns fresh user + JWT. Not used for authorization.
