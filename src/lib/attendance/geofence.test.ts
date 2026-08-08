import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createTestDatabase, dropTestDatabase } from '../test/db.ts';
import { runMigrations } from '../db/migrate.ts';
import { closePool } from '../db/pool.ts';
import { getEffectivePolicy, evaluateGeofence, type EffectivePolicy } from './geofence.ts';
import type { GeoLocation } from './geo.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = path.join(repoRoot, 'migrations');

interface DbFixture {
  url: string;
  pool: pg.Pool;
}

async function setupDb(t: test.TestContext): Promise<DbFixture> {
  await closePool();
  const url = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  t.after(async () => {
    await closePool();
    await pool.end();
    await dropTestDatabase(url);
  });
  await runMigrations(pool, migrationsDir);
  return { url, pool };
}

async function insertTenant(pool: pg.Pool, slug: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ($1, $2, $3) RETURNING id`,
    [slug, `${slug} Legal`, `${slug} Display`],
  );
  return result.rows[0].id;
}

async function insertUser(
  pool: pg.Pool,
  tenantId: string,
  email: string,
  employmentType: 'employee' | 'field_worker',
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash, employment_type, active)
     VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
    [tenantId, 'Test User', email, 'scrypt$1$1$1$AAAA$BBBB', employmentType],
  );
  return result.rows[0].id;
}

async function insertLocation(
  pool: pg.Pool,
  tenantId: string,
  name: string,
  lat: number,
  lon: number,
  radiusM: number | null,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO locations (tenant_id, name, latitude, longitude, radius_m, active)
     VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
    [tenantId, name, lat, lon, radiusM],
  );
  return result.rows[0].id;
}

async function assignLocation(pool: pg.Pool, userId: string, locationId: string): Promise<void> {
  await pool.query(`INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)`, [userId, locationId]);
}

async function insertPolicy(
  pool: pg.Pool,
  tenantId: string,
  opts: {
    name: string;
    geofenceMode: 'mandatory' | 'optional';
    selfieRequired?: boolean;
    maxAccuracyM?: number | null;
    retryCount?: number;
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO attendance_policies (tenant_id, name, geofence_mode, selfie_required, max_accuracy_m, retry_count)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      tenantId,
      opts.name,
      opts.geofenceMode,
      opts.selfieRequired ?? true,
      opts.maxAccuracyM ?? null,
      opts.retryCount ?? 3,
    ],
  );
  return result.rows[0].id;
}

async function assignPolicy(
  pool: pg.Pool,
  userId: string,
  policyId: string,
  effectiveFrom: string,
  effectiveTo: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO user_policy_assignments (user_id, policy_id, effective_from, effective_to)
     VALUES ($1, $2, $3, $4)`,
    [userId, policyId, effectiveFrom, effectiveTo],
  );
}

// ---------------------------------------------------------------------------
// getEffectivePolicy
// ---------------------------------------------------------------------------

test('getEffectivePolicy returns mandatory for an employee with no explicit assignment', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool, 'acme');
  const userId = await insertUser(fixture.pool, tenantId, 'alice@acme.test', 'employee');
  const tenant = { id: tenantId, max_accuracy_m: 50 };

  const policy = await getEffectivePolicy(fixture.pool, { id: userId, tenant_id: tenantId, employment_type: 'employee' }, tenant);

  assert.equal(policy.geofenceMode, 'mandatory');
  assert.equal(policy.maxAccuracyM, 50);
  assert.equal(policy.retryCount, 3);
  assert.equal(policy.selfieRequired, true);
});

test('getEffectivePolicy returns optional for a field_worker with no explicit assignment', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool, 'field');
  const userId = await insertUser(fixture.pool, tenantId, 'bob@field.test', 'field_worker');
  const tenant = { id: tenantId, max_accuracy_m: 50 };

  const policy = await getEffectivePolicy(fixture.pool, { id: userId, tenant_id: tenantId, employment_type: 'field_worker' }, tenant);

  assert.equal(policy.geofenceMode, 'optional');
  assert.equal(policy.maxAccuracyM, 50);
  assert.equal(policy.retryCount, 3);
  assert.equal(policy.selfieRequired, true);
});

test('getEffectivePolicy uses tenant max_accuracy_m override', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool, 'strict');
  await fixture.pool.query(`UPDATE tenants SET max_accuracy_m = 30 WHERE id = $1`, [tenantId]);
  const userId = await insertUser(fixture.pool, tenantId, 'carol@strict.test', 'employee');
  const tenant = { id: tenantId, max_accuracy_m: 30 };

  const policy = await getEffectivePolicy(fixture.pool, { id: userId, tenant_id: tenantId, employment_type: 'employee' }, tenant);

  assert.equal(policy.maxAccuracyM, 30);
});

