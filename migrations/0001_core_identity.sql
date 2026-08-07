-- 0001_core_identity
-- Core identity and tenancy tables (PRD Section 12).

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  legal_name text NOT NULL,
  display_name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Jakarta',
  status text NOT NULL DEFAULT 'active',
  default_radius_m int NULL,
  max_accuracy_m int NOT NULL DEFAULT 50,
  worker_labels_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  historical_retention_days int NOT NULL DEFAULT 365,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  email_normalized text NULL,
  phone_e164 text NULL,
  password_hash text NOT NULL,
  employment_type text NOT NULL DEFAULT 'employee',
  active boolean NOT NULL DEFAULT true,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_or_phone CHECK (email_normalized IS NOT NULL OR phone_e164 IS NOT NULL)
);

-- Per-tenant uniqueness of non-null identifiers (multiple NULLs coexist).
CREATE UNIQUE INDEX users_tenant_email_key ON users (tenant_id, email_normalized) WHERE email_normalized IS NOT NULL;
CREATE UNIQUE INDEX users_tenant_phone_key ON users (tenant_id, phone_e164) WHERE phone_e164 IS NOT NULL;

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  UNIQUE (user_id, role)
);

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE team_members (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (team_id, user_id)
);

CREATE TABLE manager_teams (
  manager_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  UNIQUE (manager_user_id, team_id)
);
