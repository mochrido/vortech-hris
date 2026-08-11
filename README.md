# Attendance Management Prototype

A locally runnable Next.js TypeScript project that hosts the Member, Manager, Admin, and Superadmin attendance-management previews.

## Local Startup

Requirements: Node.js `>=22.18.0` and npm. This baseline lets Node's built-in test runner discover and execute TypeScript tests without an external loader.

```bash
npm install
npm run dev
```

Open `http://localhost:3000/vortech-demo/login` after the development server starts (requires the migrated + seeded database from the next section) and log in with one of the seeded dev accounts below. The superadmin console login is at `http://localhost:3000/sa/login`. The original mock-data prototype still lives at `http://localhost:3000/`: its "Pratinjau sebagai" (Preview as) switcher moves between the four role previews — Member (Anggota), Manager (Manajer), Admin (Administrator), and Superadmin — all rendered from the same in-memory demo dataset. The prototype is a review tool only; the real app under `/[tenant]/…` is what Phase 1 delivers.

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

**Logging in (Phase 1 app):** tenant users (admin / manager / member) log in at `/{tenant}/login` — for the seeded demo tenant that is `/vortech-demo/login` — with their email and seed password. The superadmin logs in separately at `/sa/login`. From there, role guards land each account on its surface: member dashboard (`/vortech-demo/dashboard`), manager dashboard (`/vortech-demo/manager`), and the admin config pages (`/vortech-demo/admin/…`).

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

