# Phase 0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the real foundation of the Vortech HRIS attendance PWA: PostgreSQL schema + migrations, tenant/user/session authentication with superadmin TOTP, a shared tenant-isolation guard, seed data, Docker Compose deployment, and backup/restore — per the PRD and `docs/decisions.md`.

**Architecture:** Next.js App Router monolith. A thin `src/lib/db` module wraps `pg` with a pool from `DATABASE_URL`; no ORM, parameterized SQL only. Auth is server-side: `crypto.scrypt` passwords, opaque session token in an HttpOnly cookie with `token_hash` in the DB, TOTP via Node's built-in HMAC. A single server-side guard resolves tenant + role from the session for all privileged queries.

**Tech Stack:** Node.js >= 22.18, Next.js 16.3, React 19, TypeScript, PostgreSQL 17, `pg`, Docker Compose (web/postgres/caddy). Tests: Node built-in runner. **Only new runtime dependency: `pg` (+ `@types/pg` dev).** No other auth/ORM/TOTP library.

**Authoritative references:** `docs/PRD.md — Attendance Management PWA.md` (behavior), `docs/decisions.md` (resolved values), `docs/superpowers/specs/2026-08-06-phase-0-foundation-design.md` (this design).

**Local dev database:** PostgreSQL 17.10 native on Windows. Database `vortech`, app role `vortech_app`, superuser `postgres`. These are dev-only credentials; real passwords live in git-ignored `.env`, never in tracked files. `DATABASE_URL` for dev: `postgresql://vortech_app:<password>@127.0.0.1:5432/vortech`; `TEST_DATABASE_ADMIN_URL` for tests: `postgresql://postgres:<password>@127.0.0.1:5432/postgres`. Real values are in `.env`.

---

## File Map

- Create: `migrations/0001_core_identity.sql` … `0006_files_jobs.sql` — numbered schema.
- Create: `src/lib/db/pool.ts`, `src/lib/db/migrate.ts`; `scripts/migrate.ts`.
- Create: `src/lib/auth/password.ts`, `session.ts`, `totp.ts`, `guard.ts`, `rate-limit.ts`, `errors.ts`.
- Create: `src/lib/auth/*.test.ts`, `src/lib/db/migrate.test.ts`, `src/lib/auth/isolation.test.ts`.
- Create: `scripts/seed.ts`, `scripts/backup.ts`, `scripts/restore.ts`.
- Create: `Dockerfile`, `docker-compose.yml`, `Caddyfile`, `.dockerignore`.
- Modify: `package.json` (add `pg`, `@types/pg`, scripts `db:migrate`, `db:seed`, `backup`, `restore`), `.env.example`, `README.md`.
- Test infra: `src/lib/test/db.ts` (disposable test database helper).

---

### Task 1: Database layer, env, and migration runner

**Files:**
- Create: `src/lib/db/pool.ts`
- Create: `src/lib/db/migrate.ts`
- Create: `scripts/migrate.ts`
- Create: `src/lib/test/db.ts`
- Modify: `package.json`
- Modify: `.env.example`
- Test: `src/lib/db/migrate.test.ts`

- [ ] **Step 1: Add `pg` and scripts**

In `package.json` add dependency `"pg": "^8.13.0"` and devDependency `"@types/pg": "^8.11.0"`. Add scripts: `"db:migrate": "node --experimental-strip-types scripts/migrate.ts"`, `"db:seed": "node --experimental-strip-types scripts/seed.ts"`, `"backup": "node --experimental-strip-types scripts/backup.ts"`, `"restore": "node --experimental-strip-types scripts/restore.ts"`. Run `npm install`.

- [ ] **Step 2: Write `.env.example` entries**

Add (no secrets, placeholders only):
```
DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/vortech
SESSION_COOKIE_NAME=vortech_session
SESSION_TTL_HOURS=720
TOTP_ENCRYPTION_KEY=replace-with-32-byte-hex
APP_ORIGIN=http://localhost:3000
```

- [ ] **Step 3: Implement `src/lib/db/pool.ts`**

```ts
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new Pool({ connectionString, max: 10 });
  }
  return pool;
}

export async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<QueryResult<R>> {
  return getPool().query<R>(text, params);
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}
```

- [ ] **Step 4: Implement `src/lib/db/migrate.ts`**

Reads `migrations/*.sql` sorted by filename, tracks applied versions in a `schema_migrations(version TEXT PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())` table, applies pending migrations each in a transaction, idempotent. Export `runMigrations(pool, migrationsDir)` returning applied version list.

- [ ] **Step 5: Implement `src/lib/test/db.ts`**

