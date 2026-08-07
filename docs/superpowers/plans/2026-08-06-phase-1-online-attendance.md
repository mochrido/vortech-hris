# Phase 1 — Online Attendance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build real online attendance on the Phase 0 foundation: tenant login, admin config of locations/policies/schedules, member check-in/out with camera selfie + GPS + geofence, attendance calculations, and member + manager dashboards.

**Architecture:** Next.js App Router monolith. Pure, independently-testable attendance domain modules in `src/lib/attendance`, `src/lib/images`, `src/lib/storage`, wired through the Phase 0 guard to `/api/v1` route handlers. The server recomputes geofence/lateness/status; the client sends only raw proof (selfie + GPS + timestamps + idempotency key). Approved prototype components are reused, swapping the mock boundary for real API calls.

**Tech Stack:** Node >= 22.18 (strip-types), Next.js 16.3, React 19, TypeScript, PostgreSQL 17, `pg`. **No new runtime dependencies** — image validation/re-encode uses the browser Canvas on the client and a minimal native decoder check on the server (see Task 5 note). Node built-in test runner.

**Authoritative references:** `docs/PRD.md — Attendance Management PWA.md`, `docs/decisions.md`, `docs/superpowers/specs/2026-08-06-phase-1-online-attendance-design.md`.

**Constraints (hard-won, must persist):**
- Strip-types-safe TS only: NO enums, NO constructor parameter properties, NO namespaces. Use const objects / union types / plain field assignment.
- No new dependencies without explicit approval. Only `pg` is present.
- Tenant scope ALWAYS from the Phase 0 session guard (`src/lib/auth/guard.ts`), never from client input.
- Parameterized SQL only.
- All tests run against a disposable per-run test DB via `src/lib/test/db.ts` + `runMigrations`. Never the dev DB.
- Reuse `AppError`/`ErrorCodes` from `src/lib/auth/errors.ts` for stable error codes + safe messages.

---

## File Map

- `src/lib/attendance/geo.ts`, `schedule.ts`, `calc.ts`, `geofence.ts`, `events.ts` (+ `.test.ts` each)
- `src/lib/images/selfie.ts` (+ test)
- `src/lib/storage/objects.ts` (+ test)
- `src/lib/auth/login.ts` (+ test)
- `src/lib/attendance/context.ts` (attendance context query) 
- `src/lib/jobs/autoCheckout.ts` (+ test); `scripts/jobs/auto-checkout.ts`
- `src/app/api/v1/**` route handlers
- `src/app/[tenant]/login/page.tsx`, member/manager/admin pages, `src/app/sa/…`
- `src/components/capture/CameraCapture.tsx`, `useGeolocation.ts`
- Migration `0007_phase1_tuning.sql` (index on attendance_events.work_instance_id; composite FKs on assignment tables)

---

### Task 1: Geofence math + attendance calculations

**Files:**
- Create: `src/lib/attendance/geo.ts`, `src/lib/attendance/calc.ts`
- Test: `src/lib/attendance/geo.test.ts`, `src/lib/attendance/calc.test.ts`

- [ ] **Step 1: Failing tests** — `geo.test.ts`: `haversineMeters` for a known pair (~111.19 km per degree latitude); `isInsideGeofence` true when distance <= radius (boundary exactly-on-radius is inside), false beyond; multiple locations returns true if inside ANY. `calc.test.ts`: `lateMinutes(checkIn, scheduledStart, grace)` (0 when within grace, exact minutes after); `workedMinutes(checkIn, checkOut, break)` = out−in−break floored at 0 (break larger than elapsed → 0).
- [ ] **Step 2: Run to verify fail** — `npm test -- --test-name-pattern="geo"` and `"calc"`. Expected: FAIL.
- [ ] **Step 3: Implement** — `haversineMeters(lat1,lon1,lat2,lon2)` (R=6371000); `isInsideGeofence(lat, lon, locations: {latitude,longitude,radius_m}[])`; `lateMinutes`, `workedMinutes` (pure, integer minutes).
- [ ] **Step 4: Run to verify pass.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: add geofence math and attendance calculations"`.

