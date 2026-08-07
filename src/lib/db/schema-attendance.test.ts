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
  // 0004 locations & schedules
  'locations',
  'user_locations',
  'attendance_policies',
  'user_policy_assignments',
  'schedules',
  'schedule_days',
  'user_schedule_assignments',
  'holidays',
  // 0005 attendance
  'work_instances',
  'attendance_events',
  'attendance_anomalies',
  'correction_requests',
  'audit_events',
  // 0006 files & jobs
  'stored_objects',
  'job_runs',
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

async function insertTenant(pool: pg.Pool, slug: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ($1, $2, $2) RETURNING id`,
    [slug, `Tenant ${slug}`],
  );
  return result.rows[0].id;
}

async function insertUser(pool: pg.Pool, tenantId: string, email: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash) VALUES ($1, $2, $2, 'hash') RETURNING id`,
    [tenantId, email],
  );
  return result.rows[0].id;
}

async function insertLocation(pool: pg.Pool, tenantId: string, name: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO locations (tenant_id, name, latitude, longitude, radius_m) VALUES ($1, $2, -6.2, 106.8, 100) RETURNING id`,
    [tenantId, name],
  );
  return result.rows[0].id;
}

async function insertSchedule(pool: pg.Pool, tenantId: string, name: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO schedules (tenant_id, name, timezone, start_local, end_local) VALUES ($1, $2, 'Asia/Jakarta', '09:00', '17:00') RETURNING id`,
    [tenantId, name],
  );
  return result.rows[0].id;
}

test('attendance schema: migrations create all location, schedule, attendance, audit, and files/jobs tables', async (t) => {
  const url = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  t.after(async () => {
    await pool.end();
    await dropTestDatabase(url);
  });

  const applied = await runMigrations(pool, migrationsDir);
  assert.ok(applied.includes('0004_locations_schedules'), 'expected 0004_locations_schedules to be applied');
  assert.ok(applied.includes('0005_attendance'), 'expected 0005_attendance to be applied');
  assert.ok(applied.includes('0006_files_jobs'), 'expected 0006_files_jobs to be applied');

  const result = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  const names = result.rows.map((row) => row.table_name);
  for (const table of EXPECTED_TABLES) {
    assert.ok(names.includes(table), `expected table ${table} to exist, got ${JSON.stringify(names)}`);
  }
});

test('attendance schema: work_instances enforces UNIQUE(tenant_id, user_id, work_date, schedule_id)', async (t) => {
  const url = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  t.after(async () => {
    await pool.end();
    await dropTestDatabase(url);
  });
  await runMigrations(pool, migrationsDir);

  const tenantId = await insertTenant(pool, 'att-a');
  const userId = await insertUser(pool, tenantId, 'worker@example.com');
  const scheduleId = await insertSchedule(pool, tenantId, 'Fixed 9-5');

  await pool.query(
    `INSERT INTO work_instances (tenant_id, user_id, work_date, schedule_id, scheduled_start_at, scheduled_end_at)
     VALUES ($1, $2, '2026-08-10', $3, '2026-08-10 02:00:00+00', '2026-08-10 10:00:00+00')`,
    [tenantId, userId, scheduleId],
  );

  // Same (tenant, user, date, schedule) fails.
  await assertPgError(
    () =>
      pool.query(
        `INSERT INTO work_instances (tenant_id, user_id, work_date, schedule_id, scheduled_start_at, scheduled_end_at)
         VALUES ($1, $2, '2026-08-10', $3, '2026-08-10 02:00:00+00', '2026-08-10 10:00:00+00')`,
        [tenantId, userId, scheduleId],
      ),
    '23505',
    'duplicate work_instances (tenant_id, user_id, work_date, schedule_id)',
  );

  // A different schedule for the same user/date is allowed.
  const otherScheduleId = await insertSchedule(pool, tenantId, 'Night shift');
  await pool.query(
    `INSERT INTO work_instances (tenant_id, user_id, work_date, schedule_id, scheduled_start_at, scheduled_end_at)
     VALUES ($1, $2, '2026-08-10', $3, '2026-08-10 13:00:00+00', '2026-08-10 21:00:00+00')`,
    [tenantId, userId, otherScheduleId],
  );

  // The same user/date/schedule in a DIFFERENT tenant is allowed.
  const tenantBId = await insertTenant(pool, 'att-b');
  const userBId = await insertUser(pool, tenantBId, 'worker-b@example.com');
  const scheduleBId = await insertSchedule(pool, tenantBId, 'Fixed 9-5');
  await pool.query(
    `INSERT INTO work_instances (tenant_id, user_id, work_date, schedule_id, scheduled_start_at, scheduled_end_at)
     VALUES ($1, $2, '2026-08-10', $3, '2026-08-10 02:00:00+00', '2026-08-10 10:00:00+00')`,
    [tenantBId, userBId, scheduleBId],
  );
});

