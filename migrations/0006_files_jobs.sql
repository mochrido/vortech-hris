-- 0006_files_jobs
-- Stored media objects and background job bookkeeping (PRD Section 12).

CREATE TABLE stored_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- e.g. 'selfie', 'branding_logo', 'branding_icon', 'branding_splash'.
  kind text NOT NULL,
  -- Path relative to the storage root; unique across the platform.
  relative_path text UNIQUE NOT NULL,
  media_type text NOT NULL,
  byte_size bigint NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Retention marker (e.g. selfies deleted after 45 days, decisions.md #4).
  delete_after timestamptz NULL,
  deleted_at timestamptz NULL
);

-- Deferred foreign keys that point at stored_objects now that it exists.

-- attendance_events.selfie_object_id (column added in 0005).
ALTER TABLE attendance_events
  ADD CONSTRAINT attendance_events_selfie_object_fkey
    FOREIGN KEY (selfie_object_id) REFERENCES stored_objects(id) ON DELETE SET NULL;

-- Carry-over (Task 2 review, item A): tenant_branding media columns reference
-- stored_objects. Columns are nullable; NULL means "no custom media set".
ALTER TABLE tenant_branding
  ADD CONSTRAINT tenant_branding_logo_object_fkey
    FOREIGN KEY (logo_object_id) REFERENCES stored_objects(id) ON DELETE SET NULL,
  ADD CONSTRAINT tenant_branding_icon_object_fkey
    FOREIGN KEY (icon_object_id) REFERENCES stored_objects(id) ON DELETE SET NULL,
  ADD CONSTRAINT tenant_branding_splash_object_fkey
    FOREIGN KEY (splash_object_id) REFERENCES stored_objects(id) ON DELETE SET NULL;

CREATE TABLE job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- e.g. 'auto_checkout', 'retention_sweep', 'backup'.
  job_name text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL,
  -- e.g. 'running', 'succeeded', 'failed'.
  status text NOT NULL DEFAULT 'running',
  summary_json jsonb NULL
);
