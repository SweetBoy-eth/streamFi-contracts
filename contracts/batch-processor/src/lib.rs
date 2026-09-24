#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, token, Address, Env, Vec};

/// Maximum number of transfers permitted in a single batch.
const MAX_BATCH_SIZE: u32 = 100;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `recipients` and `amounts` have different lengths.
    LengthMismatch = 1,
    /// The batch exceeds [`MAX_BATCH_SIZE`].
    BatchTooLarge = 2,
    /// An individual amount is zero or negative.
    InvalidAmount = 3,
    /// Integer overflow computing the total to pull from the funder.
    ArithmeticOverflow = 4,
}

#[contract]
pub struct BatchTransferProcessor;

#[contractimpl]
impl BatchTransferProcessor {
    /// Transfer tokens from `funder` to each address in `recipients`.
    ///
    /// # Auth
    /// `funder.require_auth()` is called before any state mutation.  The funder
    /// must have pre-authorised a transfer of at least `sum(amounts)` tokens to
    /// this contract, which then fans the funds out to the recipients in order.
    ///
    /// # Validation (all checks precede any token movement)
    /// - `recipients` and `amounts` must have the same length.
    /// - The batch must not exceed `MAX_BATCH_SIZE` (100 entries).
    /// - Every individual `amount` must be > 0.
    ///
    /// # Protocol fee
    /// Batch transfers are **fee-exempt by design**: unlike
    /// `DripFactory::create_stream`, which deducts `DripGovernor::config().fee_bps`
    /// on every stream creation, `process_batch` moves the exact `sum(amounts)`
    /// with no protocol fee. The processor is a separate contract scoped to
    /// bounded execution only (see ADR-007) and deliberately holds no governor
    /// coupling; this is an intentional design decision, not an omission.
    ///
    /// # Retries and idempotency
    /// **This function is NOT idempotent and must not be retried blindly.**
    /// There is no batch identifier or idempotency key: each successful call
    /// re-pulls the full `sum(amounts)` from the funder and re-transfers to
    /// every recipient. If a submission appears to fail (e.g. timeout after
    /// simulation), the caller **must** confirm on-chain state — funder balance,
    /// recipient balances, or the transaction result — before resubmitting.
    /// Retrying a call that actually landed pays every recipient a second time
    /// and drains the funder twice.
    ///
    /// # Duplicate recipients
    /// `recipients` is not deduplicated. If the same address appears more than
    /// once, each occurrence receives its own separate transfer of the matching
    /// `amount` entry; duplicates are neither merged nor rejected. The total
    /// pulled from the funder is still the sum of all entries (each duplicate
    /// counted once per occurrence), so a recipient listed twice with amounts
    /// `[10, 20]` ends up with `30`.
    ///
    /// # Single-entry batches
    /// A batch of size 1 is accepted and is functionally equivalent to a plain
    /// `token.transfer`, but pays this contract's auth and loop overhead. For
    /// single-recipient payouts, prefer calling `token.transfer` directly;
    /// route through `process_batch` only when fanning out to multiple
    /// recipients.
    ///
    /// # Returns
    /// The total number of tokens transferred on success.
    pub fn process_batch(
        env: Env,
        funder: Address,
        token: Address,
        recipients: Vec<Address>,
        amounts: Vec<i128>,
    ) -> Result<i128, Error> {
        // ── Input validation (before auth and any token movement) ────────────

        if recipients.len() != amounts.len() {
            return Err(Error::LengthMismatch);
        }

        if amounts.len() > MAX_BATCH_SIZE {
            return Err(Error::BatchTooLarge);
        }

        // Validate every amount and accumulate the total in one pass so we
        // pull a single lump sum from the funder instead of N separate auths.
        let mut total: i128 = 0;
        for amount in amounts.iter() {
            if amount <= 0 {
                return Err(Error::InvalidAmount);
            }
            total = total.checked_add(amount).ok_or(Error::ArithmeticOverflow)?;
        }

        // Empty batch — nothing to do.
        if total == 0 {
            return Ok(0);
        }

        // ── Auth ─────────────────────────────────────────────────────────────
        funder.require_auth();

        // ── Token transfers ───────────────────────────────────────────────────
        let tk = token::Client::new(&env, &token);
        let contract_addr = env.current_contract_address();

        // Pull the full batch total from the funder into this contract in one
        // transfer, then fan out to each recipient individually.  One inbound
        // transfer keeps the auth surface minimal (funder signs once).
        tk.transfer(&funder, &contract_addr, &total);

        for (recipient, amount) in recipients.iter().zip(amounts.iter()) {
            tk.transfer(&contract_addr, &recipient, &amount);
        }

        Ok(total)
    }

    /// Largest number of transfers `process_batch` will accept in one call.
    ///
    /// Exposed as a read-only entry point so a client integrating against a
    /// deployed instance can discover the cap on-chain instead of hardcoding
    /// it. A hardcoded client-side copy silently drifts if the contract is
    /// ever upgraded with a different limit: the client would keep building
    /// batches it believes are valid until `process_batch` starts rejecting
    /// them with [`Error::BatchTooLarge`].
    ///
    /// This returns the same value [`Self::process_batch`] compares against,
    /// so a batch of exactly `max_batch_size()` entries is accepted and one
    /// more is rejected.
    pub fn max_batch_size(_env: Env) -> u32 {
        MAX_BATCH_SIZE
    }
}
