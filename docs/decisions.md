# Product Decisions — Resolved

Status: Approved by the product owner on 2026-08-06.
These resolve the 10 open decisions in `docs/PRD.md — Attendance Management PWA.md` Section 21.
The PRD is the source of truth for behavior; this file is the source of truth for the values below.
If a decision changes, update this file and note the change in `CHANGELOG.md`.

## Attendance rules

1. **Geofence radius** — Set **per location only**. There is no global default radius. Every
   location must define its own `radius_m`. (Tenant settings may still provide a default that a
   location can inherit, but a location without a radius is invalid until one is set.)
2. **Max GPS accuracy / retries** — **50 m**, with **3 capture retries**. After retry exhaustion,
   submission is allowed and flagged `needs_review` with an accuracy anomaly.
3. **Auto check-out cutoff** — At the **scheduled shift end**. Missing check-out is auto-closed at
   scheduled end, marked `needs_review` with source `system_auto_checkout`.
4. **Historical metadata retention** — **1 year (365 days)** after a user is deactivated.
   Attendance metadata is kept for this period; selfies still follow the 45-day rule.

## Uploads and branding

5. **Selfie upload** — Hard ceiling **1 MB**. The browser resizes to ~**1280px** longest edge
   and re-encodes to **JPEG quality 80** client-side (Canvas). The server does NOT decode or
   re-encode pixels (no native image library); it independently validates the untrusted bytes —
   JPEG magic bytes (SOI/EOI), size (<= **1 MB**), and declared dimensions (<= **1280px**
   longest edge) — and stores the validated blob as-is.
6. **Branding files** — Logo **512px / 300 KB**, PWA icon **512px / 300 KB**, splash
   **1600px / 1 MB**. Validate MIME, decoded format, dimensions, and size.

## Subscription and access

7. **Plans** — `trial` (25 users), `basic` (50 users), `pro` (100 users). Monthly, manual
   activation/payment in MVP. Superadmin sets plan, user limit, feature flags, period dates, status.
8. **Manager editing** — Managers **approve/reject correction requests only**. Managers do **not**
   edit attendance directly. Only **admins** (and superadmin) edit attendance directly, always with
   a mandatory reason and an immutable audit event.

## Content and identity

9. **National holidays** — **Seed 2026–2027** Indonesian national holidays, plus superadmin
   manual CRUD. No external holiday dependency.
10. **Product name** — **Vortech HRIS**. Used in UI, PWA manifest, and login screens.
    Repo/domain remain `vortech-hris`.

## Platform and tenancy

11. **Platform tenant for superadmin** — The superadmin user lives in a dedicated,
    non-customer **platform tenant** (`vortech-platform`). Because `users.tenant_id` is
    `NOT NULL` and the superadmin scope is Platform (PRD 5.1/6), the superadmin cannot be
    modeled as a row in a customer tenant. The platform tenant exists solely to satisfy the
    foreign-key requirement and holds no customer data. Superadmin privilege derives from the
    `superadmin` row in `user_roles`, never from the tenant. Superadmin CRUD endpoints are
    role-checked, non-tenant-scoped paths. **Caveat:** tenant-level reporting and metrics
    must explicitly exclude the platform tenant to avoid skewing counts.

## Attendance enforcement

12. **Accuracy vs. geofence precedence (PRD 7.5)** — Poor GPS accuracy (> 50 m after retries)
    and geofence inside/outside are **independent facts**, not an either/or verdict. The
    mandatory-geofence **block always applies** when a worker is outside all assigned
    locations, even if accuracy was poor; the accuracy anomaly is still recorded. Concretely:
    - `mandatory` + outside (any accuracy) → **blocked**; accuracy anomaly recorded when poor.
    - `mandatory` + inside + poor accuracy → accepted, flagged `needs_review` (accuracy).
    - `optional` (field_worker) → always accepted; the verdict records **both** the accuracy
      flag and the inside/outside fact for review context.
    The verdict type must carry the accuracy anomaly separately from the inside/outside result.
