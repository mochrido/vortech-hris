import type pg from 'pg';
import { hashPassword } from '../auth/password.ts';
import { generateTotpSecret, encryptTotpSecret } from '../auth/totp.ts';
import { INDONESIAN_HOLIDAYS } from './holidays.ts';

/**
 * Idempotent seed for local development and first-boot (Phase 0 spec "Seed
 * data"). Creates:
 *  - one superadmin (platform tenant `vortech-platform`) with TOTP enrolled,
 *  - one demo tenant `vortech-demo` with admin/manager/member users, two
 *    locations (per-location radius, decisions.md #1), one fixed Mon-Fri
 *    schedule, and a `trial` subscription (25 users, decisions.md #7),
 *  - the 2026-2027 Indonesian national holidays (decisions.md #9).
 *
 * Upserts are keyed by stable identifiers (tenant slug, user email) so the
 * seed can run repeatedly without creating duplicates.
 *
 * Dev-only passwords come from SEED_*_PASSWORD env vars with well-known local
 * defaults; they are NOT real secrets and must be overridden anywhere real.
 */

export interface SeedSummary {
  superadminEmail: string;
  tenantSlug: string;
  usersCreated: number;
  locationsCreated: number;
  schedulesCreated: number;
  holidaysInserted: number;
}

const SUPERADMIN_TENANT_SLUG = 'vortech-platform';
const DEMO_TENANT_SLUG = 'vortech-demo';

const SUPERADMIN_EMAIL = 'superadmin@vortech.local';
const DEMO_ADMIN_EMAIL = 'admin@vortech-demo.local';
const DEMO_MANAGER_EMAIL = 'manager@vortech-demo.local';
const DEMO_MEMBER_EMAIL = 'member@vortech-demo.local';

function seedPassword(envKey: string, fallback: string): string {
  const value = process.env[envKey];
  return value && value.length > 0 ? value : fallback;
}

async function upsertTenant(
  client: pg.PoolClient,
  tenant: { slug: string; legalName: string; displayName: string },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE SET legal_name = EXCLUDED.legal_name, display_name = EXCLUDED.display_name
     RETURNING id`,
    [tenant.slug, tenant.legalName, tenant.displayName],
  );
  return result.rows[0].id;
}

/**
 * Returns the user id and whether this call inserted the row. Inserts the
 * user (and hashes `password`) only if the (tenant, email) does not already
 * exist.
 */
async function upsertUser(
  client: pg.PoolClient,
  user: { tenantId: string; displayName: string; email: string; password: string },
): Promise<{ id: string; inserted: boolean }> {
  const passwordHash = await hashPassword(user.password);
  // Single atomic INSERT ... ON CONFLICT ... DO NOTHING keyed on the partial
  // unique index users_tenant_email_key ((tenant_id, email_normalized) WHERE
  // email_normalized IS NOT NULL). The WHERE clause in the inference spec is
  // required so Postgres can match the partial index by column list. This
  // removes the SELECT-then-INSERT TOCTOU gap: a concurrent seed inserting the
  // same (tenant, email) no longer throws a unique violation.
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, email_normalized) WHERE email_normalized IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [user.tenantId, user.displayName, user.email, passwordHash],
  );
  if (inserted.rows.length > 0) {
    return { id: inserted.rows[0].id, inserted: true };
  }

  // Row already existed: fetch its id so callers always get a usable user id.
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE tenant_id = $1 AND email_normalized = $2`,
    [user.tenantId, user.email],
  );
  return { id: existing.rows[0].id, inserted: false };
}

async function ensureRole(client: pg.PoolClient, userId: string, role: string): Promise<void> {
  await client.query(
    `INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id, role) DO NOTHING`,
    [userId, role],
  );
}

async function seedSuperadmin(client: pg.PoolClient): Promise<{ email: string; userInserted: boolean }> {
  const tenantId = await upsertTenant(client, {
    slug: SUPERADMIN_TENANT_SLUG,
    legalName: 'Vortech Platform',
    displayName: 'Vortech Platform',
  });

  const { id: userId, inserted: userInserted } = await upsertUser(client, {
    tenantId,
    displayName: 'Superadmin',
    email: SUPERADMIN_EMAIL,
    password: seedPassword('SEED_SUPERADMIN_PASSWORD', 'Superadmin-Dev-0000'),
  });
  await ensureRole(client, userId, 'superadmin');

  // Enroll a confirmed TOTP credential only if none exists yet: regenerating
  // on every run would silently invalidate the superadmin's authenticator.
  const totp = await client.query<{ user_id: string }>(
    `SELECT user_id FROM totp_credentials WHERE user_id = $1`,
    [userId],
  );
  if (totp.rows.length === 0) {
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    await client.query(
      `INSERT INTO totp_credentials (user_id, encrypted_secret, confirmed_at)
       VALUES ($1, $2, now())`,
      [userId, encrypted],
    );
  }

  return { email: SUPERADMIN_EMAIL, userInserted };
}

