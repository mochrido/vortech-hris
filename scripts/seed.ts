import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runMigrations } from '../src/lib/db/migrate.ts';
import { runSeed } from '../src/lib/seed/seed.ts';

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
  if (!process.env.TOTP_ENCRYPTION_KEY) {
    throw new Error('TOTP_ENCRYPTION_KEY is not set (checked environment and .env)');
  }

  const pool = new pg.Pool({ connectionString });
  try {
    // Ensure the schema is current before seeding.
    const applied = await runMigrations(pool, path.join(repoRoot, 'migrations'));
    if (applied.length > 0) {
      console.log(`Applied ${applied.length} pending migration(s): ${applied.join(', ')}`);
    }

    const summary = await runSeed(pool);
    console.log('Seed complete:');
    console.log(`  superadmin:        ${summary.superadminEmail} (TOTP enrolled)`);
    console.log(`  demo tenant:       ${summary.tenantSlug} (plan trial, 25 users)`);
    console.log(`  demo users:        admin / manager / member @vortech-demo.local`);
    console.log(`  locations:         ${summary.locationsCreated}`);
    console.log(`  schedules:         ${summary.schedulesCreated}`);
    console.log(`  holidays inserted: ${summary.holidaysInserted} (2026-2027 national)`);
    console.log('Seed is idempotent; re-running adds no duplicates.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
