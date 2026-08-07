import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createTestDatabase, dropTestDatabase } from '../test/db.ts';
import { runMigrations } from './migrate.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = path.join(repoRoot, 'migrations');

const EXPECTED_TABLES = [
  'tenants',
  'users',
  'user_roles',
  'teams',
  'team_members',
  'manager_teams',
  'sessions',
  'totp_credentials',
  'subscriptions',
  'tenant_features',
  'tenant_branding',
];

/** Asserts `fn` rejects with a Postgres error carrying the given SQLSTATE code. */
async function assertPgError(fn: () => Promise<unknown>, code: string, context: string): Promise<void> {
  await assert.rejects(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof Error, `${context}: expected an Error`);
      assert.equal((error as { code?: string }).code, code, `${context}: expected SQLSTATE ${code}`);
      return true;
    },
    `${context}: expected rejection with SQLSTATE ${code}`,
  );
}

test('schema: migrations create all core identity, tenancy, auth, and subscription tables', async (t) => {
  const url = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  t.after(async () => {
    await pool.end();
    await dropTestDatabase(url);
  });

  const applied = await runMigrations(pool, migrationsDir);
  assert.ok(applied.includes('0001_core_identity'), 'expected 0001_core_identity to be applied');
  assert.ok(applied.includes('0002_auth'), 'expected 0002_auth to be applied');
  assert.ok(applied.includes('0003_subscription_branding'), 'expected 0003_subscription_branding to be applied');

  const result = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  const names = result.rows.map((row) => row.table_name);
  for (const table of EXPECTED_TABLES) {
    assert.ok(names.includes(table), `expected table ${table} to exist, got ${JSON.stringify(names)}`);
  }
});

test('schema: users requires email or phone, and enforces per-tenant uniqueness of non-null identifiers', async (t) => {
  const url = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  t.after(async () => {
    await pool.end();
    await dropTestDatabase(url);
  });
  await runMigrations(pool, migrationsDir);

  const tenantA = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('tenant-a', 'Tenant A', 'Tenant A') RETURNING id`,
  );
  const tenantB = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('tenant-b', 'Tenant B', 'Tenant B') RETURNING id`,
  );
  const tenantAId = tenantA.rows[0].id;
  const tenantBId = tenantB.rows[0].id;

  // A user with neither email nor phone violates the CHECK constraint.
  await assertPgError(
    () =>
      pool.query(
        `INSERT INTO users (tenant_id, display_name, password_hash) VALUES ($1, 'No Contact', 'hash')`,
        [tenantAId],
      ),
    '23514',
    'users email-or-phone CHECK',
  );

  // Baseline users in tenant A (one email-identified, one phone-identified).
  await pool.query(
    `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash) VALUES ($1, 'User One', 'one@example.com', 'hash')`,
    [tenantAId],
  );
  await pool.query(
    `INSERT INTO users (tenant_id, display_name, phone_e164, password_hash) VALUES ($1, 'User Two', '+6281111111111', 'hash')`,
    [tenantAId],
  );

  // Duplicate non-null email within the same tenant fails.
  await assertPgError(
    () =>
      pool.query(
        `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash) VALUES ($1, 'User One Dup', 'one@example.com', 'hash')`,
        [tenantAId],
      ),
    '23505',
    'duplicate email in same tenant',
  );

  // Duplicate non-null phone within the same tenant fails.
  await assertPgError(
    () =>
      pool.query(
        `INSERT INTO users (tenant_id, display_name, phone_e164, password_hash) VALUES ($1, 'User Two Dup', '+6281111111111', 'hash')`,
        [tenantAId],
      ),
    '23505',
    'duplicate phone in same tenant',
  );

  // The same email and phone in a DIFFERENT tenant succeed.
  await pool.query(
    `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash) VALUES ($1, 'Other Tenant User', 'one@example.com', 'hash')`,
    [tenantBId],
  );
  await pool.query(
    `INSERT INTO users (tenant_id, display_name, phone_e164, password_hash) VALUES ($1, 'Other Tenant Phone', '+6281111111111', 'hash')`,
    [tenantBId],
  );

  // Multiple users with NULL email / NULL phone coexist within one tenant.
  await pool.query(
    `INSERT INTO users (tenant_id, display_name, phone_e164, password_hash) VALUES ($1, 'Null Email One', '+6282222222222', 'hash')`,
    [tenantAId],
  );
  await pool.query(
    `INSERT INTO users (tenant_id, display_name, phone_e164, password_hash) VALUES ($1, 'Null Email Two', '+6283333333333', 'hash')`,
    [tenantAId],
  );
  await pool.query(
    `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash) VALUES ($1, 'Null Phone One', 'nullphone1@example.com', 'hash')`,
    [tenantAId],
  );
  await pool.query(
    `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash) VALUES ($1, 'Null Phone Two', 'nullphone2@example.com', 'hash')`,
    [tenantAId],
  );
});

