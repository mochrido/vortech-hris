-- 0003_subscription_branding
-- Subscription, feature-flag, and branding tables (PRD Section 12).

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid UNIQUE NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_key text NOT NULL DEFAULT 'trial',
  status text NOT NULL DEFAULT 'trial',
  user_limit int NOT NULL DEFAULT 25,
  period_start date,
  period_end date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_features (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, feature_key)
);

CREATE TABLE tenant_branding (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  app_name text,
  company_name text,
  primary_color text,
  logo_object_id uuid NULL,
  icon_object_id uuid NULL,
  splash_object_id uuid NULL,
  version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
