# Product Requirements Document — Attendance Management PWA

- **Status:** Draft v1
- **Product type:** Multi-tenant SaaS PWA
- **Primary language:** Bahasa Indonesia
- **Target:** MVP, fewer than 100 active users per tenant; architecture must scale vertically and later horizontally
- **Environments:** Pre-production and production
- **Audience:** AI coding agent and product owner

## 1. Product Summary

A lightweight, installable attendance-management Progressive Web App for companies whose employees work in offices, warehouses, and low-connectivity field locations. Users check in and out with GPS and a camera-captured selfie. Attendance can be recorded offline for up to three days and synchronized once connectivity returns.

The product is distributed through the web rather than app stores. It remains usable in a normal browser and may be installed to the home screen.

## 2. Goals

1. Make daily check-in and check-out fast on Android Chrome and iPhone Safari.
2. Verify office attendance with configurable geofences, GPS accuracy rules, and selfies.
3. Support field-worker attendance where geofencing is optional.
4. Work reliably during intermittent connectivity without duplicate attendance records.
5. Give managers immediate team status and useful late-hours/worked-hours reports.
6. Strictly isolate each tenant's data.
7. Allow the superadmin to manage tenants, subscriptions, retention, features, and tenant branding.
8. Keep the first deployment operable on one VPS.

## 3. Non-goals for MVP

- Payroll calculation or payroll-provider integrations
- Leave, expense, overtime-approval, or HRIS modules
- Face recognition, biometric matching, or liveness detection
- Guaranteed fake-GPS detection
- App-store distribution
- Automated payment gateway
- PDF/XLSX reports; CSV only
- Background location tracking
- Microservices, Kubernetes, event buses, or separate tenant databases
- Automatic email report delivery
- Dark mode

These can become independent modules after validated demand. The MVP schema must not pre-build unused modules.

## 4. Constraints and Explicit Limitations

- Geolocation and camera require HTTPS and explicit browser permission.
- Installed PWAs do not receive unrestricted background execution.
- Sync is attempted when the app opens, reconnects, or receives a supported browser sync opportunity; iOS may require reopening the app.
- A PWA cannot reliably prove that GPS is genuine. The product records accuracy and anomalies but must not claim spoof-proof attendance.
- Offline records can be lost if the user clears site data or removes the PWA before synchronization.
- Dynamic PWA icon/name changes are browser-dependent and may not update an already installed app. Users may need to remove and reinstall it after branding changes.
- Selfie watermarking is possible. The MVP should render a visible timestamp, worker name, coordinates, and location label onto a canvas-generated image before storage. Original event metadata must also be stored separately; the watermark is evidence, not a security boundary.

## 5. Personas and Roles

### 5.1 System roles

| Role | Scope | Core capability |
|---|---|---|
| Member | Self | Attendance and own history |
| Manager | Assigned teams | Member capability plus team monitoring and corrections |
| Admin | Tenant | Tenant configuration and user administration |
| Superadmin | Platform | All tenants, plans, features, retention, and branding entitlement |

A user may hold multiple roles. Managers and admins can also perform their own attendance.

### 5.2 Renameable worker labels

“Employee” and “Freelance/Karyawan Lapangan” are **employment types**, not authorization roles. Admins may rename their visible labels. Stable internal keys remain `employee` and `field_worker` so renaming never changes permissions or code.

Defaults:

- `employee`: geofence required
- `field_worker`: geofence optional, but GPS is still captured when permission is available

Admins and superadmins can override attendance policy per worker. A worker is assigned to one tenant only.

### 5.3 Permission matrix

| Capability | Member | Manager | Admin | Superadmin |
|---|:---:|:---:|:---:|:---:|
| Check in/out for self | Yes | Yes | Yes | Yes |
| View own history | Yes | Yes | Yes | Yes |
| Request correction | Yes | Yes | Yes | Yes |
| View assigned teams | No | Yes | Yes | Yes |
| Approve/reject team corrections | No | Yes | Yes | Yes |
| Edit attendance manually | No | Assigned teams | Tenant | All |
| Manage team assignment | No | No | Yes | Yes |
| Manage users/sessions | No | No | Yes | Yes |
| Manage locations/schedules/policies | No | No | Yes | Yes |
| Export reports | No | Yes, assigned teams | Yes | Yes |
| Configure tenant branding | No | No | If enabled | Yes |
| Manage tenants/plans/feature access/retention | No | No | No | Yes |