---

### Task 2: Schedule resolution (cross-midnight, holidays, effective assignment)

**Files:**
- Create: `src/lib/attendance/schedule.ts`
- Test: `src/lib/attendance/schedule.test.ts`

- [ ] **Step 1: Failing tests** — using the test DB (seed a tenant, user, schedule, schedule_days, user_schedule_assignments, holidays): resolve the effective schedule for a user on a date; cross-midnight shift (start 22:00, end 06:00) assigns events after midnight to the PRIOR work date; a holiday returns a non-working result; overlapping active assignment is rejected/not selected (one effective at a time); no schedule → null.
- [ ] **Step 2: Run to verify fail** — `npm test -- --test-name-pattern="schedule"`. Expected: FAIL.
- [ ] **Step 3: Implement** — `getEffectiveSchedule(client, userId, tenantId, atUtc)` returns `{ scheduleId, workDate, scheduledStartAt, scheduledEndAt, crossesMidnight, graceMinutes, breakMinutes, isHoliday }` or null. Compute work date in the schedule timezone; handle crosses_midnight by attributing post-midnight times to the start date.
- [ ] **Step 4: Run to verify pass.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: add schedule resolution"`.

---

### Task 3: Geofence policy resolution + verdict

**Files:**
- Create: `src/lib/attendance/geofence.ts`
- Test: `src/lib/attendance/geofence.test.ts`

- [ ] **Step 1: Failing tests** — resolve effective policy for an `employee` (mandatory) vs `field_worker` (optional); verdict for inside (accepted), outside+mandatory (blocked), outside+optional (accepted+flagged), no-location+mandatory (blocked), no-location+optional (accepted + missing-location anomaly), accuracy>50 after retries (accuracy_review). Uses `geo.ts`.
- [ ] **Step 2: Run to verify fail** — `npm test -- --test-name-pattern="geofence"`. Expected: FAIL.
- [ ] **Step 3: Implement** — `getEffectivePolicy(client, user, tenant)` (employment_type default; tenant max_accuracy_m=50, retry_count=3; location radius overrides); `evaluateGeofence({ policy, latitude, longitude, accuracyM, locations })` returns a verdict union `{ kind: 'inside'|'outside_blocked'|'outside_accepted'|'no_location_blocked'|'no_location_accepted'|'accuracy_review', locationId?, distanceM? }`.
- [ ] **Step 4: Run to verify pass.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: add geofence policy resolution"`.

---

### Task 4: Attendance event transaction (idempotency, first-event-wins, work instance)

**Files:**
- Create: `src/lib/attendance/events.ts`
- Test: `src/lib/attendance/events.test.ts`

- [ ] **Step 1: Failing tests** — on a test DB with seeded schedule/locations: a check-in creates a work_instance + event, computes late_minutes; the SAME idempotency_key returns the ORIGINAL event (no duplicate row); a SECOND different check-in for the same work instance is rejected (and recorded in logs/audit, not as an event); check-out before check-in rejected; check-out after check-in computes worked_minutes and sets check_out_event_id; a blocked geofence verdict prevents the event entirely (no row); anomalies inserted for outside/accuracy/missing-location.
- [ ] **Step 2: Run to verify fail** — `npm test -- --test-name-pattern="events"`. Expected: FAIL.
- [ ] **Step 3: Implement** — `recordAttendanceEvent(client, { tenantId, userId, eventType, idempotencyKey, deviceOccurredAt, latitude, longitude, accuracyM, locationAcquiredAt, clockOffsetMs, selfieObjectId })` using `withTransaction`: look up by idempotency key (return existing); resolve schedule → upsert work_instance (UNIQUE tenant/user/work_date/schedule); enforce first-event-wins; evaluate geofence via `geofence.ts`; insert event + anomalies + audit; update work_instance (check_in_event_id/check_out_event_id, late/worked, review_status). Return `{ event, workInstance, verdict, created: boolean }`.
- [ ] **Step 4: Run to verify pass.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: add attendance event transaction"`.

