import type { PoolClient } from 'pg'
import type { ChainEvent } from './types.js'

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value)
}

/**
 * Folds a single decoded event into the derived tables.
 *
 * NOTE: these folds are additive (increments), not idempotent upserts. Re-delivering an
 * already-applied event double-counts it. That's a known gap tracked separately — see
 * "Non-idempotent derived-table folds" in the top-level README — and is intentionally not
 * fixed as part of this scaffold.
 */
export async function applyEvent(client: PoolClient, ev: ChainEvent): Promise<void> {
  switch (ev.type) {
    case 'loan_vote':
      return loan_vote(client, ev)
    case 'treasury_vote':
      return treasury_vote(client, ev)
    case 'treasury_reveal':
      return treasury_reveal(client, ev)
    default:
      // Log (don't throw) on anything we don't recognise: today that's every
      // event type except the three DAO-voting folds above. Once real
      // DripStream/DripFactory handlers land here, a future contract upgrade
      // that adds a new event type must show up in the logs instead of
      // disappearing into this indexer silently (issue #578).
      console.error(
        JSON.stringify({
          level: 'warn',
          msg: 'applyEvent: unrecognized event type, dropping',
          type: ev.type,
          ledger: ev.ledger,
          contractId: ev.contractId,
          txHash: ev.txHash,
        }),
      )
      return
  }
}

async function loan_vote(client: PoolClient, ev: ChainEvent): Promise<void> {
  const f = ev.fields
  const column = f.support === true ? 'votes_for' : 'votes_against'
  await client.query(
    `INSERT INTO loan_proposals (id, ${column})
     VALUES ($1, 1)
     ON CONFLICT (id) DO UPDATE
       SET ${column} = loan_proposals.${column} + 1,
           updated_at = now()`,
    [num(f.proposal_id)],
  )
}

async function treasury_vote(client: PoolClient, ev: ChainEvent): Promise<void> {
  const f = ev.fields
  const column = f.support === true ? 'votes_for' : 'votes_against'
  await client.query(
    `INSERT INTO treasury_proposals (id, ${column})
     VALUES ($1, 1)
     ON CONFLICT (id) DO UPDATE
       SET ${column} = treasury_proposals.${column} + 1,
           updated_at = now()`,
    [num(f.proposal_id)],
  )
}

async function treasury_reveal(client: PoolClient, ev: ChainEvent): Promise<void> {
  const f = ev.fields
  await client.query(
    `INSERT INTO treasury_proposals (id, revealed)
     VALUES ($1, 1)
     ON CONFLICT (id) DO UPDATE
       SET revealed = treasury_proposals.revealed + 1,
           updated_at = now()`,
    [num(f.proposal_id)],
  )
}