test('getEffectivePolicy resolves an explicit user_policy_assignments row over the employment-type default', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool, 'override');
  const userId = await insertUser(fixture.pool, tenantId, 'dave@override.test', 'employee');
  const policyId = await insertPolicy(fixture.pool, tenantId, {
    name: 'Field Exception',
    geofenceMode: 'optional',
    selfieRequired: false,
    maxAccuracyM: 25,
    retryCount: 5,
  });
  await assignPolicy(fixture.pool, userId, policyId, '2026-01-01', null);
  const tenant = { id: tenantId, max_accuracy_m: 50 };

  const policy = await getEffectivePolicy(fixture.pool, { id: userId, tenant_id: tenantId, employment_type: 'employee' }, tenant);

  assert.equal(policy.geofenceMode, 'optional');
  assert.equal(policy.maxAccuracyM, 25);
  assert.equal(policy.retryCount, 5);
  assert.equal(policy.selfieRequired, false);
});

test('getEffectivePolicy falls back to tenant max_accuracy_m when policy max_accuracy_m is null', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool, 'fallback');
  const userId = await insertUser(fixture.pool, tenantId, 'erin@fallback.test', 'field_worker');
  const policyId = await insertPolicy(fixture.pool, tenantId, {
    name: 'No Accuracy Override',
    geofenceMode: 'mandatory',
    maxAccuracyM: null,
  });
  await assignPolicy(fixture.pool, userId, policyId, '2026-01-01', null);
  const tenant = { id: tenantId, max_accuracy_m: 50 };

  const policy = await getEffectivePolicy(fixture.pool, { id: userId, tenant_id: tenantId, employment_type: 'field_worker' }, tenant);

  assert.equal(policy.geofenceMode, 'mandatory');
  assert.equal(policy.maxAccuracyM, 50);
  assert.equal(policy.retryCount, 3);
});

test('getEffectivePolicy ignores expired and future-dated assignments', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool, 'dates');
  const userId = await insertUser(fixture.pool, tenantId, 'frank@dates.test', 'employee');
  const expiredId = await insertPolicy(fixture.pool, tenantId, { name: 'Expired', geofenceMode: 'optional' });
  const futureId = await insertPolicy(fixture.pool, tenantId, { name: 'Future', geofenceMode: 'optional' });
  await assignPolicy(fixture.pool, userId, expiredId, '2026-01-01', '2026-06-30');
  await assignPolicy(fixture.pool, userId, futureId, '2027-01-01', null);
  const tenant = { id: tenantId, max_accuracy_m: 50 };

  const policy = await getEffectivePolicy(fixture.pool, { id: userId, tenant_id: tenantId, employment_type: 'employee' }, tenant);

  // No active assignment: falls back to employment-type default (employee = mandatory)
  assert.equal(policy.geofenceMode, 'mandatory');
  assert.equal(policy.maxAccuracyM, 50);
  assert.equal(policy.retryCount, 3);
});

// ---------------------------------------------------------------------------
// evaluateGeofence
// ---------------------------------------------------------------------------

const MANDATORY: EffectivePolicy = { geofenceMode: 'mandatory', maxAccuracyM: 50, retryCount: 3, selfieRequired: true };
const OPTIONAL: EffectivePolicy = { geofenceMode: 'optional', maxAccuracyM: 50, retryCount: 3, selfieRequired: true };

interface TestLocation extends GeoLocation {
  id: string;
}

const JAKARTA: TestLocation = { id: 'loc-jkt', latitude: -6.2, longitude: 106.816, radius_m: 150 };
const BANDUNG: TestLocation = { id: 'loc-bdg', latitude: -6.914744, longitude: 107.60981, radius_m: 100 };

test('evaluateGeofence returns inside with locationId and distanceM when within radius', () => {
  const verdict = evaluateGeofence({
    policy: MANDATORY,
    latitude: -6.2,
    longitude: 106.816,
    accuracyM: 10,
    locations: [JAKARTA],
  });

  assert.equal(verdict.kind, 'inside');
  assert.equal(verdict.locationId, 'loc-jkt');
  assert.equal(typeof verdict.distanceM, 'number');
  assert.ok(verdict.distanceM! <= 150);
});

test('evaluateGeofence returns inside when inside ANY of multiple locations', () => {
  const verdict = evaluateGeofence({
    policy: MANDATORY,
    latitude: -6.2,
    longitude: 106.816,
    accuracyM: 10,
    locations: [BANDUNG, JAKARTA],
  });

  assert.equal(verdict.kind, 'inside');
  assert.equal(verdict.locationId, 'loc-jkt');
});