---

### Task 5: Selfie validation + private storage

**Files:**
- Create: `src/lib/images/selfie.ts`, `src/lib/storage/objects.ts`
- Test: `src/lib/images/selfie.test.ts`, `src/lib/storage/objects.test.ts`

**Note on server image processing:** The browser produces a validated, watermarked, resized JPEG via Canvas. The server must NOT trust it (PRD §14) but also must not add a native image library without need. For Phase 1, server-side validation = verify the JPEG SOI/EOI magic bytes, declared size ≤ 1MB, and sniffed dimensions within limits by parsing the JPEG SOF marker (pure TS, no dep). Full pixel-level re-encode happens client-side; server stores the validated blob. Document this boundary.

- [ ] **Step 1: Failing tests** — `selfie.test.ts`: reject non-JPEG magic bytes; reject > 1MB; reject bad SOF dimensions (>1280px longest edge); accept a valid small JPEG buffer. `objects.test.ts`: `storeObject(tenantId, kind, buffer, mediaType)` writes a file to a private dir (env `STORAGE_DIR`, default `./data/objects`, git-ignored) named by opaque UUID and inserts a `stored_objects` row (relative_path, byte_size, sha256); `readObject` returns the buffer; path traversal id rejected.
- [ ] **Step 2: Run to verify fail** — `npm test -- --test-name-pattern="selfie"` and `"objects"`. Expected: FAIL.
- [ ] **Step 3: Implement** — `selfie.ts`: `validateSelfie(buffer)` (magic bytes, size, SOF dimension parse). `objects.ts`: `storeObject`, `readObject`, `getObjectPath` (opaque id → safe path within STORAGE_DIR; reject `..`). Add `data/` to `.gitignore`/`.dockerignore` if not present.
- [ ] **Step 4: Run to verify pass.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: add selfie validation and private storage"`.

---

### Task 6: Login flow + attendance context + auth API routes

**Files:**
- Create: `src/lib/auth/login.ts`, `src/lib/attendance/context.ts`
- Create: `src/app/api/v1/auth/login/route.ts`, `auth/logout/route.ts`, `auth/sessions/route.ts`, `me/route.ts`, `me/dashboard/route.ts`, `attendance/context/route.ts`
- Test: `src/lib/auth/login.test.ts`, `src/lib/attendance/context.test.ts`

- [ ] **Step 1: Failing tests** — `login.test.ts`: correct identifier+password creates a session and returns cookie; wrong password returns generic INVALID_CREDENTIALS (no enumeration); rate-limited after N failures; deactivated user cannot log in; identifier may be email OR phone. `context.test.ts`: `getAttendanceContext(client, tenantId, userId)` returns current schedule (from `schedule.ts`), effective policy, assigned active locations, and server time.
- [ ] **Step 2: Run to verify fail** — `npm test -- --test-name-pattern="login"` and `"context"`. Expected: FAIL.
- [ ] **Step 3: Implement** `login.ts` (`login(tenantSlug, identifier, password, meta)` wiring tenant lookup by slug, password verify, rate limit, session create) and `context.ts` (composes schedule + geofence policy + user_locations + server time).
- [ ] **Step 4: Implement API routes** — thin handlers using the guard + login.ts/context.ts; return `toErrorResponse` on error. `POST /auth/login` sets the session cookie; `POST /auth/logout` revokes; `GET /auth/sessions` lists the user's sessions; `GET /me` returns the current user; `GET /me/dashboard` returns today's status + recent attendance; `GET /attendance/context` returns the context.
- [ ] **Step 5: Run to verify pass** + `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat: add login flow and attendance context api"`.

---