test('attendance schema: attendance_events enforces UNIQUE(tenant_id, user_id, idempotency_key)', async (t) => {
  const url = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  t.after(async () => {
    await pool.end();
    await dropTestDatabase(url);
  });
  await runMigrations(pool, migrationsDir);

  const tenantId = await insertTenant(pool, 'att-idem');
  const userId = await insertUser(pool, tenantId, 'idem@example.com');
  const scheduleId = await insertSchedule(pool, tenantId, 'Fixed 9-5');
  const workInstance = await pool.query<{ id: string }>(
    `INSERT INTO work_instances (tenant_id, user_id, work_date, schedule_id, scheduled_start_at, scheduled_end_at)
     VALUES ($1, $2, '2026-08-10', $3, '2026-08-10 02:00:00+00', '2026-08-10 10:00:00+00') RETURNING id`,
    [tenantId, userId, scheduleId],
  );
  const workInstanceId = workInstance.rows[0].id;

  await pool.query(
    `INSERT INTO attendance_events (tenant_id, user_id, work_instance_id, event_type, idempotency_key, device_occurred_at, source, geofence_result)
     VALUES ($1, $2, $3, 'check_in', 'key-1', '2026-08-10 01:55:00+00', 'web_online', 'inside')`,
    [tenantId, userId, workInstanceId],
  );

  // Duplicate idempotency key for the same tenant+user fails.
  await assertPgError(
    () =>
      pool.query(
        `INSERT INTO attendance_events (tenant_id, user_id, work_instance_id, event_type, idempotency_key, device_occurred_at, source, geofence_result)
         VALUES ($1, $2, $3, 'check_out', 'key-1', '2026-08-10 09:00:00+00', 'web_online', 'inside')`,
        [tenantId, userId, workInstanceId],
      ),
    '23505',
    'duplicate attendance_events (tenant_id, user_id, idempotency_key)',
  );

  // The same idempotency key for a DIFFERENT user is allowed.
  const otherUserId = await insertUser(pool, tenantId, 'other@example.com');
  const otherWorkInstance = await pool.query<{ id: string }>(
    `INSERT INTO work_instances (tenant_id, user_id, work_date, schedule_id, scheduled_start_at, scheduled_end_at)
     VALUES ($1, $2, '2026-08-10', $3, '2026-08-10 02:00:00+00', '2026-08-10 10:00:00+00') RETURNING id`,
    [tenantId, otherUserId, scheduleId],
  );
  await pool.query(
    `INSERT INTO attendance_events (tenant_id, user_id, work_instance_id, event_type, idempotency_key, device_occurred_at, source, geofence_result)
     VALUES ($1, $2, $3, 'check_in', 'key-1', '2026-08-10 01:55:00+00', 'web_online', 'inside')`,
    [tenantId, otherUserId, otherWorkInstance.rows[0].id],
  );
});

test('attendance schema: holidays allows NULL tenant_id (national) and tenant-specific rows', async (t) => {
  const url = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  t.after(async () => {
    await pool.end();
    await dropTestDatabase(url);
  });
  await runMigrations(pool, migrationsDir);

  // National holiday: tenant_id NULL.
  const national = await pool.query<{ id: string; tenant_id: string | null }>(
    `INSERT INTO holidays (tenant_id, holiday_date, name, kind) VALUES (NULL, '2026-08-17', 'Independence Day', 'national') RETURNING id, tenant_id`,
  );
  assert.equal(national.rows[0].tenant_id, null, 'national holiday should have NULL tenant_id');

  // Tenant-specific holiday.
  const tenantId = await insertTenant(pool, 'att-holiday');
  const local = await pool.query<{ id: string; tenant_id: string | null }>(
    `INSERT INTO holidays (tenant_id, holiday_date, name, kind) VALUES ($1, '2026-12-25', 'Company Day', 'company') RETURNING id, tenant_id`,
    [tenantId],
  );
  assert.equal(local.rows[0].tenant_id, tenantId, 'tenant holiday should carry the tenant id');
});

test('attendance schema: sessions tenant_id must match the referenced user tenant_id', async (t) => {
  const url = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  t.after(async () => {
    await pool.end();
    await dropTestDatabase(url);
  });
  await runMigrations(pool, migrationsDir);

  const tenantAId = await insertTenant(pool, 'sess-a');
  const tenantBId = await insertTenant(pool, 'sess-b');
  const userAId = await insertUser(pool, tenantAId, 'sess-a@example.com');

  // Matching tenant succeeds.
  await pool.query(
    `INSERT INTO sessions (tenant_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, 'tok-ok', now() + interval '1 hour')`,
    [tenantAId, userAId],
  );

  // Mismatched tenant fails (SQLSTATE 23503 = foreign key violation).
  await assertPgError(
    () =>
      pool.query(
        `INSERT INTO sessions (tenant_id, user_id, token_hash, expires_at)
         VALUES ($1, $2, 'tok-bad', now() + interval '1 hour')`,
        [tenantBId, userAId],
      ),
    '23503',
    'session with tenant_id differing from the user tenant_id',
  );
});

