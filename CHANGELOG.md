# Changelog

All notable changes to this prototype are documented here.

## Phase 1 — Online Attendance

- Added tenant login and the auth API (`/[tenant]/login`, `/sa/login`, `POST /api/v1/auth/login` and siblings): rate-limited, non-enumerating credential checks issuing a session cookie, scoped to the tenant slug.
- Added online check-in/out: the member dashboard captures a camera selfie and a GPS fix, watermarks and resizes the image client-side, and posts it with an idempotency key. The server recomputes the geofence verdict, lateness, and status from the raw proof — it never trusts the client. Geofence policy resolves per employment type (employee = mandatory, field_worker = optional/advisory), so a mandatory worker outside all assigned locations is blocked while a field worker is accepted and flagged.
- Added attendance calculations: cross-midnight schedule resolution, holiday awareness, effective schedule/location assignment, and late/worked-minutes computation.
- Added member and manager dashboards: the member sees today's status and recent attendance (`/[tenant]/dashboard`, `/[tenant]/history`); the manager sees team-today status (`/[tenant]/manager`).
- Added the shift-end auto-checkout job (`scripts/jobs/auto-checkout.ts`, run by the compose `jobs` service): it closes work instances whose shift ended without a check-out, marks them `needs_review` with a `system_auto_checkout` event, and is idempotent.
- Added private object storage for selfies: opaque-UUID files with recorded byte size and SHA-256, integrity-checked on read, streamed only to authorized same-tenant sessions (`GET /api/v1/objects/[id]`).
- Added the admin config surface for locations, policies, and schedules as read shells; full admin write is Phase 3 scope.
- Added LAN HTTPS phone-testing support (`Caddyfile.lan` + `docker-compose.lan.yml`) so a phone on the same Wi-Fi can reach the app over HTTPS — required for camera/GPS — using Caddy's internal CA. See README "Phone testing over LAN (HTTPS)".

## Unreleased

- Implemented the four-role mock UI prototype with previews for Member (Anggota), Manager (Manajer), Admin (Administrator), and Superadmin, switchable from a role switcher in the demo shell.
- Added demo state simulation for the Member attendance flow: check-in and check-out, plus the offline/pending, accuracy-review, rejected, and completed scenarios. Transitions are guarded (for example, duplicate check-in and check-out before check-in are rejected) and never mutate the source fixtures.
- Kept a replaceable demo data boundary: all tenants, users, teams, locations, schedules, attendance, correction requests, subscriptions, and feature flags live in `src/lib/demo/data.ts` behind narrow selectors in `src/lib/demo/selectors.ts`, so the mock dataset can be swapped without touching the views.
- Documented the local startup path (`npm install`, `npm run dev`, then open `http://localhost:3000`) and the verification commands (`npm test`, `npm run lint`, `npm run build`).
- This is a mock-only prototype: it does not include a real backend, authentication, database persistence, or camera/GPS hardware access. All data is held in memory and is not stored.
