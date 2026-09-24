/**
 * Payload for creating a stream.
 *
 * `amount` and `ratePerSecond` are i128 token amounts (base units) carried as
 * decimal strings rather than `number`: the contracts use `i128` precisely to
 * avoid precision loss (docs/security.md, Arithmetic), and a JS `number`
 * silently rounds any value beyond `Number.MAX_SAFE_INTEGER` — well inside
 * i128's range. Strings match how streamFi-sdk represents the same values
 * (`StreamConfig.ratePerSecond`, `xdr.Int128.fromString(amount)`, …), so the
 * full precision survives validation, UI state, and submission.
 */
export interface StreamPayload {
  recipient: string;
  /** Positive integer in token base units, decimal string (i128). */
  amount: string;
  /** Positive integer in token base units per second, decimal string (i128). */
  ratePerSecond: string;
}

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
/** Canonical positive integer: no sign, no decimal point, no exponent, no leading zeros. */
const POSITIVE_INT_RE = /^[1-9]\d*$/;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Parses a field as a positive integer decimal string via BigInt, so the
 * comparison below never leaves the arbitrary-precision domain.
 * Returns `null` when the value is missing or not a canonical positive
 * integer (the caller turns that into the user-facing error).
 */
function parsePositiveInt(value: string | undefined): bigint | null {
  if (value === undefined || !POSITIVE_INT_RE.test(value)) {
    return null;
  }
  return BigInt(value);
}

export function validateStreamPayload(payload: Partial<StreamPayload>): ValidationResult {
  const errors: string[] = [];

  if (!payload.recipient || !STELLAR_ADDRESS_RE.test(payload.recipient)) {
    errors.push('Recipient must be a valid Stellar public address (starts with G, 56 characters).');
  }

  const amount = parsePositiveInt(payload.amount);
  if (amount === null) {
    errors.push('Amount must be a positive integer, entered as a whole number.');
  }

  const ratePerSecond = parsePositiveInt(payload.ratePerSecond);
  if (ratePerSecond === null) {
    errors.push('Rate per second must be a positive integer, entered as a whole number.');
  }

  // `create_stream` requires `deposit >= rate_per_sec`, so the two independent
  // positivity checks above are not enough: a payload can satisfy both and
  // still revert on-chain with `InsufficientDeposit`. Cross-check the
  // relationship the factory enforces so pre-submission validation actually
  // predicts the on-chain outcome.
  //
  // This only runs when both fields are individually valid — otherwise the
  // caller already gets the specific "must be a positive integer" error and a
  // second derived complaint would just be noise. The comparison happens on
  // BigInt, so amounts past Number.MAX_SAFE_INTEGER are ordered exactly —
  // `Number()` rounding here would reintroduce the precision bug this type
  // exists to prevent. If `endTime` is ever added to `StreamPayload`, the
  // full-duration check (`amount >= ratePerSecond * (endTime - startTime)`)
  // belongs here as well.
  if (amount !== null && ratePerSecond !== null && amount < ratePerSecond) {
    errors.push(
      'Amount must be greater than or equal to the rate per second: the deposit has to cover at least one second of streaming.',
    );
  }

  return { valid: errors.length === 0, errors };
}
