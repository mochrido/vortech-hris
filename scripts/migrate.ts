import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runMigrations } from '../src/lib/db/migrate.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

async function main(): Promise<void> {
  loadEnvFile(path.join(repoRoot, '.env'));

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set (checked environment and .env)');
  }

  const pool = new pg.Pool({ connectionString });
  try {
    const applied = await runMigrations(pool, path.join(repoRoot, 'migrations'));
    if (applied.length === 0) {
      console.log('No pending migrations.');
    } else {
      for (const version of applied) {
        console.log(`Applied migration: ${version}`);
      }
      console.log(`Applied ${applied.length} migration(s).`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
