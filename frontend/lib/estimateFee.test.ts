import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { STREAM_OPERATIONS } from './estimateFee';

/**
 * Drift guard for issue #579: the frontend's StreamOperation list and
 * DripFactory's Rust StreamOperation enum were allowed to diverge (13 vs 5),
 * so eight operations mapped to discriminants the factory had never heard of.
 * Both extensions were made together; this test parses the Rust source and
 * fails if the two enum definitions ever disagree again — on names, on order,
 * or on cardinality.
 */
function rustStreamOperationVariants(): string[] {
  // Note: `new URL(relative, import.meta.url)` would be rewritten by Vite
  // into an http://localhost asset URL, which node:fs refuses to read —
  // resolve from the file path of this module instead.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const storageRs = readFileSync(path.resolve(here, '../../contracts/factory/src/storage.rs'), 'utf8');

  const enumBody = storageRs.match(/pub enum StreamOperation \{([\s\S]*?)\n\}/)?.[1];
  expect(enumBody, 'StreamOperation enum not found in contracts/factory/src/storage.rs').toBeTruthy();

  // Variant lines are exactly four spaces of indent, an identifier, and a
  // comma. Doc comments start with `///` after the same indent, so they can
  // never match \w at that position.
  return [...enumBody!.matchAll(/^ {4}(\w+),\s*$/gm)].map((m) => m[1]);
}

describe('StreamOperation enum parity', () => {
  it('parses a non-trivial variant list out of the Rust enum', () => {
    const rustVariants = rustStreamOperationVariants();
    expect(rustVariants.length).toBeGreaterThanOrEqual(5);
    expect(rustVariants.slice(0, 5)).toEqual([
      'CreateStream',
      'CancelStream',
      'Withdraw',
      'PauseStream',
      'ResumeStream',
    ]);
  });

  it('frontend STREAM_OPERATIONS and DripFactory StreamOperation list the same variants in the same order', () => {
    expect([...STREAM_OPERATIONS]).toEqual(rustStreamOperationVariants());
  });

  it('covers the eight DripStream operations that were missing from the factory enum', () => {
    // These are the operations issue #579 found mapped 5..12 with no on-chain
    // counterpart. If either side drops one, the parity test above fails too;
    // this test names the regression explicitly.
    const rustVariants = rustStreamOperationVariants();
    for (const op of [
      'SetOperator',
      'RevokeOperator',
      'ExtendDuration',
      'TopUp',
      'TopUpAndExtend',
      'Clawback',
      'ForceCancel',
      'TransferRecipient',
    ]) {
      expect(rustVariants).toContain(op);
      expect([...STREAM_OPERATIONS]).toContain(op);
    }
  });
});
