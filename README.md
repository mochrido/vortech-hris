# Attendance Management Prototype

A locally runnable Next.js TypeScript project that hosts the Member, Manager, Admin, and Superadmin attendance-management previews.

## Local Startup

Requirements: Node.js `>=22.18.0` and npm. This baseline lets Node's built-in test runner discover and execute TypeScript tests without an external loader.

```bash
npm install
npm run dev
```

Open `http://localhost:3000` after the development server starts. Use the "Pratinjau sebagai" (Preview as) switcher to move between the four role previews: Member (Anggota), Manager (Manajer), Admin (Administrator), and Superadmin. Each role renders from the same in-memory demo dataset.

Useful checks:

```bash
npm test
npm run lint
npm run typecheck
npm run build
npm run start
```

`npm run lint` currently runs the TypeScript validation check because ESLint is deferred until application code exists. `npm test` uses Node's built-in test runner with native TypeScript type stripping.

## Database

Local dev expects a PostgreSQL database. Copy `.env.example` to `.env` and set `DATABASE_URL` (and `TOTP_ENCRYPTION_KEY`), then:

```bash
npm run db:migrate   # apply migrations (idempotent)
npm run db:seed      # seed superadmin, demo tenant, and holidays (idempotent)
```

### Seed data

`npm run db:seed` is safe to run repeatedly (no duplicates). It creates:

- **Superadmin** — `superadmin@vortech.local` with a confirmed TOTP credential enrolled.
- **Demo tenant** `vortech-demo` (plan `trial`, 25 users) with three users:
  - `admin@vortech-demo.local` (admin)
  - `manager@vortech-demo.local` (manager)
  - `member@vortech-demo.local` (member)
- Two locations (Jakarta HQ, Bandung branch), one fixed Mon–Fri 09:00–17:00 schedule.
- Indonesian national holidays for 2026–2027 (superadmin-editable).

These are **dev-only** accounts. Passwords come from the `SEED_*_PASSWORD` variables in `.env`; when unset, well-known local defaults are used (see `.env.example`). Override them anywhere beyond local development.

## Docker deployment

The app ships as a multi-stage, non-root `Dockerfile` plus a `docker-compose.yml` with three services: `web` (the Next.js app), `postgres` (database), and `caddy` (reverse proxy with automatic HTTPS).

**Runner approach:** the image uses Next.js `output: "standalone"` (see `next.config.ts`). The build emits a self-contained server (`.next/standalone/server.js`) plus traced `node_modules`, so the production image is small and needs no `npm`/full dependency tree. The runner stage runs as the unprivileged `node` user and starts with `node server.js`. This keeps `npm run build` green locally and produces a minimal deploy artifact.

**Prerequisites:** Docker and Docker Compose; a DNS `A`/`AAAA` record for your domain pointing at the host (required for Caddy to obtain a TLS certificate).

1. Copy `.env.example` to `.env` and set real values:
   - `DOMAIN` — public hostname Caddy serves (automatic HTTPS).
   - `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` — database credentials for the in-compose Postgres. The `web` service builds its own `DATABASE_URL` from these (pointing at the `postgres` service), so the `.env` `DATABASE_URL` is only used outside compose.
   - `TOTP_ENCRYPTION_KEY`, session settings, and `BACKUP_*` as needed.
2. Build and start:

   ```bash
   docker compose up -d --build
   ```

   Caddy listens on ports 80/443 and proxies to `web:3000`, obtaining and renewing TLS certificates automatically. Postgres data and Caddy certificates persist in named volumes (`pgdata`, `caddy_data`).

3. Apply migrations and seed (first run), from the host or a one-off container:

   ```bash
   docker compose exec web node --experimental-strip-types scripts/migrate.ts
   docker compose exec web node --experimental-strip-types scripts/seed.ts
   ```

**Health check:** `GET /api/health` returns `200 {"status":"ok"}` when the process and database are reachable, and `503` otherwise, without leaking details. Point your uptime monitor at `https://<DOMAIN>/api/health`.

**Scheduled jobs (retention / auto-checkout):** a `jobs` service runs the **same** `web` image on a schedule. In Phase 0 the job body is a placeholder (the real retention/auto-checkout job lands in Phase 1+); the wiring is in place. Invoke it manually with:

```bash
docker compose --profile jobs run --rm jobs
```

(Scheduling via cron/systemd on the host, or a scheduler, is a deployment concern outside this repo.)

## Backups

`npm run backup` runs `pg_dump` (custom format, compressed) from `DATABASE_URL` into a timestamped archive under `BACKUP_DIR` (default `./backups`, git-ignored) and prints the archive path.

- **Encrypted (recommended):** set `BACKUP_PASSPHRASE`. The archive is encrypted with `openssl` AES-256-CBC + PBKDF2 to `<name>.pg.dump.enc`, and the plaintext copy is removed. Keep the passphrase somewhere safe **off** the host.
- **Unencrypted:** if `BACKUP_PASSPHRASE` is unset, the script warns that the archive is unencrypted and must be moved off-VPS immediately.

> **A backup on the same VPS is not a backup (PRD 15).** After each nightly backup, copy the archive (and the private selfie volume) to a location **outside** the VPS — e.g. object storage or another host. Automate the copy as part of the nightly job; that off-VPS step is an operational requirement, not handled by this script.

```bash
npm run backup          # writes backups/vortech-<timestamp>.pg.dump[.enc]
```

## Restore

`npm run restore -- <archive>` restores a dump into `DATABASE_URL` using `pg_restore --clean --if-exists`. It is **destructive**, so it requires a confirmation guard:

- `RESTORE_CONFIRM` must equal the target database name (parsed from `DATABASE_URL`).
- If the archive ends in `.enc`, it is decrypted first with `BACKUP_PASSPHRASE`. Set `RESTORE_DECRYPT=1`/`0` to force or skip decryption regardless of the suffix.

```bash
RESTORE_CONFIRM=vortech BACKUP_PASSPHRASE=... npm run restore -- backups/vortech-2026-08-06T12-30-45-123Z.pg.dump.enc
```

### Monthly restore test (required before production launch, PRD 15)

Verify backups are actually restorable every month by restoring into a **scratch** database — never over production:

1. Create a scratch database owned by the connecting role (so it has `CREATE` on the `public` schema), or use a throwaway compose Postgres:
   `createdb -O vortech_app vortech_restore_test` (as a superuser), or point `DATABASE_URL` at a scratch instance you own.
2. Restore the latest off-VPS archive into it:
   `DATABASE_URL=postgresql://...@.../vortech_restore_test RESTORE_CONFIRM=vortech_restore_test BACKUP_PASSPHRASE=... npm run restore -- <archive>`
3. Verify: run `npm run db:migrate` against the scratch DB (confirms schema integrity) and spot-check row counts / log in with a known account.
4. Drop the scratch database. Record the test date and result.

If any step fails, treat it as an incident: fix the backup pipeline before relying on it.


## Prototype Limits

All displayed data and actions are mock-only and held in memory. The role switcher is a review tool, not authorization. This phase does not make camera or GPS calls, persist to a database, upload images, or provide real authentication, offline storage, or server-side access control.

Do not add secrets to this repository. Use `.env.example` only as a list of non-secret local placeholders; local `.env` files are ignored.
