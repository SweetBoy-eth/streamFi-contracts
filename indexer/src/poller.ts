import type { Pool, PoolClient } from "pg";
import { foldEvent, type RawEvent } from "./handlers.js";

/**
 * Poller — fetches ledger events since the DB cursor and folds them into
 * derived tables.
 *
 * Crash-safety fix (this batch):
 * ------------------------------
 * Previously the poller did:
 *
 *   await ingestPage(pool, events);   // commits folds + raw_events
 *   await saveCursor(pool, nextLedger); // separate commit
 *
 * A crash between those two steps left the derived tables ahead of the
 * cursor. On restart the same page was re-fetched and re-folded, double-
 * counting unless every handler is idempotent. Idempotent upserts close half
 * the gap, but the correct fix is to make the cursor advance atomically with
 * the page it describes.
 *
 * Now both happen inside a single Postgres transaction:
 *
 *   BEGIN;
 *   ingestPage(client, events);  // raw_events inserts + foldEvent calls
 *   saveCursor(client, nextLedger);
 *   COMMIT;
 *
 * If the process crashes before COMMIT, the whole page rolls back and will
 * be re-fetched cleanly on the next run. If COMMIT succeeds, cursor and
 * folds are in sync. No separate timing fix is needed beyond this.
 *
 * Alternative considered: making saveCursor idempotent / compare-and-swap
 * without a transaction. Rejected — it still leaves a window where folds
 * are committed but the cursor isn't, and relies on every future handler
 * being idempotent. The transactional approach is strictly stronger and
 * costs one extra round-trip (the BEGIN/COMMIT) per page, which is
 * negligible next to the Horizon/RPC fetch.
 */

export async function getCursor(client: PoolClient): Promise<number> {
  const res = await client.query("SELECT last_ledger FROM cursor WHERE id = 1");
  if (res.rows.length === 0) return 0;
  return Number(res.rows[0].last_ledger);
}

/**
 * Save the cursor inside the caller's transaction.
 * MUST be called with the same PoolClient that ran ingestPage, within the
 * same BEGIN/COMMIT block. Passing a Pool and doing an implicit separate
 * transaction reintroduces the split-commit bug — hence the PoolClient
 * signature.
 */
export async function saveCursor(
  client: PoolClient,
  ledger: number
): Promise<void> {
  await client.query(
    `INSERT INTO cursor (id, last_ledger, updated_at)
     VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE
       SET last_ledger = GREATEST(cursor.last_ledger, EXCLUDED.last_ledger),
           updated_at = NOW()`,
    [ledger]
  );
}

export async function ingestPage(
  client: PoolClient,
  events: RawEvent[]
): Promise<void> {
  for (const ev of events) {
    // Persist raw event idempotently — UNIQUE (ledger, tx_hash, event_type, contract_id)
    await client.query(
      `INSERT INTO raw_events (ledger, tx_hash, event_type, contract_id, topics, data)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       ON CONFLICT (ledger, tx_hash, event_type, contract_id) DO NOTHING`,
      [
        ev.ledger,
        ev.txHash,
        ev.eventType,
        ev.contractId,
        JSON.stringify(ev.topics ?? null),
        JSON.stringify(ev.data),
      ]
    );

    // Fold into derived tables (idempotent upserts — see handlers.ts).
    await foldEvent(client, ev);
  }
}

/**
 * Fetch events from the upstream ledger source.
 * In production this calls Horizon / Soroban RPC. Tests inject a mock.
 */
export type FetchEventsFn = (
  fromLedger: number,
  limit: number
) => Promise<RawEvent[]>;

export async function pollOnce(
  pool: Pool,
  fetchEvents: FetchEventsFn,
  limit = 100
): Promise<{ fetched: number; nextLedger: number | null }> {
  // Read cursor outside the ingest transaction (it's just the start point).
  const cursorClient = await pool.connect();
  let fromLedger: number;
  try {
    fromLedger = await getCursor(cursorClient);
  } finally {
    cursorClient.release();
  }

  const events = await fetchEvents(fromLedger + 1, limit);
  if (events.length === 0) {
    return { fetched: 0, nextLedger: null };
  }

  const nextLedger = Math.max(...events.map((e) => e.ledger));

  // Atomic ingest + cursor advance — the core fix of this file.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ingestPage(client, events);
    await saveCursor(client, nextLedger);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { fetched: events.length, nextLedger };
}

/**
 * Long-running poll loop used by the worker. Polls every `intervalMs`
 * until the process is terminated (SIGTERM/SIGINT). Each iteration is
 * independently transactional via pollOnce.
 */
export async function startPollLoop(
  pool: Pool,
  fetchEvents: FetchEventsFn,
  opts: { intervalMs?: number; limit?: number } = {}
): Promise<never> {
  const intervalMs = opts.intervalMs ?? 5_000;
  const limit = opts.limit ?? 100;

  while (true) {
    try {
      const { fetched } = await pollOnce(pool, fetchEvents, limit);
      if (fetched === 0) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    } catch (err) {
      console.error("[poller] pollOnce failed:", err);
      // Back off briefly before retrying — avoids tight crash-loop if the
      // DB or upstream is down.
      await new Promise((r) => setTimeout(r, Math.min(intervalMs, 2000)));
    }
  }
}
