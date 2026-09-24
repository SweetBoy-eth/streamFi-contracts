import { describe, it, expect } from 'vitest';
import { validateStreamPayload } from './validateStreamPayload';

const VALID_RECIPIENT = 'G'.padEnd(56, 'A');

function payload(overrides: Partial<{ recipient: string; amount: string; ratePerSecond: string }> = {}) {
  return {
    recipient: VALID_RECIPIENT,
    amount: '1000',
    ratePerSecond: '10',
    ...overrides,
  };
}

/**
 * Coverage for issue #581: StreamPayload amounts are decimal strings so
 * i128-sized values survive without Number.MAX_SAFE_INTEGER rounding, and
 * validation must compare them as BigInt — never as `number`.
 */
describe('validateStreamPayload', () => {
  it('accepts a valid payload', () => {
    const result = validateStreamPayload(payload());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a malformed recipient', () => {
    const result = validateStreamPayload(payload({ recipient: 'not-an-address' }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Stellar public address');
  });

  it.each([
    ['zero', '0'],
    ['negative', '-5'],
    ['decimal', '1.5'],
    ['exponent notation', '1e6'],
    ['empty', ''],
    ['not a number', 'abc'],
    ['leading zeros', '007'],
  ])('rejects a %s amount', (_label, amount) => {
    const result = validateStreamPayload(payload({ amount }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Amount must be a positive integer, entered as a whole number.');
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['decimal', '0.5'],
  ])('rejects a %s ratePerSecond', (_label, ratePerSecond) => {
    const result = validateStreamPayload(payload({ ratePerSecond }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Rate per second must be a positive integer, entered as a whole number.');
  });

  it('rejects a deposit that cannot cover one second of streaming', () => {
    const result = validateStreamPayload(payload({ amount: '99', ratePerSecond: '100' }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'Amount must be greater than or equal to the rate per second: the deposit has to cover at least one second of streaming.',
    );
  });

  it('accepts a deposit that exactly covers one second of streaming', () => {
    const result = validateStreamPayload(payload({ amount: '100', ratePerSecond: '100' }));
    expect(result.valid).toBe(true);
  });

  it('keeps full precision for amounts beyond Number.MAX_SAFE_INTEGER', () => {
    // 9007199254740992 = 2^53, 9007199254740993 = 2^53 + 1. As `number`
    // both round to 9007199254740992, so a number-typed check would see
    // amount >= rate and accept — even though on-chain the deposit is one
    // unit short of the rate. On BigInt the comparison is exact and the
    // payload is correctly rejected.
    const tooSmall = validateStreamPayload(
      payload({ amount: '9007199254740992', ratePerSecond: '9007199254740993' }),
    );
    expect(tooSmall.valid).toBe(false);
    expect(tooSmall.errors).toContain(
      'Amount must be greater than or equal to the rate per second: the deposit has to cover at least one second of streaming.',
    );

    // i128::MAX — far beyond any double's integer precision — validates fine.
    const i128Max = '170141183460469231731687303715884105727';
    const maxPayload = validateStreamPayload(payload({ amount: i128Max, ratePerSecond: i128Max }));
    expect(maxPayload.valid).toBe(true);
  });

  it('handles a partially-filled payload without throwing', () => {
    const result = validateStreamPayload({ recipient: VALID_RECIPIENT });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});