### Task 7: Attendance events API + object streaming + manager dashboard API

**Files:**
- Create: `src/app/api/v1/attendance/events/route.ts`, `attendance/events/[id]/route.ts`, `objects/[id]/route.ts`, `manager/team/today/route.ts`
- Test: `src/lib/api/attendance-events.test.ts` (route-level, using test DB + a test session)

- [ ] **Step 1: Failing tests** — `POST /attendance/events` accepts multipart metadata+selfie, requires idempotency key, enforces tenant isolation (another tenant's user can't post), returns the accepted result; duplicate key returns original; `GET /attendance/events/{id}` returns the event for the owner only; `GET /objects/{id}` streams the selfie to an authorized same-tenant session and 404s/403s otherwise; `GET /manager/team/today` returns only the manager's assigned-team members' today status.
- [ ] **Step 2: Run to verify fail** — `npm test -- --test-name-pattern="api"`. Expected: FAIL.
- [ ] **Step 3: Implement routes** — parse multipart (Next `request.formData()`), enforce a 1MB selfie + small metadata body cap, call `selfie.validateSelfie` + `objects.storeObject` + `events.recordAttendanceEvent`; map results to JSON with stable codes. `objects/[id]` checks session + tenant match before streaming. Manager route joins manager_teams → team_members → work_instances for today, scoped to the session tenant.
- [ ] **Step 4: Run to verify pass** + typecheck. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: add attendance events and object api"`.

---

### Task 8: Auto-checkout job + schema tuning migration

**Files:**
- Create: `migrations/0007_phase1_tuning.sql`
- Create: `src/lib/jobs/autoCheckout.ts`, `scripts/jobs/auto-checkout.ts`
- Test: `src/lib/jobs/autoCheckout.test.ts`

- [ ] **Step 1: Failing test** — a work_instance with a check-in but no check-out whose scheduled_end_at is in the past is closed: worked_minutes computed, review_status `needs_review`, and an auto-checkout attendance_event with source `system_auto_checkout` is recorded; an instance with a check-out is untouched; running twice is idempotent.
- [ ] **Step 2: Run to verify fail** — `npm test -- --test-name-pattern="autoCheckout"`. Expected: FAIL.
- [ ] **Step 3: Implement** `autoCheckout.ts` (`closeOpenWorkInstances(client, now)`) + `scripts/jobs/auto-checkout.ts` CLI (loads env, runs against DATABASE_URL, logs a summary). Wire the compose `jobs` service command to `node --experimental-strip-types scripts/jobs/auto-checkout.ts` (update docker-compose.yml).
- [ ] **Step 4: Migration** `0007_phase1_tuning.sql` — `CREATE INDEX IF NOT EXISTS attendance_events_work_instance_idx ON attendance_events (work_instance_id);` and add composite tenant FKs to `user_locations`, `user_policy_assignments`, `user_schedule_assignments` (carried-over Phase 1 hardening).
- [ ] **Step 5: Run to verify pass** + typecheck + `npm run db:migrate` on dev DB. Expected: PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat: add auto-checkout job and schema tuning"`.

---

### Task 9: Client capture (camera + GPS) and member/manager/admin pages wired to real API

