import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createTestDatabase, dropTestDatabase } from '../test/db.ts';
import { loadEnvFile } from '../test/env.ts';
import { runMigrations } from '../db/migrate.ts';
import { runSeed } from './seed.ts';
import { decryptTotpSecret } from '../auth/totp.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = path.join(repoRoot, 'migrations');

// runSeed encrypts the superadmin TOTP secret with TOTP_ENCRYPTION_KEY. Load
// the repo `.env` up-front so the key is present for the seed.
loadEnvFile(path.join(repoRoot, '.env'));

interface CountRow {
  count: string;
}

async function count(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<number> {
  const result = await pool.query<CountRow>(sql, params);
  return Number(result.rows[0].count);
}

/** Counts of every table the seed writes to, used to prove idempotency. */
async function seedTableCounts(pool: pg.Pool): Promise<Record<string, number>> {
  const tables = [
    'tenants',
    'users',
    'user_roles',
    'totp_credentials',
    'subscriptions',
    'locations',
    'schedules',
    'schedule_days',
    'holidays',
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] = await count(pool, `SELECT count(*) AS count FROM ${table}`);
  }
  return counts;
}

test('seed: creates superadmin with TOTP, demo tenant with users/locations/schedule/subscription, and national holidays', async (t) => {
  const url = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  t.after(async () => {
    await pool.end();
    await dropTestDatabase(url);
  });

  await runMigrations(pool, migrationsDir);
  await runSeed(pool);

  // Exactly one superadmin user with the superadmin role.
  const superadminCount = await count(
    pool,
    `SELECT count(*) AS count FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role = 'superadmin'`,
  );
  assert.equal(superadminCount, 1, 'expected exactly one superadmin');

  // The superadmin has a confirmed TOTP credential row.
  const confirmedTotp = await count(
    pool,
    `SELECT count(*) AS count
       FROM totp_credentials tc
       JOIN user_roles r ON r.user_id = tc.user_id AND r.role = 'superadmin'
      WHERE tc.confirmed_at IS NOT NULL`,
  );
  assert.equal(confirmedTotp, 1, 'expected superadmin to have a confirmed TOTP credential');

  // --- At-rest encryption: seeded credentials must NOT be stored as plaintext ---

  // (a) Every seeded user's password_hash is a scrypt hash, not plaintext.
  const passwordHashes = await pool.query<{ password_hash: string }>(`SELECT password_hash FROM users`);
  assert.ok(passwordHashes.rows.length > 0, 'expected seeded users to exist');
  for (const row of passwordHashes.rows) {
    assert.ok(
      row.password_hash.startsWith('scrypt$'),
      `password_hash must be a scrypt hash, not plaintext: ${row.password_hash.slice(0, 24)}...`,
    );
  }

  // (b) The superadmin's stored TOTP secret is AES-256-GCM ciphertext, not the
  // plaintext base32 secret, and round-trips back to a valid base32 secret via
  // decryptTotpSecret under TOTP_ENCRYPTION_KEY.
  const superadminTotp = await pool.query<{ encrypted_secret: string }>(
    `SELECT tc.encrypted_secret
       FROM totp_credentials tc
       JOIN user_roles r ON r.user_id = tc.user_id AND r.role = 'superadmin'`,
  );
  assert.equal(superadminTotp.rows.length, 1, 'expected exactly one superadmin TOTP credential');
  const encryptedSecret = superadminTotp.rows[0].encrypted_secret;

  // A plaintext base32 secret would be stored verbatim; ciphertext is base64 of
  // [IV|tag|ciphertext] and must not decode back to the raw base32 secret.
  assert.notEqual(
    encryptedSecret,
    decryptTotpSecret(encryptedSecret),
    'encrypted_secret must not equal its decrypted plaintext (stored value must be ciphertext)',
  );

  const decrypted = decryptTotpSecret(encryptedSecret);
  assert.match(
    decrypted,
    /^[A-Z2-7]+$/,
    'decrypted superadmin TOTP secret must be a valid base32 secret',
  );

  // Demo tenant with a trial subscription limited to 25 users.
  const tenant = await pool.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'vortech-demo'`);
  assert.equal(tenant.rows.length, 1, 'expected tenant vortech-demo to exist');
  const tenantId = tenant.rows[0].id;

  const subscription = await pool.query<{ plan_key: string; user_limit: number }>(
    `SELECT plan_key, user_limit FROM subscriptions WHERE tenant_id = $1`,
    [tenantId],
  );
  assert.equal(subscription.rows.length, 1, 'expected a subscription for the demo tenant');
  assert.equal(subscription.rows[0].plan_key, 'trial');
  assert.equal(subscription.rows[0].user_limit, 25);

  // Admin, manager, and member users each with the appropriate role.
  for (const role of ['admin', 'manager', 'member']) {
    const roleCount = await count(
      pool,
      `SELECT count(*) AS count
         FROM users u
         JOIN user_roles r ON r.user_id = u.id
        WHERE u.tenant_id = $1 AND r.role = $2`,
      [tenantId, role],
    );
    assert.equal(roleCount, 1, `expected one demo user with role ${role}`);
  }

  // Two locations, each with a non-null radius.
  const locationCount = await count(pool, `SELECT count(*) AS count FROM locations WHERE tenant_id = $1`, [tenantId]);
  assert.equal(locationCount, 2, 'expected two demo locations');
  const nullRadius = await count(
    pool,
    `SELECT count(*) AS count FROM locations WHERE tenant_id = $1 AND radius_m IS NULL`,
    [tenantId],
  );
  assert.equal(nullRadius, 0, 'every demo location must have a radius');

  // One schedule with schedule_days rows.
  const scheduleCount = await count(pool, `SELECT count(*) AS count FROM schedules WHERE tenant_id = $1`, [tenantId]);
  assert.equal(scheduleCount, 1, 'expected one demo schedule');
  const dayCount = await count(
    pool,
    `SELECT count(*) AS count FROM schedule_days sd JOIN schedules s ON s.id = sd.schedule_id WHERE s.tenant_id = $1`,
    [tenantId],
  );
  assert.ok(dayCount > 0, 'expected schedule_days rows for the demo schedule');

  // National holidays seeded for 2026 and 2027 with tenant_id NULL.
  for (const year of ['2026', '2027']) {
    const yearCount = await count(
      pool,
      `SELECT count(*) AS count FROM holidays
        WHERE kind = 'national' AND tenant_id IS NULL AND holiday_date >= $1::date AND holiday_date < ($1::date + interval '1 year')`,
      [`${year}-01-01`],
    );
    assert.ok(yearCount > 0, `expected national holidays for ${year}`);
  }
});

test('seed: running the seed a second time is idempotent', async (t) => {
  const url = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  t.after(async () => {
    await pool.end();
    await dropTestDatabase(url);
  });

  await runMigrations(pool, migrationsDir);
  const first = await runSeed(pool);
  const before = await seedTableCounts(pool);

  const second = await runSeed(pool);
  const after = await seedTableCounts(pool);

  assert.deepEqual(after, before, 'second seed run must not change any seeded table counts');

  // Second run must report zero newly inserted rows for every seeded entity.
  assert.equal(second.usersCreated, 0, 'second run must report 0 users inserted');
  assert.equal(second.locationsCreated, 0, 'second run must report 0 locations inserted');
  assert.equal(second.schedulesCreated, 0, 'second run must report 0 schedules inserted');
  assert.equal(second.holidaysInserted, 0, 'second run must report 0 holidays inserted');

  // First run must report the expected positive counts.
  assert.ok(first.usersCreated > 0, 'first run must report users inserted');
  assert.ok(first.locationsCreated > 0, 'first run must report locations inserted');
  assert.ok(first.schedulesCreated > 0, 'first run must report schedules inserted');
  assert.ok(first.holidaysInserted > 0, 'first run must report holidays inserted');

  // Spot-check the specific identities the task calls out. Counts reflect one
  // platform tenant (superadmin) plus one demo tenant.
  assert.equal(after.users, 4, 'expected superadmin + 3 demo users, no duplicates');
  assert.equal(after.tenants, 2, 'expected platform + demo tenants, no duplicates');
  assert.equal(after.locations, 2, 'expected two demo locations, no duplicates');
  assert.ok(after.holidays > 0, 'expected seeded national holidays');
  const nationalHolidays = await count(
    pool,
    `SELECT count(*) AS count FROM holidays WHERE kind = 'national' AND tenant_id IS NULL`,
  );
  assert.equal(nationalHolidays, after.holidays, 'all seeded holidays are national/platform-wide');
});
