import type pg from 'pg';

/**
 * Minimal queryable surface shared by pg.Pool, pg.Client and pg.PoolClient.
 * Attendance/schedule helpers accept this so callers can hand over a pool
 * (opens its own transaction where needed) or an already-transactional client.
 */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}