**Files:**
- Create: `src/components/capture/CameraCapture.tsx`, `src/components/capture/useGeolocation.ts`
- Create: `src/app/[tenant]/login/page.tsx`, `src/app/[tenant]/dashboard/page.tsx`, `src/app/[tenant]/history/page.tsx`, `src/app/[tenant]/manager/page.tsx`, `src/app/[tenant]/admin/locations/page.tsx`, `src/app/[tenant]/admin/policies/page.tsx`, `src/app/[tenant]/admin/schedules/page.tsx`, `src/app/sa/login/page.tsx`
- Modify: reuse/adapt prototype components; `next.config.ts` if needed.
- Test: `src/components/capture/watermark.test.ts` (pure watermark/canvas helpers that don't need a real camera), plus a route guard smoke test if practical.

- [ ] **Step 1: Failing tests** — watermark helper produces the expected text lines (timestamp, name, coords, location label); geolocation retry logic (mock the Geolocation API) retries up to 3 then reports accuracy_review.
- [ ] **Step 2: Run to verify fail** — `npm test -- --test-name-pattern="capture"`. Expected: FAIL.
- [ ] **Step 3: Implement capture** — `useGeolocation` (accuracy ≤50m, ≤3 retries, permission-denied handling); `CameraCapture` (getUserMedia preview, canvas capture, watermark, resize ~1280px, JPEG blob ≤1MB target). Ask permissions in context (on capture, not page load).
- [ ] **Step 4: Implement pages** — `[tenant]/login` (posts to `/api/v1/auth/login`); member dashboard (uses `/attendance/context` + `CameraCapture` + POST event; shows accepted time/geofence/sync); history (`/me/attendance`); manager (`/manager/team/today`); admin locations/policies/schedules (functional minimal forms using the admin API); superadmin `/sa/login`. Guard each page by role (redirect to login when unauthenticated). Reuse prototype components/styles, replacing mock state with real fetches.
- [ ] **Step 5: Run to verify pass** + `npm run typecheck` + `npm run build`. Expected: PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat: wire capture and role pages to real api"`.

---

### Task 10: LAN HTTPS for phone testing + docs + final verification

**Files:**
- Modify: `Caddyfile` (or add `Caddyfile.lan`), `docker-compose.yml` if needed, `README.md`, `docs/decisions.md` (note Phase 1 done), `CHANGELOG.md`.
- Test: manual (documented) — not automated.

- [ ] **Step 1: LAN HTTPS** — configure Caddy to serve the app over the PC's LAN IP with a local/internal cert so a phone on the same Wi-Fi can reach it over HTTPS (required for camera/GPS). Document the exact steps (PC LAN IP, caddy internal TLS, trusting the local cert on the phone or using `https://<lan-ip>` with the browser warning flow).
- [ ] **Step 2: README** — how to run Phase 1 locally (db:migrate, db:seed, dev), the login accounts, the LAN phone-testing steps, and the auto-checkout job invocation.
- [ ] **Step 3: CHANGELOG** — add the Phase 1 entry (login, admin config, online check-in/out with selfie+GPS+geofence, calculations, dashboards, auto-checkout job).
- [ ] **Step 4: Full verification** — `npm test`, `npm run typecheck`, `npm run build`, `docker compose --env-file .env.example config` all green.
- [ ] **Step 5: Manual QA checklist (document, product owner executes)** — real phone check-in/out over LAN HTTPS: camera permission, GPS accuracy, watermark visible, mandatory-geofence block, optional-geofence flag, idempotent retry, late/worked on dashboards.
- [ ] **Step 6: Commit** — `git commit -m "docs: phase 1 lan https and verification"`.

---

## Self-Review

- **Spec coverage:** login (Task 6), admin config (Task 9 pages + admin API in 7), check-in/out + geofence + selfie (Tasks 1,3,4,5,7,9), calculations (Task 2), member/manager dashboards (6,7,9), auto-checkout (8), LAN HTTPS + docs (10). All spec sections mapped.
- **Placeholder scan:** no TBD/TODO; each task has concrete code/steps/commands.
- **Type consistency:** `getEffectiveSchedule`, `getEffectivePolicy`, `evaluateGeofence`, `recordAttendanceEvent`, `validateSelfie`, `storeObject`, `login`, `getAttendanceContext`, `closeOpenWorkInstances` used consistently across tasks.
- **Scope:** online attendance only; offline/PWA (Phase 2) and corrections/reports/retention/full-admin (Phase 3) explicitly excluded.
- **Carry-overs closed:** attendance_events.work_instance_id index + assignment-table composite FKs (Task 8); LAN HTTPS for camera/GPS (Task 10).
