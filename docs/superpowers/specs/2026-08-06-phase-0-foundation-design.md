# Phase 0 — Foundation Design

- **Status:** Approved by the product owner on 2026-08-06.
- **Source of truth for behavior:** `docs/PRD.md — Attendance Management PWA.md` (the "bible").
- **Source of truth for resolved values:** `docs/decisions.md`.
- **Prior phase:** UI prototype (`docs/superpowers/specs/2026-08-06-attendance-ui-prototype-design.md`), approved and merged.

## Goal

Build the real foundation of the Vortech HRIS attendance PWA so later phases (online attendance, offline reliability, administration) can be layered on a secure, tenant-isolated base: PostgreSQL schema + migrations, tenant/user/session authentication with superadmin TOTP, a shared tenant-isolation guard, seed data, Docker Compose deployment, and a backup/restore procedure.

This phase replaces the mock data boundary with a real database for the foundation domain only. It does **not** implement attendance capture, GPS/camera, offline sync, reports, or the full admin UI — those are Phases 1–3.

## Non-goals for Phase 0

- Attendance check-in/check-out logic, geofencing, selfies (Phase 1).
- PWA manifest, service worker, IndexedDB offline queue (Phase 2).
- Corrections workflow UI, CSV reports, retention jobs (Phase 3).
- Real user-facing login/dashboard pages beyond the minimal screens needed to prove auth works (Phase 1+).

## Environment

- **Local dev database:** PostgreSQL 17.10 running natively on Windows (service `postgresql-x64-17`). Database `vortech` (UTF8), least-privilege app role `vortech_app`. Credentials live in git-ignored `.env`.
- **Runtime:** Node.js >= 22.18 (project `engines`), npm, Next.js 16.3, React 19, TypeScript.
- **Deployment target:** Docker Compose (`web`, `postgres`, `caddy`) on a single VPS. Docker Desktop 4.85 is installed locally for parity testing but is not required for Phase 0 development.

## Architecture

One Next.js App Router monolith in the existing repo. A thin data-access module wraps `pg` with a connection pool configured from `DATABASE_URL`. **No ORM** (PRD 10). All SQL is parameterized.

### Modules (one clear responsibility each)

- `src/lib/db/pool.ts` — lazily created `pg.Pool` from env; exposes `query`/`withTransaction`.
- `src/lib/db/migrate.ts` — migration runner logic (applied-version tracking, transactional apply).
- `scripts/migrate.ts` — CLI wrapper (`npm run db:migrate`).
- `src/lib/auth/password.ts` — `crypto.scrypt` hash/verify with unique salt, bounded params, timing-safe compare.
- `src/lib/auth/session.ts` — create/lookup/revoke sessions; opaque token in HttpOnly cookie; stores `token_hash`.
- `src/lib/auth/totp.ts` — TOTP secret generation/verification for superadmin (RFC 6238 via Node crypto; no new dependency).
- `src/lib/auth/guard.ts` — the shared server-side request guard: resolves tenant + role from the session and enforces scope.
- `src/lib/auth/rate-limit.ts` — small in-memory login/2FA rate limiter.
- `migrations/*.sql` — numbered, idempotent schema migrations.
- `scripts/seed.ts` — seed data (`npm run db:seed`).
- `scripts/backup.ts` / `scripts/restore.ts` — `pg_dump` backup and restore helpers.

### Schema

Implement all tables from PRD Section 12 with UUID primary keys, `timestamptz` UTC timestamps, and `created_at`/`updated_at`. Enforce:

- `users`: CHECK that email or phone exists; unique partial indexes per tenant for non-null email and phone.
- `work_instances`: UNIQUE `(tenant_id, user_id, work_date, schedule_id)`.
- `attendance_events`: UNIQUE `(tenant_id, user_id, idempotency_key)`.
- Join/team/correction tables: composite FKs or transaction checks that verify matching `tenant_id`.
- `subscriptions`: UNIQUE `tenant_id`. `tenant_branding`: UNIQUE `tenant_id`. `user_roles`/`team_members`/`manager_teams`/`tenant_features`: unique pairs.

