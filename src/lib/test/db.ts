import { randomBytes } from 'node:crypto';
import pg from 'pg';

const DEFAULT_ADMIN_URL = 'postgresql://postgres:vortech-dev-pg@127.0.0.1:5432/postgres';

function adminUrl(): string {
  return process.env.TEST_DATABASE_ADMIN_URL ?? DEFAULT_ADMIN_URL;
}

/** Database name embedded in a test database connection URL. */
export function testDatabaseName(url: string): string {
  const parsed = new URL(url);
  return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
}

/**
 * Creates a unique ephemeral database `vortech_test_<rand>` using the
 * superuser connection (TEST_DATABASE_ADMIN_URL) and returns a connection
 * URL for it.
 */
export async function createTestDatabase(): Promise<string> {
  const suffix = randomBytes(6).toString('hex');
  const name = `vortech_test_${suffix}`;

  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    // Identifiers cannot be parameterized; `name` is fully generated above.
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const base = new URL(adminUrl());
  return `${base.protocol}//${base.username}:${base.password}@${base.host}/${name}`;
}

/** Drops a test database previously created by createTestDatabase(). */
export async function dropTestDatabase(url: string): Promise<void> {
  const name = testDatabaseName(url);
  if (!/^vortech_test_[0-9a-f]{12}$/.test(name)) {
    throw new Error(`refusing to drop non-test database: ${name}`);
  }

  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  } finally {
    await admin.end();
  }
}
