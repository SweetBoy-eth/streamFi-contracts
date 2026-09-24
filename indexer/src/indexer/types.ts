/**
 * Contract between the poller (`poller.ts`) and any `SorobanEventSource`
 * implementation (currently `SorobanEventSource` stub, later a real
 * RPC-backed `SorobanEventSource` hitting `getEvents`).
 *
 * These three types — {@link Cursor}, {@link Page}, and {@link SorobanEvent}
 * — are the entire wire surface the poller depends on. Keep them precise so
 * a real implementation doesn't have to guess.
 */

// ---------------------------------------------------------------------------
// Cursor & pagination
// ---------------------------------------------------------------------------

/**
 * Opaque pagination cursor returned by the Soroban RPC and threaded through
 * the poller. The poller is stateless across restarts except for this value
 * (persisted via the `cursor` column / file), so semantics must be exact.
 */
export interface Cursor {
  /**
   * Ledger number of the last event that was successfully folded into the
   * local projection. **Inclusive** — the event at `lastLedger` has already
   * been persisted. The next `getEvents` call must start at `lastLedger + 1`
   * when `nextToken` is `null`, otherwise the same ledger would be re-fetched
   * and duplicate events would be folded.
   *
   * On first boot (no prior cursor) the poller passes `startLedger` equal to
   * the factory's deployment ledger. Implementations must treat `lastLedger`
   * as the high-water mark, not as "next ledger to fetch".
   */
  lastLedger: number;

  /**
   * Opaque paging token for the **current** ledger range.
   *
   * - `null` means "no further pages for this range" — the poller advances
   *   `lastLedger` to the page's `lastLedger` and on the next tick queries
   *   `[lastLedger + 1, latestLedger]`.
   * - Non-null string is opaque (base64 from RPC) and must be passed verbatim
   *   as `cursor` on the next `getEvents` call **without** bumping
   *   `lastLedger`. The RPC interprets it as "continue from where the previous
   *   page left off, same ledger range".
   * - Empty string is never returned — treat it as `null` if observed.
   *
   * Page size is controlled by `limit` on the request; the server may return
   * fewer events than `limit` even when `nextToken !== null` (e.g. ledger
   * boundary). The poller must loop while `nextToken !== null` before
   * advancing the high-water mark.
   */
  nextToken: string | null;
}

/**
 * Single page returned by {@link SorobanEventSource.getEvents}.
 *
 * Pagination contract:
 * 1. `events` are ordered ascending by `(ledger, sequence)` — the poller
 *    relies on this to fold deterministically and to checkpoint `lastLedger`
 *    as `events[events.length - 1].ledger` when `nextToken === null`.
 * 2. `lastLedger` is the **inclusive** upper ledger that was scanned to
 *    produce this page (the `endLedger` the caller passed, clamped to the
 *    latest closed ledger). Example: request `startLedger=100, endLedger=200`
 *    may return `lastLedger=200` even if the last event was at 195 — 200 is
 *    still the scanned high-water mark and the next query starts at 201.
 * 3. `nextToken === null` means the range `[startLedger, lastLedger]` is
 *    fully exhausted. `nextToken !== null` means at least one more page
 *    remains for the **same** range — the caller must re-invoke with
 *    `cursor: nextToken` and the **same** `startLedger`/`endLedger`.
 * 4. An empty `events` array with `nextToken === null` is valid (no events
 *    in range) — the poller still advances `lastLedger` to avoid busy-looping
 *    the same empty range.
 */
export interface Page {
  /** Events in this page, sorted ascending by `(ledger, sequence)`. */
  events: SorobanEvent[];
  /**
   * Opaque cursor for the next page, or `null` if this was the final page
   * for the requested ledger range. See {@link Cursor.nextToken}.
   */
  nextToken: string | null;
  /**
   * Inclusive upper ledger scanned for this page. See pagination notes above.
   * Always `>= startLedger` of the request, even when `events` is empty.
   */
  lastLedger: number;
}

// ---------------------------------------------------------------------------
// Soroban events — fields shape per `ev.type`
// ---------------------------------------------------------------------------

/**
 * The `type` tag for every event the indexer folds. Maps 1:1 to the
 * `symbol_short!` topic emitted by `contracts/stream/src/events.rs` (and
 * `factory`/`governor` where noted). The poller's `fold()` switches on this
 * tag to decide which projection table / column to update.
 */
