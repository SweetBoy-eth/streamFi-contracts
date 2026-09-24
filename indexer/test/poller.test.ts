import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getCursor, saveCursor, ingestPage, pollOnce } from "../src/poller.js";
import type { RawEvent } from "../src/handlers.js";

// ---------------------------------------------------------------------------
// Helpers: mocked PoolClient / Pool that records queries and simulates
// minimal Postgres behaviour needed for poller tests.
// ---------------------------------------------------------------------------

function mockClient(overrides: Partial<PoolClient> = {}): PoolClient & { queries: string[] } {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push(sql);
      // Simulate cursor table
      if (sql.includes("SELECT last_ledger FROM cursor")) {
        return { rows: [{ last_ledger: 42 }], rowCount: 1 } as never;
      }
      if (sql.includes("SELECT pg_try_advisory_lock")) {
        return { rows: [{ locked: true }], rowCount: 1 } as never;
      }
      // BEGIN/COMMIT/ROLLBACK etc
      return { rows: [], rowCount: 0 } as never;
    }),
    release: vi.fn(),
    on: vi.fn(),
    // @ts-expect-error partial mock
    queries,
    ...overrides,
  } as unknown as PoolClient & { queries: string[] };
  return client;
}

function mockPool(client: PoolClient): Pool {
  return {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
}

const sampleEvent = (overrides: Partial<RawEvent> = {}): RawEvent => ({
  ledger: 100,
  txHash: "abc123",
  eventType: "stream_withdrawn",
  contractId: "CA3D...",
  topics: ["stream_withdrawn", "G..."],
  data: {
    stream_id: "1",
    recipient: "GRECIPIENT",
    amount: "1000",
    sender: "GSENDER",
    token: "GTOKEN",
    deposit: "100000",
    rate_per_second: "10",
  },
  ...overrides,
});

describe("poller", () => {
  let client: ReturnType<typeof mockClient>;

  beforeEach(() => {
    client = mockClient();
    vi.clearAllMocks();
  });

  describe("getCursor", () => {
    it("returns last_ledger from cursor table", async () => {
      const cursor = await getCursor(client);
      expect(cursor).toBe(42);
      expect(client.query).toHaveBeenCalledWith(
        expect.stringContaining("SELECT last_ledger FROM cursor")
      );
    });

    it("returns 0 when cursor row missing", async () => {
      client.query = vi.fn(async () => ({ rows: [], rowCount: 0 } as never));
      const cursor = await getCursor(client);
      expect(cursor).toBe(0);
    });
  });

  describe("saveCursor", () => {
    it("upserts cursor with GREATEST guard (idempotent)", async () => {
      await saveCursor(client, 99);
      const sql = (client.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(sql).toContain("INSERT INTO cursor");
      expect(sql).toContain("ON CONFLICT (id) DO UPDATE");
      expect(sql).toContain("GREATEST");
    });

    it("requires a PoolClient (transactional) — signature enforces same-tx usage", async () => {
      // This is a compile-time guarantee; at runtime we just verify it uses
      // the passed client rather than acquiring a new one.
      await saveCursor(client, 100);
      expect(client.query).toHaveBeenCalledTimes(1);
      // No pool.connect inside saveCursor — it must be called within the
      // caller's BEGIN/COMMIT block. See pollOnce for the correct pattern.
    });
  });

  describe("ingestPage", () => {
    it("inserts raw_events and folds each event", async () => {
      const events = [sampleEvent({ ledger: 101 }), sampleEvent({ ledger: 102, txHash: "def456" })];
      await ingestPage(client, events);
      const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls;
      // Each event triggers at least 2 queries: raw_events insert + handler upsert
      expect(calls.length).toBeGreaterThanOrEqual(4);
      const allSql = calls.map((c) => c[0] as string).join("\n");
      expect(allSql).toContain("INSERT INTO raw_events");
      expect(allSql).toContain("ON CONFLICT (ledger, tx_hash, event_type, contract_id) DO NOTHING");
    });

    it("is idempotent — duplicate page does not error", async () => {
      const events = [sampleEvent()];
      await ingestPage(client, events);
      // Re-ingest same page — ON CONFLICT DO NOTHING keeps it safe
      await expect(ingestPage(client, events)).resolves.not.toThrow();
    });
  });

  describe("pollOnce — transactional cursor atomicity (the gap fix)", () => {
    it("wraps ingestPage + saveCursor in a single transaction (BEGIN/COMMIT)", async () => {
      const events = [sampleEvent({ ledger: 50, txHash: "tx1" })];
      const fetchEvents = vi.fn(async () => events);
      const pool = mockPool(client);

      // Make getCursor return 42, so fromLedger = 42, nextLedger = 50
      client.query = vi.fn(async (sql: string) => {
        if (sql.includes("SELECT last_ledger")) return { rows: [{ last_ledger: 42 }], rowCount: 1 } as never;
        return { rows: [], rowCount: 0 } as never;
      }) as never;

      const result = await pollOnce(pool, fetchEvents, 100);
      expect(result.fetched).toBe(1);
      expect(result.nextLedger).toBe(50);

      const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
      // Must be: BEGIN -> ingestPage queries -> saveCursor -> COMMIT
      // Previously poller did ingestPage(pool) + saveCursor(pool) as two
      // separate commits, leaving a crash window. Now both are inside one tx.
      const beginIdx = calls.findIndex((s) => s === "BEGIN");
      const commitIdx = calls.findIndex((s) => s === "COMMIT");
      const saveCursorIdx = calls.findIndex((s) => s.includes("INSERT INTO cursor"));
      expect(beginIdx).toBeGreaterThanOrEqual(0);
      expect(commitIdx).toBeGreaterThan(beginIdx);
      expect(saveCursorIdx).toBeGreaterThan(beginIdx);
      expect(saveCursorIdx).toBeLessThan(commitIdx);
    });

    it("rolls back on ingest failure (no partial cursor advance)", async () => {
      const events = [sampleEvent({ ledger: 51 })];
      const fetchEvents = vi.fn(async () => events);
      const pool = mockPool(client);

      client.query = vi.fn(async (sql: string) => {
        if (sql.includes("SELECT last_ledger")) return { rows: [{ last_ledger: 50 }], rowCount: 1 } as never;
        if (sql.includes("INSERT INTO raw_events")) throw new Error("inject fault");
        return { rows: [], rowCount: 0 } as never;
      }) as never;

      await expect(pollOnce(pool, fetchEvents)).rejects.toThrow("inject fault");
      const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
      expect(calls).toContain("ROLLBACK");
      expect(calls).not.toContain("COMMIT");
    });

    it("does not advance cursor when no events fetched", async () => {
      const fetchEvents = vi.fn(async () => []);
      const pool = mockPool(client);
      client.query = vi.fn(async (sql: string) => {
        if (sql.includes("SELECT last_ledger")) return { rows: [{ last_ledger: 10 }], rowCount: 1 } as never;
        return { rows: [], rowCount: 0 } as never;
      }) as never;

      const result = await pollOnce(pool, fetchEvents);
      expect(result.fetched).toBe(0);
      expect(result.nextLedger).toBeNull();
      const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
      expect(calls).not.toContain("BEGIN");
      expect(calls).not.toContain("COMMIT");
    });

    it("uses GREATEST in saveCursor so out-of-order delivery does not rewind", async () => {
      await saveCursor(client, 100);
      await saveCursor(client, 90);
      // Both calls generate the same idempotent SQL — the DB's GREATEST
      // ensures 90 does not overwrite 100.
      const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0]).toContain("GREATEST");
      expect(calls[1][0]).toContain("GREATEST");
    });
  });
});