All privileged access must be authorized server-side. UI hiding is not authorization.

## 6. Tenant and Subscription Model

- New tenant creation: superadmin only.
- One user belongs to one tenant in MVP.
- Each tenant has an immutable ID; all tenant-owned records carry `tenant_id`.
- Tenant A must never read or mutate Tenant B data.
- Subscription is monthly, but payment and activation are manual in MVP.
- Subscription statuses: `trial`, `active`, `past_due`, `suspended`, `cancelled`.
- Superadmin can set plan, user limit, feature flags, period dates, and status.
- Suspended tenants retain data but cannot create attendance; admins can see a billing/status message.
- URL pattern: `https://domain.tld/{tenant-slug}`. Login resolves and validates the tenant slug.

## 7. Functional Requirements

### 7.1 Authentication and account lifecycle

- Login identifier is either normalized email or normalized WhatsApp-capable phone number plus password.
- Admin creates user accounts; public signup is absent.
- Email and phone are optional individually, but at least one is required.
- Password reset is performed manually by admin or superadmin in MVP.
- Superadmin must use TOTP two-factor authentication.
- Multiple devices are allowed. Every session stores device label/user-agent, creation time, last-seen time, IP where legally appropriate, and revocation time.
- Admin can revoke tenant-user sessions; superadmin can revoke any session.
- Deactivated users cannot log in, but historical records remain according to the configured retention period.

### 7.2 Tenant branding

If superadmin enables tenant branding, admin can configure:

- App display name
- Company display name
- Logo
- PWA icon
- Primary color
- Splash-screen image/content

Files must have validated MIME type, decoded image format, dimensions, and size. Tenant slug is not editable by tenant admin in MVP.

### 7.3 Locations and worker assignment

- A tenant can have multiple work locations.
- Admin/superadmin creates a location by selecting coordinates, naming it, setting radius, timezone inheritance, and active state.
- Admin/superadmin assigns one or more allowed locations to each worker.
- The tenant setting provides default geofence radius and maximum acceptable GPS accuracy; a location may override the radius.
- Managers can see assignments but cannot alter global policy unless later granted explicitly.
- Distance uses the Haversine formula. A worker is inside if distance to at least one assigned active location is less than or equal to its effective radius.

### 7.4 Schedules

- Schedules are configurable and may differ per user.
- Support fixed schedules, rotating assignments, and shifts spanning midnight.
- Schedule fields: local start/end time, grace minutes, fixed break minutes, workdays, effective date range, and timezone inherited from tenant unless overridden by location.
- Indonesian national holidays and tenant-created holidays are supported.
- National holiday data is imported/administered by superadmin; no external holiday dependency is required for MVP.
- A worker may have one effective schedule assignment at a time. Reject overlapping assignments at the service/database transaction boundary.

### 7.5 Check-in and check-out

Both check-in and check-out require a camera-captured selfie. Gallery upload must not be offered.

Online flow:

1. User opens attendance dashboard.
2. App confirms schedule and current attendance state.
3. App requests camera and location permissions when needed.
4. App captures a fresh position with accuracy and acquisition time.
5. If accuracy is above the configured maximum, retry and explain the issue.
6. After retry exhaustion, allow submission with `needs_review` and an accuracy anomaly.
7. Evaluate geofence according to the effective worker policy.
8. If geofence is mandatory and the worker is outside all permitted locations, block submission.
9. Capture selfie and add visible watermark.
10. Submit metadata and image using a client-generated UUID idempotency key.
11. Display accepted time and sync status.

For workers with optional geofence, outside-geofence records are accepted and flagged. If location permission is denied, acceptance follows the effective policy: mandatory blocks; optional accepts with a missing-location anomaly.

Check-out follows the same proof rules. The server is authoritative for online receipt time while retaining device time.