`createTestDatabase()` connects as superuser (`TEST_DATABASE_ADMIN_URL` or derived from `DATABASE_URL`), creates a uniquely named DB `vortech_test_<rand>`, returns its URL; `dropTestDatabase(name)` drops it. Tests use these to run migrations on a fresh DB.

- [ ] **Step 6: Write failing test `src/lib/db/migrate.test.ts`**

Assert: running migrations on a fresh test DB creates `schema_migrations`; running twice is a no-op (idempotent); a known table exists after migrate.

- [ ] **Step 7: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="migrate"`. Expected: FAIL (no migrations yet / runner incomplete).

- [ ] **Step 8: Make it pass**

Create a minimal `migrations/0001_core_identity.sql` (see Task 2 for full content; for this task a stub creating `tenants` is enough to prove the runner). Implement runner. Re-run; Expected: PASS.

- [ ] **Step 9: Commit**

`git add` the above; `git commit -m "feat: add db pool and migration runner"`.

---

### Task 2: Core identity, tenancy, and subscription schema

**Files:**
- Create: `migrations/0001_core_identity.sql` (tenants, users, user_roles, teams, team_members, manager_teams)
- Create: `migrations/0002_auth.sql` (sessions, totp_credentials)
- Create: `migrations/0003_subscription_branding.sql` (subscriptions, tenant_features, tenant_branding)
- Test: `src/lib/db/schema.test.ts`

- [ ] **Step 1: Write the failing schema test**

`src/lib/db/schema.test.ts`: after migrate on a fresh test DB, assert tables exist; assert `users` rejects a row with neither email nor phone (CHECK); assert duplicate non-null email within a tenant fails; assert same email across different tenants succeeds; assert `subscriptions.tenant_id` unique.

- [ ] **Step 2: Run to verify fail** — `npm test -- --test-name-pattern="schema"`. Expected: FAIL.

- [ ] **Step 3: Write `0001_core_identity.sql`**

`tenants(id uuid PK gen_random_uuid(), slug text UNIQUE NOT NULL, legal_name text NOT NULL, display_name text NOT NULL, timezone text NOT NULL DEFAULT 'Asia/Jakarta', status text NOT NULL DEFAULT 'active', default_radius_m int NULL, max_accuracy_m int NOT NULL DEFAULT 50, worker_labels_json jsonb NOT NULL DEFAULT '{}', historical_retention_days int NOT NULL DEFAULT 365, created_at, updated_at)`. `users(id uuid PK, tenant_id uuid NOT NULL REFERENCES tenants(id), display_name text NOT NULL, email_normalized text NULL, phone_e164 text NULL, password_hash text NOT NULL, employment_type text NOT NULL DEFAULT 'employee', active boolean NOT NULL DEFAULT true, created_by uuid NULL, created_at, updated_at, CHECK (email_normalized IS NOT NULL OR phone_e164 IS NOT NULL))`. Unique partial indexes: `CREATE UNIQUE INDEX users_tenant_email ON users(tenant_id, email_normalized) WHERE email_normalized IS NOT NULL;` and same for `phone_e164`. `user_roles(user_id uuid REFERENCES users(id) ON DELETE CASCADE, role text NOT NULL, UNIQUE(user_id, role))`. `teams(id uuid PK, tenant_id uuid NOT NULL REFERENCES tenants(id), name text NOT NULL, active boolean NOT NULL DEFAULT true, ...)`. `team_members(team_id, user_id, UNIQUE(team_id,user_id))`. `manager_teams(manager_user_id, team_id, UNIQUE(manager_user_id,team_id))`.

- [ ] **Step 4: Write `0002_auth.sql`**

`sessions(id uuid PK, tenant_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES users(id), token_hash text UNIQUE NOT NULL, user_agent text, device_label text, ip inet, created_at timestamptz, last_seen_at timestamptz, expires_at timestamptz NOT NULL, revoked_at timestamptz NULL)`. `totp_credentials(user_id uuid PRIMARY KEY REFERENCES users(id), encrypted_secret text NOT NULL, confirmed_at timestamptz NULL, recovery_codes_hash text NULL)`.

- [ ] **Step 5: Write `0003_subscription_branding.sql`**

`subscriptions(id uuid PK, tenant_id uuid UNIQUE NOT NULL REFERENCES tenants(id), plan_key text NOT NULL DEFAULT 'trial', status text NOT NULL DEFAULT 'trial', user_limit int NOT NULL DEFAULT 25, period_start date, period_end date, notes text, created_at, updated_at)`. `tenant_features(tenant_id uuid REFERENCES tenants(id), feature_key text NOT NULL, enabled boolean NOT NULL DEFAULT false, UNIQUE(tenant_id, feature_key))`. `tenant_branding(tenant_id uuid PRIMARY KEY REFERENCES tenants(id), app_name text, company_name text, primary_color text, logo_object_id uuid NULL, icon_object_id uuid NULL, splash_object_id uuid NULL, version int NOT NULL DEFAULT 1, updated_at)`.

- [ ] **Step 6: Run to verify pass** — `npm test -- --test-name-pattern="schema"`. Expected: PASS.

- [ ] **Step 7: Commit** — `git commit -m "feat: add core identity and tenancy schema"`.

---

### Task 3: Location, schedule, attendance, corrections, files schema

**Files:**
- Create: `migrations/0004_locations_schedules.sql`
- Create: `migrations/0005_attendance.sql`
- Create: `migrations/0006_files_jobs.sql`
- Test: `src/lib/db/schema-attendance.test.ts`

- [ ] **Step 1: Failing test** — assert `work_instances` unique `(tenant_id,user_id,work_date,schedule_id)`; `attendance_events` unique `(tenant_id,user_id,idempotency_key)`; `holidays` allows NULL tenant (national).

- [ ] **Step 2: Run to verify fail** — Expected: FAIL.

- [ ] **Step 3: Write `0004_locations_schedules.sql`** — `locations`, `user_locations`, `attendance_policies`, `user_policy_assignments`, `schedules`, `schedule_days`, `user_schedule_assignments`, `holidays` per PRD 12. `locations.radius_m int NULL` (per-location; NULL means invalid until set — enforced by app/seed, documented), `user_schedule_assignments` with effective range; add an exclusion or check approach comment for overlapping assignments (enforced at transaction boundary in Phase 1; Phase 0 adds the columns + a non-overlap exclusion constraint if `btree_gist` is acceptable, otherwise document service enforcement).

- [ ] **Step 4: Write `0005_attendance.sql`** — `work_instances`, `attendance_events`, `attendance_anomalies`, `correction_requests`, `audit_events` per PRD 12 with the uniques and FK tenant checks.

- [ ] **Step 5: Write `0006_files_jobs.sql`** — `stored_objects`, `job_runs` per PRD 12.

- [ ] **Step 6: Run to verify pass** — Expected: PASS. Commit: `git commit -m "feat: add attendance and operations schema"`.

---

### Task 4: Password hashing and rate limiting

**Files:**
- Create: `src/lib/auth/password.ts`, `src/lib/auth/rate-limit.ts`, `src/lib/auth/errors.ts`
- Test: `src/lib/auth/password.test.ts`, `src/lib/auth/rate-limit.test.ts`

- [ ] **Step 1: Failing tests** — `hashPassword`/`verifyPassword` round-trip; wrong password rejected; tampered hash rejected; two hashes of same password differ (salt). Rate limiter: allows N attempts then blocks; resets after window.

- [ ] **Step 2: Run to verify fail** — Expected: FAIL.

- [ ] **Step 3: Implement `password.ts`** — `crypto.scrypt` with `randomBytes(16)` salt, `N=16384,r=8,p=1`, 32-byte key; store as `scrypt$N$r$p$saltb64$keyb64`; verify parses and `timingSafeEqual`.

- [ ] **Step 4: Implement `rate-limit.ts`** — in-memory `Map<key, {count, resetAt}>`; `checkRateLimit(key, max, windowMs)` returns allowed boolean and increments; `resetRateLimit(key)`.

- [ ] **Step 5: Implement `errors.ts`** — `AppError { code, message, status }` and helpers returning `{ code, message }` localized-safe objects; never stack traces.

- [ ] **Step 6: Run to verify pass** — Expected: PASS. Commit: `git commit -m "feat: add password hashing and rate limiting"`.

---

### Task 5: Sessions, TOTP, and tenant-isolation guard

**Files:**
- Create: `src/lib/auth/session.ts`, `src/lib/auth/totp.ts`, `src/lib/auth/guard.ts`
- Test: `src/lib/auth/session.test.ts`, `src/lib/auth/totp.test.ts`, `src/lib/auth/isolation.test.ts`

- [ ] **Step 1: Failing tests** — session create sets cookie + stores `token_hash` (raw token not stored); lookup returns user for valid token; revoked/expired returns null; deactivated user blocked. TOTP: `generateTotpSecret`, `verifyTotp(secret, code)` accepts current code, rejects wrong. Isolation: guard resolves tenant from session; a query for Tenant B id under Tenant A session returns no rows / is rejected.

- [ ] **Step 2: Run to verify fail** — Expected: FAIL.

- [ ] **Step 3: Implement `session.ts`** — `createSession(userId, meta)` → inserts row, returns raw token (`randomBytes(32).toString('base64url')`) and cookie attributes (HttpOnly, Secure when `APP_ORIGIN` is https, SameSite=Lax, path=/, maxAge from `SESSION_TTL_HOURS`). `getSessionByToken(token)` → sha256 lookup, checks `revoked_at IS NULL`, `expires_at > now()`, joins user and checks `active`. `revokeSession(id)` / `revokeUserSessions(userId, tenantId)`.

- [ ] **Step 4: Implement `totp.ts`** — base32 secret from `randomBytes(20)`; `verifyTotp` computes HMAC-SHA1 over 30s counter, dynamic truncation, 6 digits, allows ±1 window; encrypt/decrypt secret with AES-256-GCM using `TOTP_ENCRYPTION_KEY`.

- [ ] **Step 5: Implement `guard.ts`** — `requireSession(req)` → resolves session; `requireRole(req, roles)` → checks `user_roles`; `tenantScope(req)` → returns `{ tenantId, userId, roles }`; helpers run queries with `WHERE tenant_id = $1` bound from the session. Never accept tenant id from the client.

- [ ] **Step 6: Run to verify pass** — Expected: PASS. Commit: `git commit -m "feat: add sessions, totp, and tenant guard"`.

---

### Task 6: Seed data and holiday import

**Files:**
- Create: `scripts/seed.ts`, `src/lib/seed/holidays.ts` (2026–2027 Indonesian national holidays data)
- Test: `src/lib/seed/seed.test.ts`

- [ ] **Step 1: Failing test** — seeding a fresh test DB creates one superadmin, one tenant `vortech-demo`, admin/manager/member users, two locations, one schedule, plan `trial`, and holidays rows; running seed twice is idempotent (no duplicates).

- [ ] **Step 2: Run to verify fail** — Expected: FAIL.

- [ ] **Step 3: Implement `holidays.ts`** — array of `{ date, name, kind: 'national' }` for Indonesian national holidays 2026–2027.

- [ ] **Step 4: Implement `seed.ts`** — idempotent upserts keyed by stable slugs/emails; superadmin with TOTP enrolled; demo tenant + users (hashed dev passwords from env or fixed dev-only values), locations with radii, fixed schedule, subscription `trial`/25 users.

- [ ] **Step 5: Run to verify pass** — Expected: PASS. Commit: `git commit -m "feat: add seed data and holidays"`.

---

### Task 7: Docker deployment, backup/restore, and docs

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `Caddyfile`
- Create: `scripts/backup.ts`, `scripts/restore.ts`
- Modify: `README.md`, `.env.example`
- Test: `src/lib/scripts/backup.test.ts` (if logic is testable without docker)

- [ ] **Step 1: `Dockerfile`** — multi-stage: `node:22-alpine` deps → build → slim non-root runner; `USER node`; `EXPOSE 3000`; `CMD ["node","server.js"]` or `npm start`.

- [ ] **Step 2: `docker-compose.yml`** — services `web` (build ., env, depends_on postgres, ports), `postgres:17-alpine` (named volume `pgdata`, env POSTGRES_*), `caddy:2-alpine` (ports 80/443, volume `Caddyfile`, `caddy_data`). Add a `jobs` profile service using the `web` image to run the scheduled retention/auto-checkout command.

- [ ] **Step 3: `Caddyfile`** — `{$DOMAIN}` block, `reverse_proxy web:3000`, automatic HTTPS, security headers.

- [ ] **Step 4: `backup.ts` / `restore.ts`** — wrap `pg_dump`/`pg_restore` (or plain SQL dump) with timestamped output and a documented off-VPS destination; restore reads an archive. Keep simple and parameterized from env.

- [ ] **Step 5: README** — document `db:migrate`, `db:seed`, local dev with native Postgres, Docker deploy steps, and the monthly restore-test procedure.

- [ ] **Step 6: Verify** — `npm test`, `npm run typecheck`, `npm run build` pass; `docker compose config` validates (run where Docker available). Commit: `git commit -m "feat: add docker deployment and backup"`.

---

## Self-Review

- **Spec coverage:** schema (Tasks 2–3), migrations+pool (Task 1), password/rate-limit (Task 4), sessions/TOTP/guard (Task 5), seed+holidays (Task 6), docker/backup/docs (Task 7) — all spec sections mapped.
- **Placeholder scan:** no TBD/TODO; each task has concrete code/SQL and commands.
- **Type consistency:** `query`/`withTransaction` from `pool.ts` used by migrate/session/guard; `AppError` shape consistent; session cookie/token naming consistent.
- **Scope:** foundation only; attendance capture/offline/admin UI explicitly deferred to Phases 1–3.
