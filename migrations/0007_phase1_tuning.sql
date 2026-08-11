-- 0007_phase1_tuning
-- Phase 1 tuning + carried-over hardening (PRD 12).
--
-- 1. Index attendance_events by work_instance for the auto-checkout job and
--    per-instance event lookups.
-- 2. Composite tenant FKs on the assignment tables (user_locations,
--    user_policy_assignments, user_schedule_assignments), matching the
--    tenant-consistency pattern from 0005: every join between tenant-owned
--    entities carries tenant_id through a composite foreign key against the
--    referenced table's UNIQUE(tenant_id, id). Each assignment table gains a
--    tenant_id column (backfilled from the referenced parent row), a plain FK
--    to tenants, composite FKs (tenant_id, <ref>) for each reference, and a
--    tenant-scoped uniqueness constraint.
--
-- Existing single-column REFERENCES users(id) / locations(id) / ... FKs are
-- kept (they remain valid); the composite FKs ADD the tenant-match guarantee.
-- The new NOT NULL tenant_id columns are written by every INSERT that creates
-- assignment rows (app code, seeds, and tests supply tenant_id).

CREATE INDEX IF NOT EXISTS attendance_events_work_instance_idx
  ON attendance_events (work_instance_id);

-- ---------------------------------------------------------------------------
-- user_locations: tenant_id from the referenced location.
-- ---------------------------------------------------------------------------
ALTER TABLE user_locations ADD COLUMN tenant_id uuid;

UPDATE user_locations ul
   SET tenant_id = l.tenant_id
  FROM locations l
 WHERE l.id = ul.location_id;

ALTER TABLE user_locations
  ALTER COLUMN tenant_id SET NOT NULL,
  ADD CONSTRAINT user_locations_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  ADD CONSTRAINT user_locations_tenant_user_fkey
    FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT user_locations_tenant_location_fkey
    FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT user_locations_tenant_user_location_key UNIQUE (tenant_id, user_id, location_id);

-- ---------------------------------------------------------------------------
-- user_policy_assignments: tenant_id from the referenced policy.
-- ---------------------------------------------------------------------------
ALTER TABLE user_policy_assignments ADD COLUMN tenant_id uuid;

UPDATE user_policy_assignments upa
   SET tenant_id = p.tenant_id
  FROM attendance_policies p
 WHERE p.id = upa.policy_id;

ALTER TABLE user_policy_assignments
  ALTER COLUMN tenant_id SET NOT NULL,
  ADD CONSTRAINT user_policy_assignments_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  ADD CONSTRAINT user_policy_assignments_tenant_user_fkey
    FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT user_policy_assignments_tenant_policy_fkey
    FOREIGN KEY (tenant_id, policy_id) REFERENCES attendance_policies (tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT user_policy_assignments_tenant_user_policy_key UNIQUE (tenant_id, user_id, policy_id, effective_from);

-- ---------------------------------------------------------------------------
-- user_schedule_assignments: tenant_id from the referenced schedule.
-- ---------------------------------------------------------------------------
ALTER TABLE user_schedule_assignments ADD COLUMN tenant_id uuid;

UPDATE user_schedule_assignments usa
   SET tenant_id = s.tenant_id
  FROM schedules s
 WHERE s.id = usa.schedule_id;

ALTER TABLE user_schedule_assignments
  ALTER COLUMN tenant_id SET NOT NULL,
  ADD CONSTRAINT user_schedule_assignments_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  ADD CONSTRAINT user_schedule_assignments_tenant_user_fkey
    FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT user_schedule_assignments_tenant_schedule_fkey
    FOREIGN KEY (tenant_id, schedule_id) REFERENCES schedules (tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT user_schedule_assignments_tenant_user_schedule_key UNIQUE (tenant_id, user_id, schedule_id, effective_from);