### 7.6 Attendance state and calculations

- First accepted check-in for a work instance wins.
- First accepted check-out after check-in wins.
- Duplicate retries with the same idempotency key return the original result.
- Unexpected additional events are rejected and retained in security/application logs, not as attendance rows.
- Late when effective check-in time is after scheduled start plus grace period.
- Worked minutes = check-out minus check-in minus fixed break minutes, floored at zero.
- Reports may show actual duration beyond schedule but do not label or calculate payable overtime.
- Missing check-out is auto-closed at configured shift end/default cutoff and marked `needs_review` with source `system_auto_checkout`.
- Cross-midnight shifts belong to their scheduled start work date.

### 7.7 Offline-first behavior

- Cache the application shell and only the authenticated user's minimum current schedule/location policy.
- Store pending attendance event metadata and compressed selfie blobs in IndexedDB.
- Never use localStorage for images, tokens, or attendance queue data.
- Offline submissions expire after three days and cannot be newly synchronized afterward without correction review.
- Save device timestamp, last known server-time offset, location acquisition timestamp, queue timestamp, and eventual server receipt timestamp.
- Detect suspicious clock movement by comparing device time progression with monotonic elapsed time and last server offset. Accept but flag anomaly.
- Queue items have states: `pending`, `syncing`, `synced`, `needs_review`, `failed_retryable`, `failed_permanent`.
- Sync in creation order when the app opens or regains connectivity; use Background Sync only as an enhancement.
- Retry transient failures with bounded exponential backoff. Do not retry validation/auth failures forever.
- Server idempotency ensures the first event wins.
- Delete local selfie and queue payload only after the server confirms durable persistence.
- UI always shows pending count and last synchronization result.
- Logging out warns about pending items and blocks logout unless the user explicitly accepts possible loss. Clearing browser data cannot be prevented.

### 7.8 Corrections

- Worker may request correction with reason; attachment is not required.
- Assigned manager or tenant admin may approve/reject.
- Admin can edit without employee approval, but a reason is mandatory.
- Although formal compliance is not requested, an immutable audit event is mandatory for privileged attendance edits to prevent silent data loss/disputes. Audit rows cannot be edited through the application.

### 7.9 Dashboards

Member mobile dashboard:

- Check-in/check-out primary action
- Today's status and schedule
- Current location, GPS accuracy, and geofence result
- Sync status/pending count
- Seven-day history
- Late count this month
- Worked hours this month

Manager dashboard:

- Present, absent/not-yet-checked-in, and late workers
- Outside-geofence records
- Offline/anomalous records
- Pending corrections
- Team worked-hours summary
- Scope limited to assigned teams

Admin/superadmin desktop dashboard additionally includes user, location, schedule, policy, subscription, branding, and retention administration.

### 7.10 Reports

- Periods: daily, weekly, monthly, custom date range.
- Filters: team, user, employment type, location, status, anomaly.
- Measures: scheduled start/end, actual check-in/out, late minutes/count, worked minutes/hours, source online/offline, geofence result, review status.
- Export UTF-8 CSV using standard server facilities; protect against spreadsheet formula injection by prefixing dangerous cells beginning with `=`, `+`, `-`, or `@`.
- Report generation must enforce tenant/team authorization.

### 7.11 Retention

- Selfies are retained for 45 days, then deleted by a scheduled daily job.
- Attendance metadata remains after selfie deletion.
- Deactivated-user historical retention is configured globally by superadmin. Default: indefinite until a value is explicitly configured.
- Deletion jobs are idempotent, logged, and remove both the database object reference and filesystem object.

## 8. UX Requirements

- Indonesian copy first; no user-facing hard-coded English.
- Mobile member UI uses bottom navigation: Beranda, Riwayat, Profil.
- Admin is desktop-first with a responsive sidebar.
- Light theme only.
- Minimum touch target 44×44 px, semantic labels, visible focus, keyboard-capable administration, sufficient contrast, and useful error text.
- Do not depend on color alone for attendance state.
- Ask camera/location permission in context, not immediately on initial page load.
- Loading, empty, permission-denied, offline, pending-sync, retrying, rejected, and success states must be designed explicitly.
- A destructive action requires confirmation and names its impact.