Resolved values from `docs/decisions.md` are baked in (per-location radius with no global default, 50 m accuracy / 3 retries, auto-checkout at shift end, 1-year historical retention, selfie/branding limits, plan tiers, manager approve-only, holiday seed, product name).

## Authentication and sessions

- Login identifier is normalized email **or** normalized phone + password (PRD 7.1). At least one is required per user.
- Password verify via `crypto.scrypt`. On success, create a `sessions` row (device label/user-agent, IP where lawful, created/last-seen/expires, revoked_at NULL) and set an HttpOnly, Secure, SameSite=Lax cookie holding the opaque token. DB stores only `token_hash` (SHA-256).
- Logout revokes the current session. Admin can revoke tenant-user sessions; superadmin can revoke any session.
- Deactivated users and revoked/expired sessions cannot authenticate.
- Superadmin must confirm TOTP before privileged session use. TOTP secret is stored encrypted; recovery codes hashed.
- Login and TOTP attempts are rate-limited; failure messages are generic to reduce identifier enumeration.
- CSRF protection for cookie-authenticated mutations (SameSite=Lax plus a per-session CSRF token checked on mutating routes).

## Tenant isolation

A single shared guard (`src/lib/auth/guard.ts`) is the only way privileged requests obtain `tenant_id` and role. It reads the session, resolves the tenant, and returns a scoped context used by all queries. Tenant A must never read or mutate Tenant B data (PRD 6). Isolation is proven by tests, not by UI hiding.

## Seed data

`scripts/seed.ts` creates, idempotently:
- One **superadmin** with TOTP enrolled.
- One **demo tenant** (`vortech-demo`) with one admin, one manager, and one member; two locations; one fixed schedule; plan `trial`.
- The **2026–2027 Indonesian national holiday** seed.

## Deployment

- `Dockerfile` — multi-stage, non-root, builds the Next.js app.
- `docker-compose.yml` — `web`, `postgres`, `caddy` services with named volumes for Postgres data and the private selfie volume.
- `Caddyfile` — reverse proxy + automatic HTTPS, `/ {tenant-slug}` URL pattern preserved.
- `.env.example` — every required variable with non-secret placeholders.
- A scheduled retention/auto-checkout command uses the same `web` image (invoked, not implemented, in Phase 0).

## Backup and restore

- `scripts/backup.ts` runs `pg_dump` to an encrypted archive location outside the VPS.
- `scripts/restore.ts` restores from an archive.
- A documented monthly restore-test procedure is included in `README.md`.

## Error handling

All API/route errors return a stable error code plus a localized, safe message (PRD 13). Never expose stack traces, filesystem paths, or secrets. Structured logs include request id, tenant id, user id, route, status, duration, error code; never log passwords, session tokens, TOTP secrets, or selfie bytes.

## Testing

Node's built-in test runner. Focused, high-risk coverage:
1. Tenant-isolation guard: Tenant A cannot read/mutate Tenant B.
2. Auth: login success/failure, generic message, revocation blocks access, deactivated user blocked.
3. TOTP: setup/confirm/verify round-trip and wrong-code rejection.
4. Migrations: idempotent apply; a fresh DB reaches the same schema.
5. Rate limiting: repeated login failures are throttled.
6. Password: scrypt hash/verify and tamper rejection.

Tests run against a disposable test database created per run, not the dev database.

## Security

HTTPS-only in production (HSTS after stable domain); HttpOnly/Secure/SameSite cookies; parameterized SQL only; tenant scope from session; secrets in `.env` outside source control; containers run non-root; validate all input sizes/bounds.

## Acceptance criteria for Phase 0

- `npm run db:migrate` builds the full schema idempotently on a fresh database.
- `npm run db:seed` creates superadmin + demo tenant + holidays idempotently.
- A user can log in, receive a session cookie, and be denied after revocation/deactivation.
- Superadmin completes TOTP setup and verify.
- Tenant-isolation tests pass proving cross-tenant reads/writes fail.
- `docker-compose up` brings up `web`+`postgres`+`caddy` (verified where Docker is available).
- `npm test`, `npm run typecheck`, `npm run build` all pass.
- Backup and restore scripts run and a restore-test procedure is documented.
