import { TransactionBuilder, Contract, xdr } from '@stellar/stellar-sdk/base';
import { Server as SorobanRpc, Api } from '@stellar/stellar-sdk/rpc';

const SIMULATION_TIMEOUT_MS = 10_000;
const STROOPS_PER_XLM = 10_000_000;

export interface FeeEstimate {
  fee_stroops: number;
  fee_xlm: string;
  cpu_instructions: number;
  ledger_entries: number;
}

/**
 * Every stream operation `DripFactory::estimate_fee` accepts.
 *
 * This array is the runtime single source of truth for the
 * {@link StreamOperation} union — adding or removing an entry updates the
 * type, so TypeScript and this list can never disagree. The list itself must
 * stay in exact sync (names and order) with the `StreamOperation` enum in
 * `contracts/factory/src/storage.rs`; `estimateFee.test.ts` parses both files
 * and fails the build whenever they drift (issue #579).
 */
export const STREAM_OPERATIONS = [
  'CreateStream',
  'CancelStream',
  'Withdraw',
  'PauseStream',
  'ResumeStream',
  'SetOperator',
  'RevokeOperator',
  'ExtendDuration',
  'TopUp',
  'TopUpAndExtend',
  'Clawback',
  'ForceCancel',
  'TransferRecipient',
] as const;

export type StreamOperation = (typeof STREAM_OPERATIONS)[number];

/**
 * Estimate the Soroban network fee for a stream operation by simulating
 * the transaction against the Soroban RPC endpoint.
 *
 * Uses `simulateTransaction` to run a dry-run of the `estimate_fee`
 * contract call and extracts the exact resource cost from the simulation
 * metadata, then calculates the fee based on the current network base fee.
 *
 * @param rpcUrl       - Soroban RPC endpoint (e.g. "https://soroban-testnet.stellar.org")
 * @param factoryId    - Deployed DripFactory contract address (C...)
 * @param source       - Account address that will sign the transaction (used for auth)
 * @param operation    - The operation to estimate ("CreateStream", "CancelStream", etc.)
 */
export async function estimateFee(
  rpcUrl: string,
  factoryId: string,
  source: string,
  operation: StreamOperation,
): Promise<FeeEstimate> {
  const server = new SorobanRpc(rpcUrl);

  // Fetch the source account's current sequence number for the simulation.
  const account = await server.getAccount(source);

  const networkPassphrase = rpcUrl.includes('mainnet')
    ? 'Public Global Stellar Network ; September 2015'
    : 'Test SDF Network ; September 2015';

  // Build a minimal transaction with the estimateFee contract call.
  // Soroban simulates the full operation including contract invocation,
  // CPU instruction counting, and ledger entry access tracking.
  const transaction = new TransactionBuilder(account, {
    fee: '0', // Simulation is free — the RPC calculates the actual fee
    networkPassphrase,
  })
    .addOperation(
      new Contract(factoryId).call(
        'estimate_fee',
        // #[contracttype] unit-variant enums encode as a one-element vector
        // holding the variant name as a Symbol — ScVec[ScSymbol(operation)] —
        // not a numeric discriminant (see soroban-sdk's derive_enum). The
        // factory decodes the variant by name, so every name listed in
        // STREAM_OPERATIONS must exist on the Rust enum too.
        xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(operation)]),
      ),
    )
    .setTimeout(SIMULATION_TIMEOUT_MS)
    .build();

  // Run the simulation — the RPC executes the operation in a sandboxed
  // environment and returns resource consumption without modifying state.
  const simulation = await server.simulateTransaction(transaction);

  if (Api.isSimulationError(simulation)) {
    throw new Error(`Simulation failed: ${simulation.error}`);
  }

  // Extract the minimum resource fee from the simulation result.
  // `minResourceFee` is the exact Soroban resource fee in stroops
  // calculated from the actual CPU/RAM usage of the simulated operation.
  const feeStroops = parseInt(simulation.minResourceFee ?? '0', 10);

  // Real resource figures the RPC filled in from executing the simulation —
  // not a derived heuristic. `resources.instructions` is the CPU instruction
  // count the simulated invocation requires, and the resource footprint
  // lists every ledger entry it touched (issue #580).
  const txData = simulation.transactionData.build();
  const cpuInstructions = txData.resources.instructions;
  const footprint = txData.resources.footprint;
  const ledgerEntries = footprint.readOnly.length + footprint.readWrite.length;

  const feeXlm = (feeStroops / STROOPS_PER_XLM).toFixed(7);

  return {
    fee_stroops: feeStroops,
    fee_xlm: feeXlm,
    cpu_instructions: cpuInstructions,
    ledger_entries: ledgerEntries,
  };
}