## 9. Low-fidelity Wireframes

### 9.1 Member home

```text
┌──────────────────────────────┐
│ Logo  Selamat pagi, Rina  ● │
│ Senin, 12 Mei · Shift 08–17 │
├──────────────────────────────┤
│ Status: Belum check-in       │
│ Lokasi: Gudang A · ±18 m     │
│ [       CHECK-IN       ]     │
│ Kamera + lokasi diperlukan   │
├──────────────────────────────┤
│ Sinkronisasi: 2 tertunda     │
│ [Sinkronkan sekarang]        │
├──────────────────────────────┤
│ 7 hari | Terlambat | Jam     │
│   5/5  |     1      | 39j    │
├──────────────────────────────┤
│ Beranda    Riwayat    Profil │
└──────────────────────────────┘
```

### 9.2 Capture flow

```text
┌──────────────────────────────┐
│ Check-in                     │
│ GPS: ditemukan · ±24 m       │
│ Dalam area: Ya               │
│ [ live camera preview ]      │
│ [Ambil ulang] [Gunakan foto] │
│ Bukti: waktu + koordinat     │
└──────────────────────────────┘
```

### 9.3 Manager dashboard

```text
┌──────── Sidebar ───────┬──────────────────────────┐
│ Ringkasan              │ Hari ini                 │
│ Tim                    │ Hadir 18  Terlambat 3    │
│ Koreksi (4)            │ Belum hadir 6  Anomali 2 │
│ Laporan                ├──────────────────────────┤
│                        │ Nama | Masuk | Status     │
│                        │ ...                      │
└────────────────────────┴──────────────────────────┘
```

## 10. Recommended Technical Stack

Use one TypeScript monolith to minimize moving parts:

- **Runtime/framework:** current Node.js LTS + Next.js stable App Router
- **UI:** React, semantic HTML, CSS Modules/native CSS; no large component framework initially
- **Database:** PostgreSQL
- **Database access:** `pg` with SQL migrations; add no ORM until query volume/maintenance justifies it
- **Validation:** framework/native parsing plus a small already-installed schema validator only if present; otherwise explicit boundary validation
- **Authentication:** secure server-side opaque sessions in HttpOnly cookies; password hashing with Node's built-in `crypto.scrypt`
- **Offline:** service worker, Cache API, IndexedDB
- **Images:** browser Canvas for resize/watermark; server verifies decoded format and metadata
- **File storage:** private filesystem volume on the VPS for MVP, organized by opaque object ID rather than user filename
- **Reverse proxy/TLS:** Caddy
- **Deployment:** Docker Compose with `web`, `postgres`, and `caddy`; a scheduled retention/auto-checkout command uses the same web image
- **Tests:** Node built-in test runner
- **Maps:** no map SDK required for check-in; admin may enter coordinates and preview using an OpenStreetMap embed/provider only if its usage policy permits. Distance calculation does not need a map dependency.

`ponytail:` Local VPS file storage is the MVP ceiling. Move behind an S3-compatible storage adapter only when multiple app nodes, independent backups, or disk growth require it.

`ponytail:` One monolith and one PostgreSQL database are the initial ceiling. Split workers/services only after measured queue or request contention.

## 11. PWA and Caching Strategy

- Web app manifest generated per tenant URL with tenant branding and a versioned icon URL.
- `display: standalone`, valid theme/background colors, and installable icon sizes.
- Service worker caches versioned static shell assets.
- Network-first for authenticated dynamic reads with a safe cached fallback where explicitly allowed.
- Network-only for admin mutations, authentication, and reports.
- Attendance mutations use the explicit IndexedDB queue; do not depend solely on service-worker background sync.
- Never cache cross-tenant API responses in a shared key. Cache keys include tenant and user identity/version.
- On logout, delete user-scoped caches and IndexedDB data after pending-queue handling.

## 12. Data Model

