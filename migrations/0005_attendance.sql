-- 0005_attendance
-- Work instances, attendance events, anomalies, corrections, and audit
-- (PRD Section 12).
--
-- Cross-entity joins within a tenant are enforced with composite foreign
-- keys carrying tenant_id against the UNIQUE(tenant_id, id) constraints
-- created in 0001/0004 (PRD 12: tenant relationships protected by composite
-- constraints).

CREATE TABLE work_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  -- Human work date derived in the effective schedule timezone.
  work_date date NOT NULL,
  schedule_id uuid NOT NULL,
  scheduled_start_at timestamptz NOT NULL,
  scheduled_end_at timestamptz NOT NULL,
  -- e.g. 'scheduled', 'in_progress', 'completed', 'absent', 'auto_closed'.
  status text NOT NULL DEFAULT 'scheduled',
  -- Linked after the matching events exist (attendance_events.work_instance_id
  -- already points here); NULL until the first event of that type is accepted.
  check_in_event_id uuid NULL,
  check_out_event_id uuid NULL,
  worked_minutes int NULL,
  late_minutes int NOT NULL DEFAULT 0,
  -- e.g. 'clean', 'needs_review'.
  review_status text NOT NULL DEFAULT 'clean',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_instances_tenant_user_date_schedule_key UNIQUE (tenant_id, user_id, work_date, schedule_id),
  CONSTRAINT work_instances_tenant_id_id_key UNIQUE (tenant_id, id),
  -- Tenant-consistency: user and schedule must belong to tenant_id.
  CONSTRAINT work_instances_tenant_user_fkey FOREIGN KEY (tenant_id, user_id)
    REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT work_instances_tenant_schedule_fkey FOREIGN KEY (tenant_id, schedule_id)
    REFERENCES schedules (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE attendance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  work_instance_id uuid NOT NULL,
  -- e.g. 'check_in', 'check_out'.
  event_type text NOT NULL,
  -- Client-supplied idempotency key; first event wins (unique below).
  idempotency_key text NOT NULL,
  device_occurred_at timestamptz NOT NULL,
  server_received_at timestamptz NOT NULL DEFAULT now(),
  -- e.g. 'web_online', 'offline_sync', 'system_auto_checkout'.
  source text NOT NULL,
  latitude numeric(9,6) NULL,
  longitude numeric(9,6) NULL,
  accuracy_m int NULL,
  distance_m int NULL,
  -- Matched permitted location, when any.
  location_id uuid NULL,
  -- e.g. 'inside', 'outside', 'unverified', 'not_required'.
  geofence_result text NOT NULL,
  -- Selfie stored object; FK added in 0006 once stored_objects exists.
  selfie_object_id uuid NULL,
  clock_offset_ms int NULL,
  -- e.g. 'accepted', 'rejected', 'needs_review'.
  status text NOT NULL DEFAULT 'accepted',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_events_tenant_user_idempotency_key UNIQUE (tenant_id, user_id, idempotency_key),
  CONSTRAINT attendance_events_tenant_id_id_key UNIQUE (tenant_id, id),
  -- Tenant-consistency: user, work instance, and location (when set) must
  -- belong to tenant_id.
  CONSTRAINT attendance_events_tenant_user_fkey FOREIGN KEY (tenant_id, user_id)
    REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT attendance_events_tenant_work_instance_fkey FOREIGN KEY (tenant_id, work_instance_id)
    REFERENCES work_instances (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT attendance_events_tenant_location_fkey FOREIGN KEY (tenant_id, location_id)
    REFERENCES locations (tenant_id, id) ON DELETE SET NULL
);

-- work_instances check-in/out links now that attendance_events exists.
ALTER TABLE work_instances
  ADD CONSTRAINT work_instances_check_in_event_fkey
    FOREIGN KEY (check_in_event_id) REFERENCES attendance_events(id) ON DELETE SET NULL,
  ADD CONSTRAINT work_instances_check_out_event_fkey
    FOREIGN KEY (check_out_event_id) REFERENCES attendance_events(id) ON DELETE SET NULL;

CREATE TABLE attendance_anomalies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  attendance_event_id uuid NOT NULL,
  -- e.g. 'accuracy_exceeded', 'outside_geofence', 'clock_skew', 'auto_checkout'.
  code text NOT NULL,
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_at timestamptz NULL,
  resolved_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_anomalies_tenant_event_fkey FOREIGN KEY (tenant_id, attendance_event_id)
    REFERENCES attendance_events (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE correction_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  work_instance_id uuid NOT NULL,
  requester_id uuid NOT NULL,
  requested_changes_json jsonb NOT NULL,
  reason text NOT NULL,
  -- 'pending', 'approved', 'rejected' (managers approve/reject only,
  -- decisions.md #8).
  status text NOT NULL DEFAULT 'pending',
  decided_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz NULL,
  decision_note text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT correction_requests_tenant_work_instance_fkey FOREIGN KEY (tenant_id, work_instance_id)
    REFERENCES work_instances (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT correction_requests_tenant_requester_fkey FOREIGN KEY (tenant_id, requester_id)
    REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

-- tenant_id NULL is used for platform-level (superadmin) actions; every
-- tenant-scoped audit row carries its tenant_id.
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NULL REFERENCES tenants(id) ON DELETE SET NULL,
  actor_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  before_json jsonb NULL,
  after_json jsonb NULL,
  reason text NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  ip inet NULL
);

-- Carry-over (Task 2 review, item B): sessions.tenant_id must match the
-- referenced users.tenant_id. Requires users UNIQUE(tenant_id, id) from 0004.
ALTER TABLE sessions
  ADD CONSTRAINT sessions_tenant_user_fkey FOREIGN KEY (tenant_id, user_id)
    REFERENCES users (tenant_id, id) ON DELETE CASCADE;
