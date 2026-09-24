import { Pool, PoolClient } from "pg";

/**
 * Shared Postgres pool for the indexer worker and tests.
 *
 * DATABASE_URL must be set (e.g. postgres://user:pass@localhost:5432/streamfi).
 */
export function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  return new Pool({ connectionString });
}

/**
 * Advisory-lock key for the indexer worker.
 * Picked as an arbitrary 32-bit integer; must be stable across deploys so that
 * two workers contend on the same lock. We use the lower 32 bits namespace 0
 * via pg_try_advisory_lock(int) / pg_advisory_lock(int).
 *
 * Choosing a distinct key per environment (e.g. via env var) would allow
 * separate staging/production DBs that share a Postgres cluster to run
 * independent workers. For this deploy we keep a single constant and document
 * that colliding DATABASE_URLs contend — see worker.ts.
 */
export const INDEXER_ADVISORY_LOCK_KEY = 0x5f7a7c3b; // 1602471227 decimal

/**
 * Try to acquire the indexer advisory lock without blocking.
 * Returns true if acquired, false if another worker already holds it.
 * Caller must hold the returned client until it releases the lock (or
 * disconnects). Prefer keeping the session/connection that acquired the lock
 * open for the lifetime of the worker — advisory locks are session-scoped.
 */
export async function tryAcquireAdvisoryLock(
  client: PoolClient,
  key: number = INDEXER_ADVISORY_LOCK_KEY
): Promise<boolean> {
  const res = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [
    key,
  ]);
  return res.rows[0].locked === true;
}

/**
 * Blocking variant — kept for completeness. Worker startup uses the try
 * variant so it can exit cleanly instead of blocking forever.
 */
export async function acquireAdvisoryLockBlocking(
  client: PoolClient,
  key: number = INDEXER_ADVISORY_LOCK_KEY
): Promise<void> {
  await client.query("SELECT pg_advisory_lock($1)", [key]);
}

export async function releaseAdvisoryLock(
  client: PoolClient,
  key: number = INDEXER_ADVISORY_LOCK_KEY
): Promise<void> {
  await client.query("SELECT pg_advisory_unlock($1)", [key]);
}