All IDs are UUIDs. All timestamps are `timestamptz` in UTC. Human work dates are derived using the effective schedule timezone. Tables include `created_at` and relevant `updated_at` fields.

### Core identity and tenancy

- `tenants(id, slug UNIQUE, legal_name, display_name, timezone, status, default_radius_m, max_accuracy_m, worker_labels_json, historical_retention_days NULL)`
- `users(id, tenant_id, display_name, email_normalized, phone_e164, password_hash, employment_type, active, created_by)`
  - Check: email or phone exists.
  - Unique partial indexes per tenant for non-null email and phone.
- `user_roles(user_id, role)` with unique `(user_id, role)`
- `teams(id, tenant_id, name, active)`
- `team_members(team_id, user_id)` unique pair
- `manager_teams(manager_user_id, team_id)` unique pair
- `sessions(id, tenant_id, user_id, token_hash UNIQUE, user_agent, device_label, ip, created_at, last_seen_at, expires_at, revoked_at)`
- `totp_credentials(user_id UNIQUE, encrypted_secret, confirmed_at, recovery_codes_hash)`

### Subscription and branding

- `subscriptions(id, tenant_id UNIQUE, plan_key, status, user_limit, period_start, period_end, notes)`
- `tenant_features(tenant_id, feature_key, enabled)` unique pair
- `tenant_branding(tenant_id UNIQUE, app_name, company_name, primary_color, logo_object_id, icon_object_id, splash_object_id, version)`

### Location and schedules

- `locations(id, tenant_id, name, latitude, longitude, radius_m NULL, timezone NULL, active)`
- `user_locations(user_id, location_id)` unique pair
- `attendance_policies(id, tenant_id, name, geofence_mode, selfie_required, max_accuracy_m NULL, retry_count)`
- `user_policy_assignments(user_id, policy_id, effective_from, effective_to NULL)`
- `schedules(id, tenant_id, name, timezone, start_local, end_local, crosses_midnight, grace_minutes, break_minutes, active)`
- `schedule_days(schedule_id, weekday)` unique pair
- `user_schedule_assignments(id, user_id, schedule_id, effective_from, effective_to NULL)`
- `holidays(id, tenant_id NULL, holiday_date, name, kind)` where NULL tenant means national

### Attendance

- `work_instances(id, tenant_id, user_id, work_date, schedule_id, scheduled_start_at, scheduled_end_at, status, check_in_event_id NULL, check_out_event_id NULL, worked_minutes NULL, late_minutes, review_status)`
  - Unique `(tenant_id, user_id, work_date, schedule_id)`.
- `attendance_events(id, tenant_id, user_id, work_instance_id, event_type, idempotency_key, device_occurred_at, server_received_at, source, latitude NULL, longitude NULL, accuracy_m NULL, distance_m NULL, location_id NULL, geofence_result, selfie_object_id, clock_offset_ms NULL, status)`
  - Unique `(tenant_id, user_id, idempotency_key)`.
- `attendance_anomalies(id, tenant_id, attendance_event_id, code, details_json, resolved_at NULL, resolved_by NULL)`
- `correction_requests(id, tenant_id, work_instance_id, requester_id, requested_changes_json, reason, status, decided_by NULL, decided_at NULL, decision_note NULL)`
- `audit_events(id, tenant_id NULL, actor_user_id NULL, action, entity_type, entity_id, before_json NULL, after_json NULL, reason NULL, occurred_at, ip NULL)`

### Files and operations

- `stored_objects(id, tenant_id, kind, relative_path UNIQUE, media_type, byte_size, sha256, created_at, delete_after NULL, deleted_at NULL)`
- `job_runs(id, job_name, started_at, finished_at, status, summary_json)`

Database constraints and transaction-level locks must protect idempotency, tenant relationships, and first-event-wins behavior. Every join between tenant-owned entities verifies matching `tenant_id` either through composite constraints or transaction validation.

## 13. API Surface

JSON except image upload. Version under `/api/v1`.