export type EventType =
  | "created"
  | "withdrawn"
  | "cancelled"
  | "force_cxl"
  | "paused"
  | "resumed"
  | "topped_up"
  | "clawback"
  | "xfer_rec"
  | "set_op"
  | "rm_op"
  | "factory_paused"
  | "factory_unpaused";

/**
 * Raw event as returned by `getEvents` before folding.
 *
 * `fields` shape depends on `type` — see the per-type tables below. All
 * numeric `i128` values arrive as **strings** (Soroban JSON-encodes `i128` as
 * decimal strings to avoid JS precision loss); `u64`/`u32` arrive as numbers
 * that fit safely in JS `number` (`<= 2^53-1` in practice for timestamps).
 *
 * ### `created` — `DripStream::created` (`stream/src/events.rs:created`)
 * Topics: `("created", sender, sequence)` — sender is the stream creator.
 * ```
 * fields: {
 *   recipient: string;        // G... Stellar address
 *   token: string;            // G... SAC address
 *   rate_per_second: string;  // i128 decimal string, > 0
 *   start_time: number;       // u64 unix seconds
 *   end_time: number;         // u64 unix seconds, 0 = open-ended
 *   sequence: number;         // u64 — monotonic per-stream event seq
 * }
 * ```
 *
 * ### `withdrawn` — `DripStream::withdrawn`
 * Topics: `("withdrawn", recipient, sequence)`
 * ```
 * fields: {
 *   amount: string;          // i128 decimal string, > 0
 *   total_withdrawn: string; // i128 decimal string, cumulative
 *   remaining: string;       // i128 decimal string, vault remainder
 *   sequence: number;
 * }
 * ```
 *
 * ### `cancelled` — `DripStream::cancelled` (sender/operator via `cancel`)
 * Topics: `("cancelled", sender, sequence)`
 * ```
 * fields: {
 *   refund_amount: string;    // i128 — returned to sender
 *   withdrawn_so_far: string; // i128 — already withdrawn by recipient
 *   sequence: number;
 * }
 * ```
 *
 * ### `force_cxl` — `DripStream::force_cancelled` (recipient-only, 30d after pause)
 * Same fields as `cancelled` but distinct `type` so consumers don't need to
 * correlate the transaction signer to tell sender-cancel apart from
 * recipient force-cancel.
 * ```
 * fields: { refund_amount: string; withdrawn_so_far: string; sequence: number; }
 * ```
 *
 * ### `paused` — `DripStream::paused`
 * Topics: `("paused", sender, sequence)`
 * ```
 * fields: {
 *   paused_at: number;   // u64 ledger timestamp
 *   withdrawable: string; // i128 — amount that was withdrawable at pause time
 *   sequence: number;
 * }
 * ```
 *
 * ### `resumed` — `DripStream::resumed`
 * Topics: `("resumed", sender, sequence)`
 * ```
 * fields: { resumed_at: number; sequence: number; }
 * ```
 *
 * ### `topped_up` — `DripStream::topped_up`
 * Topics: `("topped_up", sender, sequence)`
 * ```
 * fields: { amount: string; new_balance: string; sequence: number; }
 * ```
 *
 * ### `clawback` — `DripStream::clawback`
 * Topics: `("clawback", sender, sequence)`
 * ```
 * fields: { amount: string; sequence: number; }
 * ```
 *
 * ### `xfer_rec` — `DripStream::recipient_transferred`
 * Topics: `("xfer_rec", old_recipient, sequence)` — old recipient in topic,
 * new recipient in data (sole data field).
 * ```
 * fields: { new_recipient: string; sequence: number; }
 * ```
 *
 * ### `set_op` — `DripStream::operator_set`
 * Topics: `("set_op", sender, sequence)`
 * ```
 * fields: { operator: string; sequence: number; }
 * ```
 *
 * ### `rm_op` — `DripStream::operator_revoked`
 * Topics: `("rm_op", sender)` — note: sequence is the **data**, not a topic
 * (see `stream/src/events.rs:operator_revoked`). Fold must handle both.
 * ```
 * fields: { sequence: number; }
 * ```
 *
 * ### `factory_paused` / `factory_unpaused` — `DripFactory::pause` / `unpause`
 * Topics: `("paused", governor)` / `("unpaused", governor)` — no sequence.
 * ```
 * fields: { at: number; } // paused_at / resumed_at ledger timestamp
 * ```
 */