async function seedDemoTenant(client: pg.PoolClient): Promise<{ tenantId: string; usersCreated: number }> {
  const tenantId = await upsertTenant(client, {
    slug: DEMO_TENANT_SLUG,
    legalName: 'Vortech Demo',
    displayName: 'Vortech Demo',
  });

  let usersCreated = 0;

  const admin = await upsertUser(client, {
    tenantId,
    displayName: 'Demo Admin',
    email: DEMO_ADMIN_EMAIL,
    password: seedPassword('SEED_DEMO_ADMIN_PASSWORD', 'Admin-Dev-0000'),
  });
  if (admin.inserted) usersCreated++;
  await ensureRole(client, admin.id, 'admin');

  const manager = await upsertUser(client, {
    tenantId,
    displayName: 'Demo Manager',
    email: DEMO_MANAGER_EMAIL,
    password: seedPassword('SEED_DEMO_MANAGER_PASSWORD', 'Manager-Dev-0000'),
  });
  if (manager.inserted) usersCreated++;
  await ensureRole(client, manager.id, 'manager');

  const member = await upsertUser(client, {
    tenantId,
    displayName: 'Demo Member',
    email: DEMO_MEMBER_EMAIL,
    password: seedPassword('SEED_DEMO_MEMBER_PASSWORD', 'Member-Dev-0000'),
  });
  if (member.inserted) usersCreated++;
  await ensureRole(client, member.id, 'member');

  return { tenantId, usersCreated };
}

/** Two locations, each with its own radius (decisions.md #1). Keyed by (tenant, name). */
async function seedLocations(client: pg.PoolClient, tenantId: string): Promise<number> {
  const locations = [
    { name: 'Kantor Pusat Jakarta', latitude: '-6.200000', longitude: '106.816666', radiusM: 100 },
    { name: 'Kantor Cabang Bandung', latitude: '-6.914744', longitude: '107.609810', radiusM: 150 },
  ];
  let inserted = 0;
  for (const loc of locations) {
    const result = await client.query(
      `INSERT INTO locations (tenant_id, name, latitude, longitude, radius_m)
       SELECT $1, $2, $3, $4, $5
       WHERE NOT EXISTS (SELECT 1 FROM locations WHERE tenant_id = $1 AND name = $2)`,
      [tenantId, loc.name, loc.latitude, loc.longitude, loc.radiusM],
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

/** One fixed Mon-Fri 09:00-17:00 schedule with its schedule_days rows. */
async function seedSchedule(client: pg.PoolClient, tenantId: string): Promise<number> {
  const schedule = await client.query<{ id: string }>(
    `INSERT INTO schedules (tenant_id, name, timezone, start_local, end_local)
     SELECT $1, 'Jam Kantor Tetap', 'Asia/Jakarta', '09:00', '17:00'
     WHERE NOT EXISTS (SELECT 1 FROM schedules WHERE tenant_id = $1 AND name = 'Jam Kantor Tetap')
     RETURNING id`,
    [tenantId],
  );

  let scheduleId: string;
  if (schedule.rows.length > 0) {
    scheduleId = schedule.rows[0].id;
  } else {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM schedules WHERE tenant_id = $1 AND name = 'Jam Kantor Tetap'`,
      [tenantId],
    );
    scheduleId = existing.rows[0].id;
  }

  // Monday..Friday = weekday 1..5 (0 = Sunday .. 6 = Saturday).
  for (const weekday of [1, 2, 3, 4, 5]) {
    await client.query(
      `INSERT INTO schedule_days (schedule_id, weekday) VALUES ($1, $2)
       ON CONFLICT (schedule_id, weekday) DO NOTHING`,
      [scheduleId, weekday],
    );
  }

  // The schedule was inserted by this run only if the INSERT ... RETURNING
  // produced a row; an existing schedule means zero inserted.
  return schedule.rows.length;
}

/** Trial subscription: 25 users (decisions.md #7). One row per tenant. */
async function seedSubscription(client: pg.PoolClient, tenantId: string): Promise<void> {
  await client.query(
    `INSERT INTO subscriptions (tenant_id, plan_key, status, user_limit)
     VALUES ($1, 'trial', 'trial', 25)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId],
  );
}

/** National holidays carry tenant_id NULL; key idempotency on (date, name). */
async function seedHolidays(client: pg.PoolClient): Promise<number> {
  let inserted = 0;
  for (const holiday of INDONESIAN_HOLIDAYS) {
    const result = await client.query(
      `INSERT INTO holidays (tenant_id, holiday_date, name, kind)
       SELECT NULL, $1, $2, $3
       WHERE NOT EXISTS (
         SELECT 1 FROM holidays WHERE tenant_id IS NULL AND holiday_date = $1 AND name = $2
       )`,
      [holiday.date, holiday.name, holiday.kind],
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

/**
 * Runs the full seed inside a single transaction so a failure leaves the
 * database untouched. Safe to run repeatedly.
 */
export async function runSeed(pool: pg.Pool): Promise<SeedSummary> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const superadmin = await seedSuperadmin(client);
    const demo = await seedDemoTenant(client);
    const usersCreated = (superadmin.userInserted ? 1 : 0) + demo.usersCreated;
    const locationsCreated = await seedLocations(client, demo.tenantId);
    const schedulesCreated = await seedSchedule(client, demo.tenantId);
    await seedSubscription(client, demo.tenantId);
    const holidaysInserted = await seedHolidays(client);

    await client.query('COMMIT');

    return {
      superadminEmail: superadmin.email,
      tenantSlug: DEMO_TENANT_SLUG,
      usersCreated,
      locationsCreated,
      schedulesCreated,
      holidaysInserted,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