- `POST /auth/login`, `POST /auth/logout`, `GET /auth/sessions`, `DELETE /auth/sessions/{id}`
- `POST /auth/totp/setup`, `POST /auth/totp/confirm`, `POST /auth/totp/verify`
- `GET /me`, `GET /me/dashboard`, `GET /me/attendance`
- `GET /attendance/context` — current schedule, policy, locations, server time
- `POST /attendance/events` — multipart metadata + selfie; requires idempotency key
- `GET /attendance/events/{id}` — sync result
- `POST /corrections`, `GET /corrections`, `POST /corrections/{id}/approve`, `POST /corrections/{id}/reject`
- CRUD `/admin/users`, `/admin/teams`, `/admin/locations`, `/admin/schedules`, `/admin/policies`, `/admin/holidays`
- `GET /reports/attendance.csv`
- CRUD `/superadmin/tenants`, `/superadmin/subscriptions`, `/superadmin/features`, `/superadmin/retention`
- `GET/PUT /admin/branding`

Mutation responses return a stable error code, localized safe message, and field errors where applicable. Never expose stack traces or filesystem paths.

### Attendance event request fields

`idempotency_key`, `event_type`, `device_occurred_at`, `queued_at`, `latitude`, `longitude`, `accuracy_m`, `location_acquired_at`, `last_server_offset_ms`, `selfie`.

The server independently resolves user, tenant, policy, location assignment, schedule, geofence, and final status. It never trusts client-calculated distance, lateness, role, or tenant ID.

## 14. Security and Privacy

- HTTPS only; HSTS after domain configuration is stable.
- HttpOnly, Secure, SameSite cookies; CSRF protection for cookie-authenticated mutations.
- Password hashing with unique salt and bounded `scrypt` parameters; rate-limit login and 2FA attempts.
- Generic login failure messages to reduce identifier enumeration.
- Validate body size, strings, coordinates, timestamp bounds, MIME type, decoded image format, image dimensions, and file signatures.
- Re-encode uploaded selfies server-side where practical; never serve uploaded files as executable content.
- Store selfies outside the public web root. Serve through an authorized endpoint or short-lived signed application URL.
- Content Security Policy, `X-Content-Type-Options`, frame restrictions, and restrictive permissions policy.
- Parameterized SQL only.
- Tenant scope comes from authenticated server session, never request input.
- Authorization checks occur before file access and CSV generation.
- Encrypt backups; restrict production SSH/database access; run containers as non-root where feasible.
- Secret values live in environment/secret files outside source control.
- Consent screen explains GPS/selfie collection, purpose, retention, offline storage, and deletion timing.

## 15. Reliability, Backups, and Operations

- Nightly encrypted PostgreSQL backup and selfie-volume backup to a location outside the VPS. A backup on the same VPS is not a backup.
- Define and test monthly restoration procedure before production launch.
- Health endpoint checks process and database connectivity without leaking details.
- Structured logs include request ID, tenant ID, user ID, route, status, duration, and error code; never log passwords, session tokens, TOTP secrets, or selfie bytes.
- Monitor disk usage, backup success, HTTP 5xx rate, database reachability, sync failure rate, and job failures.
- Production migrations run once before app rollout and must be backward-compatible for the deployment window.
- Pre-production uses separate database, storage volume, secrets, hostname, and service-worker cache namespace. Production data must not be copied to pre-production without anonymization.

## 16. Performance Targets

Under normal regional mobile connectivity and fewer than 100 users per tenant:

- Cached shell becomes interactive in under 2 seconds on a mid-range supported phone.
- Normal API reads have p95 server response under 500 ms excluding network.
- Attendance metadata acceptance under 1 second excluding selfie upload.
- Member initial compressed JS should be kept small; route-split admin code and avoid map/UI libraries on member routes.
- Selfies are resized/compressed before queueing/upload, with a configurable hard upload ceiling; default target approximately 1280 px longest edge and under 1 MB.

## 17. Acceptance Criteria

### Attendance

- An authorized worker can check in/out online with current camera selfie and GPS according to policy.
- Mandatory geofence blocks out-of-area submission; optional geofence accepts and flags it.
- Poor accuracy retries, then accepts as review-required according to configured rules.
- Same idempotency key submitted repeatedly creates one event.
- Two different check-in attempts for one work instance accept only the first.
- Cross-midnight shift is assigned to the correct work date.
- Late and worked-minute calculations match schedule, grace, and fixed break.