**Scheduled jobs (auto-checkout):** a `jobs` service runs the **same** `web` image. Since Phase 1 it runs the real shift-end auto-checkout job (`scripts/jobs/auto-checkout.ts`, decisions.md #3): work instances whose scheduled shift ended without a check-out are closed, marked `needs_review` with an event sourced `system_auto_checkout`, and have worked minutes computed. The job is idempotent, so it is safe to run repeatedly or on a schedule. Invoke it manually with:

```bash
docker compose --profile jobs run --rm jobs
```

(Scheduling via cron/systemd on the host, or a scheduler, is a deployment concern outside this repo.)

## Phone testing over LAN (HTTPS)

Camera and geolocation are only available to a page in a **secure context**, which browsers grant over HTTPS (or on `localhost`). A phone on the same Wi-Fi cannot use the PC's `localhost`, so to test check-in on a real phone the app must be reachable over **HTTPS at the PC's LAN IP**. The production `Caddyfile` uses a public domain with ACME certificates, which can't work for a non-routable LAN IP, so this repo ships an **opt-in LAN config** instead: `Caddyfile.lan` + a `docker-compose.lan.yml` override. The default production path (`Caddyfile` + `DOMAIN`) is untouched.

How it works: `Caddyfile.lan` serves `https://<LAN_IP>` with Caddy's `tls internal`, so Caddy issues the site certificate from its own local CA ("Caddy Local Authority") instead of a public ACME CA. On first run Caddy generates that CA and stores its root certificate in the `caddy_data` volume at `/data/caddy/pki/authorities/local/root.crt`. Because no public CA is involved, the phone won't trust the cert until you either install that root cert on the phone or proceed past the browser warning.

**Steps**

1. **Find the PC's LAN IP.** It must be the address on the same network the phone's Wi-Fi is on.
   - Windows (PowerShell): `ipconfig` → look for the adapter's `IPv4 Address`.
   - macOS: `ipconfig getifaddr en0`
   - Linux: `hostname -I`
2. **Set `LAN_IP` in `.env`** to that address, e.g. `LAN_IP=192.168.1.50`. (`.env.example` documents the variable; it is a non-secret placeholder.)
3. **Start the stack with the LAN override** (both compose files):

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.lan.yml up -d --build
   ```

   The override only re-points the `caddy` service at `Caddyfile.lan` and passes `LAN_IP`; `web` and `postgres` are unchanged. On first run, apply migrations and seed as usual:

   ```bash
   docker compose exec web node --experimental-strip-types scripts/migrate.ts
   docker compose exec web node --experimental-strip-types scripts/seed.ts
   ```

4. **Make the phone trust the certificate** (recommended). Copy Caddy's local root cert out of the volume and install it on the phone:

   ```bash
   docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-local-root.crt
   ```

   Transfer `caddy-local-root.crt` to the phone (email, USB, cloud drive), then:
   - **Android:** Settings → Security & privacy → More security & privacy → Encryption & credentials → Install a certificate → **CA certificate** → "Install anyway" → pick the file. Chrome on Android trusts user-installed CAs for websites, so the warning clears.
   - **iPhone:** send the `.crt` to the phone (AirDrop / Mail) → Settings → **Profile Downloaded** → Install; then Settings → General → About → **Certificate Trust Settings** → enable full trust for "Caddy Local Authority".

   **Or skip trust (quick pass):** open the URL and proceed past the warning — Chrome: **Advanced → Proceed to \<ip\> (unsafe)** (if no Proceed button shows, click the page and type `thisisunsafe`). The connection is still HTTPS, so camera/GPS work after the bypass, but the warning returns each session and some browsers are stricter — installing the root cert is the reliable path.
5. **Open the app on the phone** (same Wi-Fi): `https://<LAN_IP>/vortech-demo/login`, log in as the member, and check in — the camera and location prompts should now appear.

**Notes / troubleshooting**
- Allow inbound TCP 80/443 through the PC's firewall, and make sure the phone and PC are on the same Wi-Fi (guest networks / "AP isolation" block peer traffic).
- If the PC's LAN IP changes (DHCP), update `LAN_IP` in `.env` and re-run the `up` command; the cert is re-issued for the new IP.
- To return to the normal path, stop the LAN stack and start the default one:

  ```bash
  docker compose -f docker-compose.yml -f docker-compose.lan.yml down
  docker compose up -d
  ```

## Manual QA checklist (phone)

Run this on a real phone over LAN HTTPS (previous section) to accept Phase 1. It is manual by design — not automated.

**One-time data setup.** The seed creates the tenant, users, two locations, and a Mon–Fri schedule, but it does **not** assign a schedule or location to the member (that admin write UI is Phase 3). Assign them with SQL against the dev DB so the member has a workable day. Run on a working weekday that is not a seeded national holiday:

```sql
-- Assign the fixed schedule to the demo member (from today, open-ended).
-- tenant_id is NOT NULL on these assignment tables (migration 0007).
INSERT INTO user_schedule_assignments (tenant_id, user_id, schedule_id, effective_from)
SELECT u.tenant_id, u.id, s.id, CURRENT_DATE
FROM users u
JOIN schedules s ON s.tenant_id = u.tenant_id AND s.name = 'Jam Kantor Tetap'
WHERE u.email_normalized = 'member@vortech-demo.local'
  AND NOT EXISTS (
    SELECT 1 FROM user_schedule_assignments usa
    WHERE usa.user_id = u.id AND usa.schedule_id = s.id
  );

-- Assign the Jakarta HQ location to the demo member.
INSERT INTO user_locations (tenant_id, user_id, location_id)
SELECT u.tenant_id, u.id, l.id
FROM users u
JOIN locations l ON l.tenant_id = u.tenant_id AND l.name = 'Kantor Pusat Jakarta'
WHERE u.email_normalized = 'member@vortech-demo.local'
  AND NOT EXISTS (
    SELECT 1 FROM user_locations ul
    WHERE ul.user_id = u.id AND ul.location_id = l.id
  );
```

To make the geofence cases easy to trigger, point the assigned location at where you actually are (update its `latitude`/`longitude`, or just shrink/expand `radius_m`): standing inside the radius = "inside"; setting `radius_m` very small (e.g. `1`) while standing still reliably forces "outside". To exercise the advisory path, flip the member to a field worker (`UPDATE users SET employment_type = 'field_worker' WHERE email_normalized = 'member@vortech-demo.local';`), which resolves the optional geofence default.

**Checklist**

- [ ] **Camera permission prompt** — on first capture the browser asks for camera access; granting it shows the live preview.
- [ ] **GPS accuracy** — the capture waits for a fix and reports accuracy; indoors/poor signal it retries (≤3) before allowing submission.
- [ ] **Watermark on the selfie** — the captured photo shows the timestamp, name, coordinates, and location label burned in.
- [ ] **Mandatory-geofence block** — with the member as a mandatory (`employee`) worker outside all assigned locations, check-in is **blocked** (no event recorded).
- [ ] **Advisory/optional-geofence flag** — with the member as a `field_worker` outside the geofence, check-in is **accepted** but flagged (`outside_geofence` anomaly / needs review).
- [ ] **Idempotent retry** — submit the same check-in twice (e.g. retry after a network hiccup with the same idempotency key); the second returns the original event and creates **no** duplicate record.
- [ ] **Late/worked minutes** — after a late check-in and a later check-out, the member dashboard (`/vortech-demo/dashboard`) and manager dashboard (`/vortech-demo/manager`) show the computed late and worked minutes.

## Backups

`npm run backup` runs `pg_dump` (custom format, compressed) from `DATABASE_URL` into a timestamped archive under `BACKUP_DIR` (default `./backups`, git-ignored) and prints the archive path.

- **Encrypted (recommended):** set a strong, unique `BACKUP_PASSPHRASE` in your `.env` to enable encryption. The archive is encrypted with `openssl` AES-256-CBC + PBKDF2 to `<name>.pg.dump.enc`, and the plaintext copy is removed. Keep the passphrase somewhere safe **off** the host.
- **Unencrypted (default):** `BACKUP_PASSPHRASE` is commented out in `.env.example`, so by default the script warns loudly that the archive is unencrypted and must be moved off-VPS immediately.

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


## Current State

Phase 0 (foundation) and Phase 1 (online attendance) are implemented.

**Phase 1 (online attendance)** delivers, against the real backend:
- **Tenant login + auth API** — `/[tenant]/login` and `/sa/login` posting to `/api/v1/auth/*`, with rate-limited, non-enumerating credential checks.
- **Online check-in/out** — `/[tenant]/dashboard` captures a camera selfie + GPS fix, watermarks and resizes it client-side, and posts it with an idempotency key; the server recomputes geofence verdict (mandatory-block / advisory-flag), lateness, and status from the raw proof.
- **Attendance calculations** — cross-midnight schedule resolution, holidays, effective assignment, late/worked minutes.
- **Dashboards** — member (`/[tenant]/dashboard`, `/[tenant]/history`) and manager (`/[tenant]/manager`, team-today status).
- **Auto-checkout job** — the `jobs` service closes shift-ended open work instances (source `system_auto_checkout`), idempotently.
- **Object storage** — private, opaque-id selfie storage with integrity checks, streamed only to authorized same-tenant sessions.
- **LAN HTTPS phone testing** — `Caddyfile.lan` + `docker-compose.lan.yml` (see "Phone testing over LAN (HTTPS)").
- **Admin config surface** — `/[tenant]/admin/locations|policies|schedules` are present as read shells; full admin write is Phase 3.

The mock-data prototype at `/` is now **superseded** by the real app: its role switcher remains a review tool (not authorization) and it does not use the backend. The real app lives under `/[tenant]/…` (login at `/vortech-demo/login`, superadmin at `/sa/login`). Remaining work is offline/PWA sync (Phase 2) and corrections, reports, retention, and the full admin UI (Phase 3).

Do not add secrets to this repository. Use `.env.example` only as a list of non-secret local placeholders; local `.env` files are ignored.