test('schema: subscriptions and tenant_branding are unique per tenant', async (t) => {
  const url = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  t.after(async () => {
    await pool.end();
    await dropTestDatabase(url);
  });
  await runMigrations(pool, migrationsDir);

  const tenant = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('tenant-sub', 'Tenant Sub', 'Tenant Sub') RETURNING id`,
  );
  const tenantId = tenant.rows[0].id;

  await pool.query(`INSERT INTO subscriptions (tenant_id) VALUES ($1)`, [tenantId]);
  await assertPgError(
    () => pool.query(`INSERT INTO subscriptions (tenant_id) VALUES ($1)`, [tenantId]),
    '23505',
    'second subscription for same tenant',
  );

  await pool.query(`INSERT INTO tenant_branding (tenant_id) VALUES ($1)`, [tenantId]);
  await assertPgError(
    () => pool.query(`INSERT INTO tenant_branding (tenant_id) VALUES ($1)`, [tenantId]),
    '23505',
    'second branding row for same tenant',
  );
});

test('schema: join/feature tables enforce unique pairs', async (t) => {
  const url = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  t.after(async () => {
    await pool.end();
    await dropTestDatabase(url);
  });
  await runMigrations(pool, migrationsDir);

  const tenant = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('tenant-join', 'Tenant Join', 'Tenant Join') RETURNING id`,
  );
  const tenantId = tenant.rows[0].id;

  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash) VALUES ($1, 'Join User', 'join@example.com', 'hash') RETURNING id`,
    [tenantId],
  );
  const userId = user.rows[0].id;

  const team = await pool.query<{ id: string }>(
    `INSERT INTO teams (tenant_id, name) VALUES ($1, 'Team One') RETURNING id`,
    [tenantId],
  );
  const teamId = team.rows[0].id;

  // user_roles: UNIQUE(user_id, role)
  await pool.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'admin')`, [userId]);
  await assertPgError(
    () => pool.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'admin')`, [userId]),
    '23505',
    'duplicate (user_id, role)',
  );
  // A different role for the same user is allowed.
  await pool.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'manager')`, [userId]);

  // team_members: UNIQUE(team_id, user_id)
  await pool.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [teamId, userId]);
  await assertPgError(
    () => pool.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [teamId, userId]),
    '23505',
    'duplicate (team_id, user_id)',
  );

  // manager_teams: UNIQUE(manager_user_id, team_id)
  await pool.query(`INSERT INTO manager_teams (manager_user_id, team_id) VALUES ($1, $2)`, [userId, teamId]);
  await assertPgError(
    () => pool.query(`INSERT INTO manager_teams (manager_user_id, team_id) VALUES ($1, $2)`, [userId, teamId]),
    '23505',
    'duplicate (manager_user_id, team_id)',
  );

  // tenant_features: UNIQUE(tenant_id, feature_key)
  await pool.query(`INSERT INTO tenant_features (tenant_id, feature_key, enabled) VALUES ($1, 'branding', true)`, [
    tenantId,
  ]);
  await assertPgError(
    () =>
      pool.query(`INSERT INTO tenant_features (tenant_id, feature_key, enabled) VALUES ($1, 'branding', false)`, [
        tenantId,
      ]),
    '23505',
    'duplicate (tenant_id, feature_key)',
  );
});
