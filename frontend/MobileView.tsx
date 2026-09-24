import React, { useState } from 'react';
import { useMutation, gql, useApolloClient } from '@apollo/client';
import { validateStreamPayload } from './lib/validateStreamPayload';
import { useFeeEstimate } from './lib/useFeeEstimate';

const SUBMIT_STREAM_REQUEST_MOBILE = gql`
  mutation SubmitStreamRequestMobile($recipient: String!, $amount: String!, $ratePerSecond: String!) {
    submitStreamRequest(recipient: $recipient, amount: $amount, ratePerSecond: $ratePerSecond) {
      id
      status
    }
  }
`;

const FACTORY_ADDRESS = process.env.REACT_APP_FACTORY_ADDRESS ?? '';
const MUTATION_TIMEOUT_MS = 10_000;

export const MobileView: React.FC = () => {
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
    senderAddress: '',
    enabled: hasValidInputs && FACTORY_ADDRESS.length > 0,
  });

  const [submitStreamRequest, { loading }] = useMutation(SUBMIT_STREAM_REQUEST_MOBILE, {
    // FIX for Bug #148: Reset Apollo cache after successful mutation so
    // subsequent queries reflect the latest on-chain state instead of
    // serving stale cached data.
    onCompleted: () => {
      client.cache.reset();
    },
  });

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const payload = {
      recipient,
      amount,
      ratePerSecond,
    };

    // FIX for Bug #159: same underlying issue as the desktop Wallet
    // Connection flow (#149) — validation only ran on each input's
    // onChange, never re-checked at submit time, so an invalid payload
    // could reach the contract via the mobile form's Enter-to-submit or a
    // programmatically dispatched submit event. Reuses the shared
    // validateStreamPayload() helper and re-runs it as the last step
    // before the mutation fires.
    const result = validateStreamPayload(payload);
    setValidationErrors(result.errors);
    if (!result.valid) {
      return;
    }

    // FIX for Bug #285: same underlying issue as StreamCreation (#150) and
    // WalletConnection — if the GraphQL endpoint never responds, the loading
    // state hangs indefinitely. Racing the mutation against a timeout
    // guarantees loading always clears, either with a result or a clear
    // timeout error.
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('GraphQL endpoint timed out. Please try again.')), MUTATION_TIMEOUT_MS);
    });

    try {
      await Promise.race([submitStreamRequest({ variables: payload }), timeout]);
    } catch (e) {
      setValidationErrors([e instanceof Error ? e.message : 'Failed to submit stream request.']);
    }
  };

  return (
    <form className="mobile-view" onSubmit={handleSubmit}>
      <h2>Create Stream</h2>

      <label>
        Recipient address
        <input value={recipient} onChange={(e) => setRecipient(e.target.value)} />
      </label>

      <label>
        Amount
        <input value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>

      <label>
        Rate per second
        <input value={ratePerSecond} onChange={(e) => setRatePerSecond(e.target.value)} />
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
