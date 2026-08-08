import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { closeOpenWorkInstances } from '../../src/lib/jobs/autoCheckout.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
    const startedAt = new Date();
    const summary = await closeOpenWorkInstances(pool, startedAt);
    console.log(
      `auto-checkout: closed ${summary.closed} open work instance(s) past their scheduled end, ${summary.failed} failed (run at ${startedAt.toISOString()}).`,
    );
    if (summary.instanceIds.length > 0) {
      console.log(`auto-checkout: closed instance ids: ${summary.instanceIds.join(', ')}`);
    }
    for (const failure of summary.failures) {
      console.error(`auto-checkout: FAILED instance ${failure.instanceId}: ${failure.error}`);
    }
    // Exit non-zero only when at least one instance failed to close; a fully
    // clean run (or a run with nothing to do) exits 0.
    if (summary.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('auto-checkout failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