### Offline

- User can queue proof while offline and sees its pending state.
- Reopening online synchronizes automatically.
- Selfie remains local until durable server confirmation, then is removed.
- Three-day-expired events are not silently accepted.
- Device-clock anomalies are retained and visible for review.
- Supported behavior remains understandable when iOS does not execute background sync.

### Authorization/isolation

- Member cannot access another worker's record.
- Manager cannot access workers outside assigned teams.
- Tenant users cannot read/write another tenant by changing URL/body IDs.
- Admin cannot use superadmin endpoints.
- Disabled users and revoked sessions cannot authenticate.

### Branding/PWA

- Enabled tenant admin can update validated branding.
- Manifest and visible UI use tenant branding.
- Browser mode remains fully functional without installation.
- App clearly explains that reinstall may be needed for installed icon/name changes.

### Retention/reports

- Forty-five-day selfie deletion removes files without deleting attendance metadata.
- CSV is tenant/team scoped, opens as UTF-8, and neutralizes formula-like cells.
- Every privileged attendance mutation produces an immutable audit event.

## 18. Minimum Test Strategy

Use Node's built-in test runner. Keep tests focused on high-risk logic:

1. Haversine/geofence boundary cases.
2. Cross-midnight schedule resolution.
3. Late/worked-minute calculations.
4. Idempotent first-event-wins transaction.
5. Tenant and manager-scope authorization.
6. Offline queue state transitions and expiration.
7. Retention deletion preserves metadata.
8. CSV formula-injection escaping.

Before release, manually test install/browser mode, camera and geolocation permissions, offline/reconnect, pending logout, and branding on current Android Chrome and iPhone Safari.

## 19. Delivery Phases

### Phase 0 — Foundation

- Repository, environment validation, PostgreSQL migrations
- Tenant/user/session authentication and superadmin TOTP
- Tenant isolation tests
- Pre-production and production Compose deployment
- Backup/restore check

### Phase 1 — Online attendance

- Locations, policies, schedules, holidays
- Camera/GPS capture, selfie storage, check-in/out
- Attendance calculations and member dashboard
- Manager daily dashboard

### Phase 2 — Offline reliability

- PWA manifest/service worker
- IndexedDB queue, idempotent sync, anomaly detection
- Android/iPhone offline QA

### Phase 3 — Administration

- Users, teams, correction flow, manual edits/audit
- CSV reports
- Branding and subscription controls
- Retention jobs and operational alerts

Do not start optional HR modules until all MVP acceptance criteria pass in pre-production.

## 20. Implementation Rules for AI Agents

1. Implement one phase and one vertical feature at a time.
2. Prefer platform and standard-library features; do not add dependencies without showing the missing native capability.
3. Use SQL constraints for uniqueness and relational integrity; do not rely only on UI validation.
4. Keep tenant authorization in a shared server-side request guard, not copied client logic.
5. Treat all browser data as untrusted and recompute business decisions server-side.
6. Every non-trivial business rule ships with one runnable test.
7. Do not create speculative interfaces, repositories, factories, queues, or module systems.
8. Do not generate all screens/schema in one unreviewed pass. Complete and verify each phase against this PRD.
9. If implementation conflicts with this document, stop and request a product decision rather than inventing behavior.

## 21. Open Product Decisions Before Implementation

1. Default geofence radius in meters.
2. Default maximum acceptable GPS accuracy in meters and retry count.
3. Exact automatic check-out cutoff when no check-out exists.
4. Global historical metadata retention default if not indefinite.
5. Maximum selfie upload bytes and final JPEG/WebP quality.
6. Tenant branding file dimensions and size limits.
7. Monthly plan names, user limits, grace period, and suspended-tenant behavior for read-only access.
8. Whether managers may manually edit attendance or only approve corrections; this draft allows assigned-team editing with audit.
9. Source and update process for Indonesian national holidays.
10. Product/domain name and default visual identity.