test('evaluateGeofence returns outside_blocked for mandatory policy outside all locations', () => {
  const verdict = evaluateGeofence({
    policy: MANDATORY,
    latitude: 0,
    longitude: 0,
    accuracyM: 10,
    locations: [JAKARTA],
  });

  assert.equal(verdict.kind, 'outside_blocked');
  assert.equal(verdict.distanceM, undefined);
  assert.equal(verdict.locationId, undefined);
});

test('evaluateGeofence returns outside_accepted for optional policy outside all locations', () => {
  const verdict = evaluateGeofence({
    policy: OPTIONAL,
    latitude: 0,
    longitude: 0,
    accuracyM: 10,
    locations: [JAKARTA],
  });

  assert.equal(verdict.kind, 'outside_accepted');
  assert.equal(typeof verdict.distanceM, 'number');
  assert.ok(verdict.distanceM! > 150);
});

test('evaluateGeofence returns no_location_blocked for mandatory policy with null coords', () => {
  const verdict = evaluateGeofence({
    policy: MANDATORY,
    latitude: null,
    longitude: null,
    accuracyM: null,
    locations: [JAKARTA],
  });

  assert.equal(verdict.kind, 'no_location_blocked');
  assert.equal(verdict.distanceM, undefined);
  assert.equal(verdict.locationId, undefined);
});

test('evaluateGeofence returns no_location_accepted for optional policy with null coords', () => {
  const verdict = evaluateGeofence({
    policy: OPTIONAL,
    latitude: null,
    longitude: null,
    accuracyM: null,
    locations: [JAKARTA],
  });

  assert.equal(verdict.kind, 'no_location_accepted');
  assert.equal(verdict.distanceM, undefined);
  assert.equal(verdict.locationId, undefined);
});

test('evaluateGeofence returns accuracy_review when accuracyM exceeds maxAccuracyM (inside)', () => {
  const verdict = evaluateGeofence({
    policy: MANDATORY,
    latitude: -6.2,
    longitude: 106.816,
    accuracyM: 75,
    locations: [JAKARTA],
  });

  assert.equal(verdict.kind, 'accuracy_review');
  assert.equal(verdict.locationId, 'loc-jkt');
  assert.equal(typeof verdict.distanceM, 'number');
});

test('evaluateGeofence returns accuracy_review when accuracyM exceeds maxAccuracyM (outside)', () => {
  const verdict = evaluateGeofence({
    policy: MANDATORY,
    latitude: 0,
    longitude: 0,
    accuracyM: 75,
    locations: [JAKARTA],
  });

  assert.equal(verdict.kind, 'accuracy_review');
  assert.equal(verdict.locationId, undefined);
  assert.equal(typeof verdict.distanceM, 'number');
});

test('evaluateGeofence boundary: on-radius counts as inside', () => {
  // 1 degree of latitude = ~111194.9 m; radius 111195 means the point sits just inside
  const boundary: TestLocation = { id: 'loc-boundary', latitude: 0, longitude: 0, radius_m: 111195 };
  const verdict = evaluateGeofence({
    policy: MANDATORY,
    latitude: 1,
    longitude: 0,
    accuracyM: 10,
    locations: [boundary],
  });

  assert.equal(verdict.kind, 'inside');
  assert.equal(verdict.locationId, 'loc-boundary');
});

test('evaluateGeofence accuracy_review takes precedence over inside/outside verdicts', () => {
  // Inside with bad accuracy -> accuracy_review (not inside)
  const v1 = evaluateGeofence({
    policy: MANDATORY,
    latitude: -6.2,
    longitude: 106.816,
    accuracyM: 100,
    locations: [JAKARTA],
  });
  assert.equal(v1.kind, 'accuracy_review');

  // Outside with bad accuracy -> accuracy_review (not outside_blocked)
  const v2 = evaluateGeofence({
    policy: MANDATORY,
    latitude: 0,
    longitude: 0,
    accuracyM: 100,
    locations: [JAKARTA],
  });
  assert.equal(v2.kind, 'accuracy_review');
});

test('evaluateGeofence accuracy_review NOT triggered when accuracyM is null', () => {
  // accuracyM null means accuracy unknown; treated as acceptable for review purposes
  const verdict = evaluateGeofence({
    policy: MANDATORY,
    latitude: -6.2,
    longitude: 106.816,
    accuracyM: null,
    locations: [JAKARTA],
  });

  assert.equal(verdict.kind, 'inside');
});

test('evaluateGeofence accuracy_review NOT triggered when accuracyM equals maxAccuracyM', () => {
  const verdict = evaluateGeofence({
    policy: MANDATORY,
    latitude: -6.2,
    longitude: 106.816,
    accuracyM: 50,
    locations: [JAKARTA],
  });

  assert.equal(verdict.kind, 'inside');
});
