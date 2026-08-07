import pg from 'pg';

let pool: pg.Pool | null = null;

/**
 * Returns the lazily-created shared pool built from process.env.DATABASE_URL.
 * Throws if DATABASE_URL is not set.
 */
export function getPool(): pg.Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  pool = new pg.Pool({ connectionString });
  return pool;
}

/** Runs a parameterized query against the shared pool. */
export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<R>> {
  return getPool().query<R>(text, params);
}

/**
 * Runs `fn` with a dedicated client inside BEGIN/COMMIT; rolls back and
 * rethrows on error. The client is always released.
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Ends the shared pool (for graceful shutdown / tests). */
export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}
