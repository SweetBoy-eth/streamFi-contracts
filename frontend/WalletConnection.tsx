import React, { useState } from 'react';
import { useMutation, gql, useApolloClient } from '@apollo/client';
import { validateStreamPayload } from './lib/validateStreamPayload';
import { GET_DASHBOARD_SUMMARY } from './Dashboard';
import { useFeeEstimate } from './lib/useFeeEstimate';
import { useWalletSession } from './lib/useWalletSession';

const FACTORY_ADDRESS = process.env.REACT_APP_FACTORY_ADDRESS ?? '';

const SUBMIT_STREAM_REQUEST = gql`
  mutation SubmitStreamRequest($recipient: String!, $amount: String!, $ratePerSecond: String!) {
    submitStreamRequest(recipient: $recipient, amount: $amount, ratePerSecond: $ratePerSecond) {
      id
      status
    }
  }
`;

const MUTATION_TIMEOUT_MS = 10_000;

/**
 * Issue #589 audit: this component connects a wallet (via `connect`, below)
 * but previously had no disconnect action and no session-expiry handling —
 * a wallet session that expired mid-flow would only surface as an opaque
 * mutation error. `useWalletSession` now owns that lifecycle: it exposes an
 * explicit "Disconnect" action and auto-clears the session on expiry, and
 * this component re-prompts for connection instead of letting the stream
 * form submit against a dead session.
 */
export const WalletConnection: React.FC = () => {
  const { session, isConnected, didExpire, connect, disconnect } = useWalletSession();
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [ratePerSecond, setRatePerSecond] = useState('');
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const client = useApolloClient();

  const hasValidInputs = validateStreamPayload({
    recipient,
    amount,
    ratePerSecond,
  }).valid;

  const { estimate: feeEstimate, loading: feeLoading, error: feeError } = useFeeEstimate({
    factoryAddress: FACTORY_ADDRESS,
    senderAddress: session?.address ?? '',
    enabled: isConnected && hasValidInputs && FACTORY_ADDRESS.length > 0,
  });

  // Accepts the field that just changed as an override, since the input's
  // onChange fires before the corresponding setState has been applied —
  // reading from the closed-over recipient/amount/ratePerSecond state here
  // would validate against the value from before this keystroke.
  const validateCurrentInputs = (overrides: Partial<{ recipient: string; amount: string; ratePerSecond: string }> = {}) => {
    const result = validateStreamPayload({
      recipient: overrides.recipient ?? recipient,
      amount: overrides.amount ?? amount,
      ratePerSecond: overrides.ratePerSecond ?? ratePerSecond,
    });
    setValidationErrors(result.errors);
  };

  const [submitStreamRequest, { loading }] = useMutation(SUBMIT_STREAM_REQUEST, {
    // FIX for Bug #148: Previously only refetched GET_DASHBOARD_SUMMARY,
    // leaving other cached queries (transactions, notifications, etc.)
    // stale. Resetting the entire cache after a successful mutation
    // guarantees every subsequent query reads fresh on-chain data.
    onCompleted: () => {
      client.cache.reset();
    },
  });

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!isConnected) {
      setValidationErrors(['Connect your wallet before submitting a stream request.']);
      return;
    }

    const payload = {
      recipient,
      amount,
      ratePerSecond,
    };

    // FIX for Bug #149: validation previously only ran on each input's
    // onChange (disabling the submit button via UI state), but the submit
    // handler itself never re-checked the values before sending them
    // on-chain. That let invalid payloads through via the Enter key,
    // devtools, or a programmatically dispatched submit event. Re-validating
    // here, as the last step before the mutation fires, ensures a malformed
    // payload can never reach the contract regardless of how submit was
    // triggered.
    const result = validateStreamPayload(payload);
    setValidationErrors(result.errors);
    if (!result.valid) {
      return;
    }

    // FIX for Bug #285: same underlying issue as StreamCreation (#150) —
    // if the GraphQL endpoint never responds, the loading state hangs
    // indefinitely. Racing the mutation against a timeout guarantees
    // loading always clears, either with a result or a clear timeout error.
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('GraphQL endpoint timed out. Please try again.')), MUTATION_TIMEOUT_MS);
    });

    try {
      await Promise.race([submitStreamRequest({ variables: payload }), timeout]);
    } catch (e) {
      setValidationErrors([e instanceof Error ? e.message : 'Failed to submit stream request.']);
    }
  };

  const handleConnect = async () => {
    // Delegates to an injected wallet extension (e.g. Freighter) when
    // present; falls back to a manual address prompt otherwise so the
    // session lifecycle below can still be exercised without one installed.
    const injected = (window as unknown as { freighter?: { getPublicKey?: () => Promise<string> } }).freighter;
    try {
      const address = injected?.getPublicKey
        ? await injected.getPublicKey()
        : window.prompt('Enter a Stellar address to simulate a wallet connection:');
      if (address) connect(address);
    } catch (e) {
      setValidationErrors([e instanceof Error ? e.message : 'Failed to connect wallet.']);
    }
  };

  return (
    <form className="wallet-connection" onSubmit={handleSubmit}>
      <h2>Connect Wallet &amp; Create Stream</h2>

      <div className="wallet-session">
        {isConnected && session ? (
          <>
            <span className="wallet-address">Connected: {session.address}</span>
            <button type="button" onClick={disconnect}>
              Disconnect
            </button>
          </>
        ) : (
          <button type="button" onClick={handleConnect}>
            Connect Wallet
          </button>
        )}
        {didExpire && !isConnected && (
          <p className="wallet-session-expired" role="alert">
            Your wallet session expired. Please reconnect to continue.
          </p>
        )}
      </div>

      <label>
        Recipient address
        <input value={recipient} onChange={(e) => { setRecipient(e.target.value); validateCurrentInputs({ recipient: e.target.value }); }} />
      </label>

      <label>
        Amount
        <input value={amount} onChange={(e) => { setAmount(e.target.value); validateCurrentInputs({ amount: e.target.value }); }} />
      </label>

      <label>
        Rate per second
        <input value={ratePerSecond} onChange={(e) => { setRatePerSecond(e.target.value); validateCurrentInputs({ ratePerSecond: e.target.value }); }} />
      </label>

      {hasValidInputs && FACTORY_ADDRESS.length > 0 && (
        <div className="fee-estimate">
          {feeLoading && <span className="fee-loading">Estimating network fee...</span>}
          {feeError && <span className="fee-error">Fee estimate unavailable: {feeError}</span>}
          {feeEstimate && !feeLoading && (
            <span className="fee-result">
              Estimated network fee: <strong>{feeEstimate.fee_xlm} XLM</strong>
            </span>
          )}
        </div>
      )}

      {validationErrors.length > 0 && (
        <ul className="validation-errors">
          {validationErrors.map((err) => (
            <li key={err}>{err}</li>
          ))}
        </ul>
      )}

      <button type="submit" disabled={loading}>
        {loading ? 'Submitting...' : 'Submit'}
      </button>
    </form>
  );
};