export interface SorobanEvent {
  /** Ledger in which this event was emitted (u32, closed ledger). */
  ledger: number;
  /** Unix timestamp of the ledger (u64 seconds). */
  timestamp: number;
  /** Contract ID that emitted the event (C... or G... strkey). */
  contractId: string;
  /** Transaction hash that included the event (hex). */
  txHash: string;
  /** Event type tag — discriminant for `fields` shape (see tables above). */
  type: EventType;
  /**
   * Event data payload. Shape is determined by `type` — see the per-type
   * documentation on {@link SorobanEvent}. Consumers must narrow on `type`
   * before accessing type-specific keys; unknown `type` values should be
   * logged and skipped (forward-compatible).
   */
  fields: Record<string, unknown>;
  /** Monotonic per-stream sequence if the contract emitted one, else null. */
  sequence: number | null;
}

/**
 * Fold input for `applyEvent` (`handlers.ts`).
 *
 * Deliberately looser than {@link SorobanEvent}: the DAO-voting folds (loan /
 * treasury proposals) key off a free-form `type` tag plus an untyped `fields`
 * payload rather than the fixed per-type shapes documented above. The
 * optional context fields (`ledger`, `contractId`, `txHash`) are attached to
 * the structured warn line `applyEvent` emits when it drops an event type it
 * doesn't recognise (issue #578), so an unrecognized type can be traced back
 * to the exact transaction that produced it.
 */
export interface ChainEvent {
  /** Event type tag — matched by `applyEvent`'s switch. */
  type: string;
  /** Type-specific payload. Shape depends on {@link ChainEvent.type}. */
  fields: Record<string, unknown>;
  /** Ledger the event was emitted in, when known. */
  ledger?: number;
  /** Contract that emitted the event, when known. */
  contractId?: string;
  /** Transaction hash, when known. */
  txHash?: string;
}

// ---------------------------------------------------------------------------
// Event source contract
// ---------------------------------------------------------------------------

/**
 * Parameters for a single `getEvents` RPC page fetch.
 */
export interface GetEventsParams {
  /**
   * Inclusive start ledger for the scan. On the initial poll this is the
   * factory deployment ledger; on subsequent polls it is `cursor.lastLedger + 1`
   * when `cursor.nextToken === null`, or the same `startLedger` as the
   * previous page when continuing via `nextToken`.
   */
  startLedger: number;
  /**
   * Inclusive end ledger — clamped to the latest closed ledger by the server.
   * If omitted the server scans to the latest ledger. `lastLedger` in the
   * response echoes the effective `endLedger` that was scanned (see {@link Page}).
   */
  endLedger?: number;
  /**
   * Opaque paging cursor from the previous {@link Page.nextToken}. Pass `null`
   * or omit for the first page of a range. When non-null, `startLedger` and
   * `endLedger` must be the same as the call that produced the token.
   */
  cursor?: string | null;
  /**
   * Maximum events to return in this page. Server may return fewer. Defaults
   * to 100 if omitted (matches `query::MAX_PAGE_SIZE` on-chain). Capped
   * server-side; the poller never requests more than 100.
   */
  limit?: number;
}

/**
 * The interface the poller depends on. The current `SorobanEventSource` stub
 * implements this with an empty page; a real implementation will call
 * `soroban-rpc` `getEvents` and map its JSON to {@link Page}.
 *
 * Implementors must honour the pagination semantics documented on
 * {@link Page} and {@link Cursor}:
 * - `nextToken` is opaque and must round-trip verbatim.
 * - `lastLedger` is **inclusive** and represents the scanned high-water mark.
 * - `events` are sorted ascending by `(ledger, sequence)`.
 */
export interface SorobanEventSource {
  /**
   * Fetch one page of events for the given ledger range and cursor.
   *
   * Must throw only on transport / RPC errors (network failure, 5xx). An
   * empty range is not an error — return `{ events: [], nextToken: null,
   * lastLedger: endLedger }` instead. The poller's retry loop distinguishes
   * thrown errors (retry with backoff, increment fold failure counter) from
   * empty pages (advance cursor).
   */
  getEvents(params: GetEventsParams): Promise<Page>;
}