test('attendance schema: cross-entity attendance FKs enforce tenant consistency', async (t) => {
  const url = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  t.after(async () => {
    await pool.end();
    await dropTestDatabase(url);
  });
  await runMigrations(pool, migrationsDir);

  const tenantAId = await insertTenant(pool, 'x-tenant-a');
  const tenantBId = await insertTenant(pool, 'x-tenant-b');
  const userAId = await insertUser(pool, tenantAId, 'xa@example.com');
  const userBId = await insertUser(pool, tenantBId, 'xb@example.com');
  const scheduleAId = await insertSchedule(pool, tenantAId, 'Schedule A');
  const locationAId = await insertLocation(pool, tenantAId, 'Location A');

  // work_instances: (tenant_id, user_id) must reference a user in the same tenant.
  await assertPgError(
    () =>
      pool.query(
        `INSERT INTO work_instances (tenant_id, user_id, work_date, schedule_id, scheduled_start_at, scheduled_end_at)
         VALUES ($1, $2, '2026-08-10', $3, '2026-08-10 02:00:00+00', '2026-08-10 10:00:00+00')`,
        [tenantAId, userBId, scheduleAId],
      ),
    '23503',
    'work_instances pairing tenant A with a tenant B user',
  );

  // work_instances: (tenant_id, schedule_id) must reference a schedule in the same tenant.
  const scheduleBId = await insertSchedule(pool, tenantBId, 'Schedule B');
  await assertPgError(
    () =>
      pool.query(
        `INSERT INTO work_instances (tenant_id, user_id, work_date, schedule_id, scheduled_start_at, scheduled_end_at)
         VALUES ($1, $2, '2026-08-10', $3, '2026-08-10 02:00:00+00', '2026-08-10 10:00:00+00')`,
        [tenantAId, userAId, scheduleBId],
      ),
    '23503',
    'work_instances pairing tenant A with a tenant B schedule',
  );

  // A consistent work instance succeeds and anchors the event-level checks.
  const workInstance = await pool.query<{ id: string }>(
    `INSERT INTO work_instances (tenant_id, user_id, work_date, schedule_id, scheduled_start_at, scheduled_end_at)
     VALUES ($1, $2, '2026-08-10', $3, '2026-08-10 02:00:00+00', '2026-08-10 10:00:00+00') RETURNING id`,
    [tenantAId, userAId, scheduleAId],
  );
  const workInstanceId = workInstance.rows[0].id;

  // attendance_events: (tenant_id, work_instance_id) must reference a work instance in the same tenant.
  await assertPgError(
    () =>
      pool.query(
        `INSERT INTO attendance_events (tenant_id, user_id, work_instance_id, event_type, idempotency_key, device_occurred_at, source, geofence_result)
         VALUES ($1, $2, $3, 'check_in', 'x-key-1', '2026-08-10 01:55:00+00', 'web_online', 'inside')`,
        [tenantBId, userBId, workInstanceId],
      ),
    '23503',
    'attendance_events pairing tenant B with a tenant A work instance',
  );

  // attendance_events: (tenant_id, location_id) must reference a location in the same tenant.
  await assertPgError(
    () =>
      pool.query(
        `INSERT INTO attendance_events (tenant_id, user_id, work_instance_id, event_type, idempotency_key, device_occurred_at, source, geofence_result, location_id)
         VALUES ($1, $2, $3, 'check_in', 'x-key-2', '2026-08-10 01:55:00+00', 'web_online', 'inside', $4)`,
        [tenantBId, userBId, workInstanceId, locationAId],
      ),
    '23503',
    'attendance_events pairing tenant B with a tenant A location',
  );
});

test('attendance schema: tenant_branding media columns reference stored_objects', async (t) => {
  const url = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  t.after(async () => {
    await pool.end();
    await dropTestDatabase(url);
  });
  await runMigrations(pool, migrationsDir);

  const tenantId = await insertTenant(pool, 'brand-a');

  // Branding rows may leave the media columns NULL.
  await pool.query(`INSERT INTO tenant_branding (tenant_id) VALUES ($1)`, [tenantId]);

  // A stored object can be linked as the logo.
  const storedObject = await pool.query<{ id: string }>(
    `INSERT INTO stored_objects (tenant_id, kind, relative_path, media_type, byte_size, sha256)
     VALUES ($1, 'branding_logo', 'tenants/brand-a/logo.jpg', 'image/jpeg', 12345, 'abc123') RETURNING id`,
    [tenantId],
  );
  const storedObjectId = storedObject.rows[0].id;
  await pool.query(`UPDATE tenant_branding SET logo_object_id = $1 WHERE tenant_id = $2`, [storedObjectId, tenantId]);

  // A non-existent stored object id is rejected (SQLSTATE 23503).
  const missingId = '00000000-0000-0000-0000-000000000000';
  await assertPgError(
    () => pool.query(`UPDATE tenant_branding SET icon_object_id = $1 WHERE tenant_id = $2`, [missingId, tenantId]),
    '23503',
    'tenant_branding referencing a missing stored object',
  );
});
