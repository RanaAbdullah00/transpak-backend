# TransPak backend — Render deploy

Production runs **only** from GitHub `main` → `transpak-backend/` (see root `render.yaml`).

## Before every deploy

```bash
cd transpak-backend
npm run predeploy:check   # fails if critical files are uncommitted
git push origin main
```

Render Dashboard → **Manual Deploy** → **Clear build cache** (required after migration or health changes).

## After deploy (logs must show)

```
[deploy] commit=<full-git-sha>
[deploy] time=<iso-timestamp>
[deploy] schema=023
[build] stamp written .render-build-stamp.json <short-sha>
```

## Verify

```bash
npm run verify:production
```

Expect `db: ready`, `schema.ok: true`, normalized commit match, `deploy.bootHealthWait: true`.

## Start command

```
npm run db:migrate && node server.js
```

Migrations run once per deploy (`migration_lock` + `schema_migrations`).
