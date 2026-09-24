import { Pool } from "pg";
import { createPool, INDEXER_ADVISORY_LOCK_KEY } from "./db.js";
import { startPollLoop, type FetchEventsFn } from "./poller.js";

/**
 * Worker entry point — `npm run start:worker` runs this file.
 *
 * Single-instance guarantee:
 * --------------------------
 * The indexer is documented as "Single indexer instance" (README Known Gaps).
 * Nothing previously prevented `npm run start:worker` from being started twice
 * against the same DATABASE_URL — e.g. an overlapping rolling deploy — with
 * both workers reading the same cursor and double-folding the same page.
 *
 * Fix: acquire a Postgres advisory lock at startup. Advisory locks are
 * session-scoped, so the lock is held for the lifetime of the DB connection
 * that acquired it and is released automatically when that session ends.
 *
 * We use pg_try_advisory_lock (non-blocking) so that a second worker exits
 * cleanly with a clear log message instead of blocking forever or crash-
 * looping. The lock key is INDEXER_ADVISORY_LOCK_KEY (see db.ts). All
 * workers contending on the same DATABASE_URL contend on the same key.
 *
 * If the lock is already held, we log and exit with code 0 — this is an
 * expected situation during deploys, not an error, so the process supervisor
 * (systemd / k8s / Render) should not restart it as a crash. Exiting 0
 * avoids a crash-loop while still surfacing the condition in logs.
 */

type PoolClientWithLock = import("pg").PoolClient;

async function acquireSingletonLock(pool: Pool): Promise<PoolClientWithLock> {
  // We must keep the client that acquired the lock open for the lifetime
  // of the worker — advisory locks are released when the session ends.
  const client = await pool.connect();

  // pg_try_advisory_lock returns true if we got the lock, false if someone
  // else holds it. We use the try variant to exit cleanly instead of blocking.
  const res = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [
    INDEXER_ADVISORY_LOCK_KEY,
  ]);

  const locked = res.rows[0].locked === true;
  if (!locked) {
    client.release();
    console.log(
      `[worker] Another indexer worker already holds advisory lock ${INDEXER_ADVISORY_LOCK_KEY} — exiting cleanly (not a crash).`
    );
    // Clean exit — not an error. Prevents crash-loop in supervisors that
    // restart on non-zero exit.
    process.exit(0);
  }

  console.log(
    `[worker] Acquired advisory lock ${INDEXER_ADVISORY_LOCK_KEY} (pg_try_advisory_lock) — single-instance guard active.`
  );

  // Keep the advisory-lock connection open. We also listen for its errors
  // so that if the connection drops we exit rather than running unlocked.
  client.on("error", (err) => {
    console.error("[worker] Advisory-lock connection error, exiting:", err);
    process.exit(1);
  });

  // Also handle advisory lock release on graceful shutdown.
  const releaseAndExit = async (signal: string) => {
    console.log(`[worker] Received ${signal}, releasing advisory lock and exiting...`);
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [INDEXER_ADVISORY_LOCK_KEY]);
    } catch {
      // best-effort — the lock releases automatically when the session closes anyway
    }
    client.release();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void releaseAndExit("SIGTERM"));
  process.on("SIGINT", () => void releaseAndExit("SIGINT"));

  return client as PoolClientWithLock;
}

async function fetchEventsFromRPC(
  fromLedger: number,
  limit: number
): Promise<import("./handlers.js").RawEvent[]> {
  // Placeholder — in production this would call Horizon / Soroban RPC
  // `getEvents` with startLedger/fromLedger and pagination.
  // For local dev without a running node it returns an empty page so the
  // poller simply advances nothing and sleeps.
  //
  // Replace with:
  //   const rpc = new SorobanRpc.Server(RPC_URL);
  //   const resp = await rpc.getEvents({ startLedger: fromLedger, limit, filters: [...] });
  //   return resp.events.map(toRawEvent);
  void fromLedger;
  void limit;
  return [];
}

async function main(): Promise<void> {
  const pool = createPool();

  // Single-instance guard — must be first thing after pool creation, before
  // any cursor reads or event fetches.
  await acquireSingletonLock(pool);

  const fetchEvents: FetchEventsFn = fetchEventsFromRPC;

  console.log("[worker] Starting poll loop...");
  await startPollLoop(pool, fetchEvents, {
    intervalMs: Number(process.env.POLLER_INTERVAL_MS ?? 5000),
    limit: Number(process.env.POLLER_PAGE_LIMIT ?? 100),
  });
}

// Only run when executed directly (not when imported in tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[worker] Fatal error:", err);
    process.exit(1);
  });
}

export { acquireSingletonLock, fetchEventsFromRPC };
