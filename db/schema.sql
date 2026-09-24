-- StreamFi indexer schema
-- Applies to Postgres. Run with: psql $DATABASE_URL -f db/schema.sql

-- Raw events ingested from Horizon / Soroban RPC.
-- Each row is an immutable ledger event; derived tables fold over this log.

CREATE TABLE IF NOT EXISTS raw_events (
    id          BIGSERIAL PRIMARY KEY,
    ledger      BIGINT      NOT NULL,
    tx_hash     TEXT        NOT NULL,
    event_type  TEXT        NOT NULL,
    contract_id TEXT        NOT NULL,
    topics      JSONB,
    data        JSONB       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Prevent double-ingest of the same ledger event when poller retries a page.
    UNIQUE (ledger, tx_hash, event_type, contract_id)
);

-- Ledger scan — poller fetches "all events since cursor" ordered by ledger.
CREATE INDEX IF NOT EXISTS raw_events_ledger_idx ON raw_events (ledger);

-- Event-type filter — replay / backfill tooling ("all stream_withdrawn since X")
-- and handler routing both filter by event_type. Without this every such query
-- is a sequential scan. Cheap to add while the table is small; expensive as a
-- concurrent migration against a large production table.
CREATE INDEX IF NOT EXISTS raw_events_type_idx ON raw_events (event_type);

-- Optional composite for the common "type + ledger range" replay query.
CREATE INDEX IF NOT EXISTS raw_events_type_ledger_idx ON raw_events (event_type, ledger);

-- Cursor — single row, id = 1, tracks the last successfully folded ledger.
CREATE TABLE IF NOT EXISTS cursor (
    id          INT    PRIMARY KEY CHECK (id = 1),
    last_ledger BIGINT NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO cursor (id, last_ledger) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

-- Derived tables — folded projections over raw_events. All upserts must be
-- idempotent (INSERT ... ON CONFLICT DO UPDATE/NOTHING) so that re-folding
-- an already-applied page after a crash between ingestPage and saveCursor
-- does not double-count. See indexer/src/handlers.ts and poller.ts.

CREATE TABLE IF NOT EXISTS stream_states (
    stream_id       TEXT        PRIMARY KEY,
    sender          TEXT        NOT NULL,
    recipient       TEXT        NOT NULL,
    token           TEXT        NOT NULL,
    deposit         BIGINT      NOT NULL,
    rate_per_second BIGINT      NOT NULL,
    withdrawn       BIGINT      NOT NULL DEFAULT 0,
    paused          BOOLEAN     NOT NULL DEFAULT FALSE,
    cancelled       BOOLEAN     NOT NULL DEFAULT FALSE,
    updated_ledger  BIGINT      NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stream_withdrawals (
    id         BIGSERIAL PRIMARY KEY,
    stream_id  TEXT        NOT NULL REFERENCES stream_states(stream_id) ON DELETE CASCADE,
    ledger     BIGINT      NOT NULL,
    tx_hash    TEXT        NOT NULL,
    recipient  TEXT        NOT NULL,
    amount     BIGINT      NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (ledger, tx_hash, stream_id)
);

-- Example governance-derived tables referenced by handlers.ts.
-- Kept here so handlers.test.ts can exercise real DDL without extra setup.

CREATE TABLE IF NOT EXISTS loan_votes (
    loan_id    TEXT        NOT NULL,
    voter      TEXT        NOT NULL,
    support    BOOLEAN     NOT NULL,
    weight     BIGINT      NOT NULL,
    ledger     BIGINT      NOT NULL,
    tx_hash    TEXT        NOT NULL,
    PRIMARY KEY (loan_id, voter),
    UNIQUE (ledger, tx_hash, loan_id, voter)
);

CREATE TABLE IF NOT EXISTS treasury_votes (
    proposal_id TEXT   NOT NULL,
    voter       TEXT   NOT NULL,
    support     BOOLEAN NOT NULL,
    weight      BIGINT NOT NULL,
    ledger      BIGINT NOT NULL,
    tx_hash     TEXT   NOT NULL,
    PRIMARY KEY (proposal_id, voter),
    UNIQUE (ledger, tx_hash, proposal_id, voter)
);

CREATE TABLE IF NOT EXISTS treasury_reveals (
    proposal_id TEXT   NOT NULL,
    voter       TEXT   NOT NULL,
    vote_hash   TEXT   NOT NULL,
    ledger      BIGINT NOT NULL,
    tx_hash     TEXT   NOT NULL,
    PRIMARY KEY (proposal_id, voter),
    UNIQUE (ledger, tx_hash, proposal_id, voter)
);
