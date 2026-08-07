# Phase 1 — Online Attendance Design

- **Status:** Approved by the product owner on 2026-08-06.
- **Source of truth for behavior:** `docs/PRD.md — Attendance Management PWA.md` (the "bible").
- **Source of truth for resolved values:** `docs/decisions.md`.
- **Prior phases:** UI prototype (approved, merged); Phase 0 foundation (approved, merged, tagged `v0.2.0-phase-0-foundation`).

## Goal

Build the real online attendance capability of the Vortech HRIS PWA: authenticated tenant login, admin configuration of locations/policies/schedules, and member check-in/check-out with a camera selfie + GPS + geofence enforcement, attendance calculations, and member + manager daily dashboards — all backed by the Phase 0 PostgreSQL foundation.

This phase replaces the mock data boundary with real, tenant-isolated database-backed behavior for the attendance domain. It does **not** implement offline sync/PWA (Phase 2) or the corrections workflow, CSV reports, retention jobs, or full admin/subscription/branding UI (Phase 3).

## Product decisions locked for this phase

- **HTTPS for testing:** LAN HTTPS via the Caddy container (local cert on the PC's LAN IP) so real camera/GPS can be tested on a phone over Wi-Fi.
- **Capture UX:** in-app camera (`getUserMedia`) live preview → canvas capture → visible watermark (timestamp, worker name, coordinates, location label) → resize to ~1280px longest edge → JPEG. GPS via the Geolocation API with accuracy retry. No gallery upload.
- **Scope:** full online attendance per PRD §19 Phase 1.
- **Existing UI:** reuse the approved Member/Manager prototype components; swap the mock data boundary for real API calls + session auth.
- **Login/tenancy:** `/{tenant-slug}/login` → HttpOnly session cookie → role pages under `/{tenant-slug}/…`; superadmin on a separate `/sa/…` route.
- **Selfie storage:** private filesystem volume + `stored_objects` rows by opaque ID; served via an authorized endpoint that checks session/tenant. Watermarked JPEG, server re-encode, ≤1MB.
- **Anomalies in Phase 1:** flag + surface on the manager dashboard as needs-review; the correction/approve workflow is Phase 3. No attendance editing in Phase 1.
- **Auto check-out job:** the compose `jobs` service runs a scheduled command that closes open work instances at scheduled shift end, marked `needs_review` with source `system_auto_checkout`.
- **Accuracy rule:** max 50 m, 3 retries; after exhaustion allow submission flagged `needs_review` + accuracy anomaly.
- **Geofence modes:** per employment type — `employee` mandatory (outside all assigned locations = blocked), `field_worker` optional (outside = accepted + flagged). Location-permission denied: mandatory blocks, optional accepts with a missing-location anomaly.
- **Calculations:** PRD §7.6 exactly — late when check-in > scheduled start + grace; worked = check-out − check-in − break, floored at 0; cross-midnight belongs to the scheduled start work date; first event wins; same idempotency key returns the original; extra events rejected + logged.
- **Admin setup UI:** functional, minimal admin forms/tables for locations, policies, and schedules (reuse prototype styling).

## Architecture

Next.js App Router monolith on the Phase 0 foundation. Route groups by role under the tenant slug. JSON API versioned under `/api/v1` (PRD §13). The server independently resolves user, tenant, policy, location assignment, schedule, geofence, and final status; it never trusts client-calculated distance, lateness, role, or tenant ID (PRD §13).

### Modules (one clear responsibility each)

- `src/lib/attendance/geo.ts` — Haversine distance in meters; `isInsideGeofence(lat, long, locations)`.
- `src/lib/attendance/schedule.ts` — resolve the effective schedule assignment and work date for a user at a timestamp, including cross-midnight and holidays.
- `src/lib/attendance/calc.ts` — `lateMinutes(checkIn, scheduledStart, graceMinutes)`; `workedMinutes(checkIn, checkOut, breakMinutes)` (floored at 0).
- `src/lib/attendance/geofence.ts` — resolve the effective policy for a worker (employment type + tenant/location overrides) and produce a geofence verdict (`inside`, `outside_accepted`, `outside_blocked`, `no_location_accepted`, `no_location_blocked`, `accuracy_review`).
- `src/lib/attendance/events.ts` — the check-in/check-out transaction: idempotency (same key → original result), first-event-wins, work-instance upsert, late computation, anomaly insertion, audit event. Transactional.
- `src/lib/images/selfie.ts` — validate decoded format/dimensions/size/signature; re-encode to JPEG q80; enforce ≤1280px longest edge and ≤1MB.
- `src/lib/storage/objects.ts` — write/read private files by opaque object ID; record `stored_objects` rows; no public web-root exposure.
- `src/lib/auth/login.ts` — login flow wiring password verify + rate limit + session creation + tenant resolution.
- `src/app/api/v1/…` — route handlers that call the above via the Phase 0 guard.
- `src/app/[tenant]/…` — login, member dashboard/history/profile, manager dashboard, admin setup pages.
- `src/app/sa/…` — minimal superadmin entry (login + tenant list stub sufficient for Phase 1).

### Client capture

- `src/components/capture/CameraCapture.tsx` — `getUserMedia` live preview, capture to canvas, draw the watermark, resize, produce a JPEG blob.
- `src/components/capture/useGeolocation.ts` — acquire position with accuracy ≤ 50 m and ≤ 3 retries; report accuracy and acquisition time; handle permission-denied.
- Reuse the approved member capture/dialog UI, replacing simulated state with real calls.

## API surface (Phase 1 subset of PRD §13)

- `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/sessions`, `DELETE /api/v1/auth/sessions/{id}`
- `GET /api/v1/me`, `GET /api/v1/me/dashboard`, `GET /api/v1/me/attendance`
- `GET /api/v1/attendance/context` — current schedule, effective policy, assigned locations, server time
- `POST /api/v1/attendance/events` — multipart metadata + selfie; requires idempotency key
- `GET /api/v1/attendance/events/{id}` — sync/acceptance result
- `GET /api/v1/manager/team/today` — manager daily team status
- Admin CRUD: `/api/v1/admin/locations`, `/api/v1/admin/policies`, `/api/v1/admin/schedules` (list/create/update), and worker location/policy/schedule assignment
- `GET /api/v1/objects/{id}` — authorized selfie streaming

### Attendance event request fields (PRD §13)

`idempotency_key`, `event_type`, `device_occurred_at`, `queued_at`, `latitude`, `longitude`, `accuracy_m`, `location_acquired_at`, `last_server_offset_ms`, `selfie`.

## Data flow (check-in)

1. Member opens `/[tenant]/dashboard`; client calls `GET /attendance/context`.
2. Browser requests camera + location in context (not on page load, PRD §8).
3. GPS acquired with accuracy retry per the accuracy rule.
4. Capture selfie → canvas watermark → resize → JPEG blob.
5. `POST /attendance/events` with metadata + selfie + client UUID idempotency key.
6. Server: guard resolves tenant+user from the session; validate + re-encode + store the selfie privately; resolve the effective schedule → work instance (transactional upsert); resolve policy → Haversine geofence verdict; apply first-event-wins + idempotency; compute late minutes; insert the event + any anomalies; write an audit event; return the accepted time and sync status.
7. Client shows accepted time + geofence result + sync status.

## Error handling and security

- Stable error codes + localized safe messages via the Phase 0 `AppError`/`ErrorCodes`; never stack traces or filesystem paths (PRD §13).
- Multipart body-size cap (1 MB selfie + small metadata). Validate MIME, decoded image format, dimensions, and file signature; re-encode server-side; never serve uploaded files as executable content (PRD §14).
- Store selfies outside the public web root; serve through the authorized endpoint after session/tenant authorization (PRD §14).
- Tenant scope from the authenticated session only; parameterized SQL only.
- Geofence enforcement per employment type; permission-denied follows the effective policy.
- Login rate-limited with generic failure messages (Phase 0 rate-limit + password).
- HTTPS only in production; for local phone testing use the LAN HTTPS Caddy setup.

## Testing (Node built-in runner — PRD §18 high-risk logic)

1. Haversine/geofence boundary cases (exactly-on-radius counts as inside).
2. Cross-midnight schedule resolution and work-date assignment.
3. Late and worked-minute calculations against schedule/grace/break.
4. Idempotent first-event-wins transaction: same idempotency key returns the original; a second different check-in is rejected and logged; a check-out before check-in is rejected.
5. Tenant and manager-scope authorization on every Phase 1 endpoint (Tenant A cannot read/mutate Tenant B; manager cannot see outside assigned teams).
6. Selfie validation: wrong MIME, oversize, wrong dimensions, and bad signature are rejected; a valid image is re-encoded within limits.
7. Auto-checkout job: an open work instance past scheduled end is closed with `needs_review` + `system_auto_checkout`; worked minutes computed.
8. Accuracy-retry → `needs_review` path and geofence verdicts for mandatory vs optional workers and permission-denied.

Tests run against a disposable per-run test database, never the dev database.

## Acceptance criteria (PRD §17 — Attendance subset)

- An authorized worker can check in/out online with a current camera selfie and GPS according to policy.
- Mandatory geofence blocks out-of-area submission; optional geofence accepts and flags it.
- Poor accuracy retries, then accepts as review-required per the configured rules.
- The same idempotency key submitted repeatedly creates one event.
- Two different check-in attempts for one work instance accept only the first.
- A cross-midnight shift is assigned to the correct work date.
- Late and worked-minute calculations match schedule, grace, and fixed break.

## Out of scope for Phase 1

- Offline-first behavior: service worker, IndexedDB queue, PWA manifest/install, background sync (Phase 2).
- Corrections workflow (request/approve/reject), CSV reports, retention deletion jobs, and the full admin/subscription/branding/superadmin UI (Phase 3).
- Face recognition, fake-GPS detection guarantees, map SDK (PRD §3 non-goals).
