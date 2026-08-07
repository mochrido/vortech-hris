import { promises as fs } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';

const MIGRATION_FILE = /^(\d{4}_.+)\.sql$/;

/**
 * Applies pending SQL migrations from `migrationsDir` against `pool`.
 *
 * - Ensures the `schema_migrations(version TEXT PRIMARY KEY, applied_at
 *   timestamptz NOT NULL DEFAULT now())` bookkeeping table exists.
 * - Reads `*.sql` files sorted by filename; each file's version is its
 *   basename without the `.sql` extension.
 * - Applies each pending migration inside its own transaction and records
 *   the version atomically with the migration itself.
 * - Idempotent: already-applied versions are skipped.
 *
 * Returns the versions newly applied by this run, in application order.
 */
export async function runMigrations(pool: pg.Pool, migrationsDir: string): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const entries = await fs.readdir(migrationsDir);
  const files = entries
    .filter((name) => MIGRATION_FILE.test(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const applied = await pool.query<{ version: string }>('SELECT version FROM schema_migrations');
  const appliedSet = new Set(applied.rows.map((row) => row.version));

  const newlyApplied: string[] = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (appliedSet.has(version)) continue;

    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    newlyApplied.push(version);
  }

  return newlyApplied;
}
