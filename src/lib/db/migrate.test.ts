import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createTestDatabase, dropTestDatabase } from '../test/db.ts';
import { runMigrations } from './migrate.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = path.join(repoRoot, 'migrations');

test('runMigrations creates schema_migrations, applies pending migrations once, and is idempotent', async (t) => {
  const url = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });

  t.after(async () => {
    await pool.end();
    await dropTestDatabase(url);
  });

  const first = await runMigrations(pool, migrationsDir);
  assert.ok(first.length > 0, 'expected at least one migration to be applied');
  assert.ok(first.includes('0001_core_identity'), `expected 0001_core_identity in applied versions, got ${JSON.stringify(first)}`);

  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  const names = tables.rows.map((r) => r.table_name);
  assert.ok(names.includes('schema_migrations'), 'schema_migrations table should exist');
  assert.ok(names.includes('tenants'), 'tenants table should exist after migrations');

  const second = await runMigrations(pool, migrationsDir);
  assert.deepEqual(second, [], 'second run should apply nothing');

  const recorded = await pool.query<{ version: string }>(`SELECT version FROM schema_migrations ORDER BY version`);
  assert.deepEqual(recorded.rows.map((r) => r.version), ['0001_core_identity']);
});
