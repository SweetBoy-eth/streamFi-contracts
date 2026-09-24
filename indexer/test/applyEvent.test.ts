import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PoolClient } from "pg";
import { applyEvent } from "../src/indexer/handlers.js";
import type { ChainEvent } from "../src/indexer/types.js";

function mockClient(): PoolClient {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
  } as unknown as PoolClient;
}

function ev(partial: Partial<ChainEvent> & Pick<ChainEvent, "type">): ChainEvent {
  return { fields: {}, ...partial };
}

/**
 * Regression coverage for issue #578: applyEvent's `default` branch used to
 * `return` without any log line, so an event type the fold didn't know about
 * (anything other than loan_vote / treasury_vote / treasury_reveal) vanished
 * without a trace. The default must log — not throw — and must not write to
 * the DB.
 */
describe("applyEvent", () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function lastLogLine(): Record<string, unknown> {
    expect(logged.length).toBeGreaterThan(0);
    return JSON.parse(logged[logged.length - 1]);
  }

  it("folds the three DAO-voting event types without logging", async () => {
    const client = mockClient();

    await applyEvent(client, ev({ type: "loan_vote", fields: { proposal_id: 1, support: true } }));
    await applyEvent(client, ev({ type: "treasury_vote", fields: { proposal_id: 2, support: false } }));
    await applyEvent(client, ev({ type: "treasury_reveal", fields: { proposal_id: 3 } }));

    expect(client.query).toHaveBeenCalledTimes(3);
    expect(logged).toHaveLength(0);
  });

  it("logs a warn-level structured line for an unrecognized event type instead of dropping silently", async () => {
    const client = mockClient();

    await applyEvent(
      client,
      ev({ type: "dripstream_created", ledger: 123, contractId: "CABC", txHash: "deadbeef" }),
    );

    // No throw, no DB write — only the log line.
    expect(client.query).not.toHaveBeenCalled();
    expect(logged).toHaveLength(1);

    const line = lastLogLine();
    expect(line.level).toBe("warn");
    expect(line.msg).toContain("unrecognized event type");
    expect(line.type).toBe("dripstream_created");
    expect(line.ledger).toBe(123);
    expect(line.contractId).toBe("CABC");
    expect(line.txHash).toBe("deadbeef");
  });

  it("resolves without throwing even when the event carries no context fields", async () => {
    const client = mockClient();

    await expect(applyEvent(client, ev({ type: "totally_new_event" }))).resolves.toBeUndefined();

    expect(logged).toHaveLength(1);
    const line = lastLogLine();
    expect(line.type).toBe("totally_new_event");
    expect(line.ledger).toBeUndefined();
  });
});
