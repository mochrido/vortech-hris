-- 0004_locations_schedules
-- Location, policy, schedule, and holiday tables (PRD Section 12).
--
-- Tenant-consistency pattern: every tenant-owned entity exposes
-- UNIQUE(tenant_id, id) so that joins between tenant-owned entities can be
-- enforced at the database level with composite foreign keys carrying
-- tenant_id (PRD 12: "Every join between tenant-owned entities verifies
-- matching tenant_id either through composite constraints or transaction
-- validation").

-- Carry-over prerequisite (Task 2 review, item B): composite uniqueness on
-- users so sessions (and later attendance tables) can enforce that the
-- referenced user belongs to the stated tenant.
ALTER TABLE users ADD CONSTRAINT users_tenant_id_id_key UNIQUE (tenant_id, id);

CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  latitude numeric(9,6) NOT NULL,
  longitude numeric(9,6) NOT NULL,
  -- Per-location geofence radius. NULL means "no radius set": the tenant
  -- default may be inherited by the app, but a location without a radius is
  -- invalid until one is set (docs/decisions.md #1).
  radius_m int NULL,
  -- Optional per-location timezone override; NULL inherits the schedule /
  -- tenant timezone.
  timezone text NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT locations_tenant_id_id_key UNIQUE (tenant_id, id)
);

CREATE TABLE user_locations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  UNIQUE (user_id, location_id)
);

CREATE TABLE attendance_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- e.g. 'mandatory' (block outside geofence) or 'advisory' (flag only).
  geofence_mode text NOT NULL,
  selfie_required boolean NOT NULL DEFAULT true,
  -- NULL inherits the tenant max_accuracy_m (50 m default, decisions.md #2).
  max_accuracy_m int NULL,
  retry_count int NOT NULL DEFAULT 3,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_policies_tenant_id_id_key UNIQUE (tenant_id, id)
);

CREATE TABLE user_policy_assignments (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  policy_id uuid NOT NULL REFERENCES attendance_policies(id) ON DELETE CASCADE,
  effective_from date NOT NULL,
  effective_to date NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Overlapping effective ranges for the same user are prevented by the
  -- service layer at the transaction boundary (Phase 1); Phase 0 stores the
  -- columns without a temporal exclusion constraint.
  CONSTRAINT user_policy_assignments_range_check CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- IANA timezone used to derive human work dates and local shift bounds.
  timezone text NOT NULL,
  start_local time NOT NULL,
  end_local time NOT NULL,
  crosses_midnight boolean NOT NULL DEFAULT false,
  grace_minutes int NOT NULL DEFAULT 0,
  break_minutes int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedules_tenant_id_id_key UNIQUE (tenant_id, id)
);

CREATE TABLE schedule_days (
  schedule_id uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  -- 0 = Sunday .. 6 = Saturday (matches EXTRACT(ISODOW) adjusted usage in app).
  weekday int NOT NULL,
  UNIQUE (schedule_id, weekday),
  CONSTRAINT schedule_days_weekday_check CHECK (weekday BETWEEN 0 AND 6)
);

CREATE TABLE user_schedule_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  schedule_id uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  effective_from date NOT NULL,
  effective_to date NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Same as user_policy_assignments: non-overlap is enforced by the service
  -- layer in Phase 1.
  CONSTRAINT user_schedule_assignments_range_check CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- National holidays carry tenant_id NULL (PRD 12). Seed data adds
-- 2026-2027 Indonesian national holidays (decisions.md #9).
CREATE TABLE holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NULL REFERENCES tenants(id) ON DELETE CASCADE,
  holiday_date date NOT NULL,
  name text NOT NULL,
  -- e.g. 'national' (tenant_id NULL) or 'company' (tenant-specific).
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
