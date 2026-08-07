-- 0001_core_identity (stub)
-- Minimal core identity table to prove the migration runner.
-- The full Phase 0 schema lands in later tasks.

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  legal_name text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
