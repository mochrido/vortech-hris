import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Minimal .env loader: KEY=VALUE lines, # comments, no dotenv dependency. */
function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function adminUrl(): string {
  loadEnvFile(path.join(repoRoot, '.env'));
  const url = process.env.TEST_DATABASE_ADMIN_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_ADMIN_URL is not set (checked environment and .env)');
  }
  return url;
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
