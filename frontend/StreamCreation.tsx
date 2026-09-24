import React, { useState, useEffect, useRef } from 'react';
import { validateStreamPayload } from './lib/validateStreamPayload';
import { estimateFee, FeeEstimate } from './lib/estimateFee';
import { StreamOperation } from './lib/estimateFee';

const RPC_TIMEOUT_MS = 10_000;
const FEE_DEBOUNCE_MS = 500;
const FACTORY_ADDRESS = process.env.REACT_APP_FACTORY_ADDRESS ?? '';
const RPC_URL = process.env.REACT_APP_RPC_URL ?? 'https://soroban-testnet.stellar.org';

interface CreateStreamPayload {
  recipient: string;
  amount: string;
  ratePerSecond: string;
}

async function createStreamOnChain(payload: CreateStreamPayload): Promise<{ streamId: string }> {
  const response = await fetch('/api/streams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Stream creation failed with status ${response.status}`);
  }

  return response.json();
}

export const StreamCreation: React.FC = () => {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [ratePerSecond, setRatePerSecond] = useState('');
  const [loading, setLoading] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [feeEstimate, setFeeEstimate] = useState<FeeEstimate | null>(null);
  const [feeLoading, setFeeLoading] = useState(false);
  const [feeError, setFeeError] = useState<string | null>(null);
  const feeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const validateCurrentInputs = () => {
    const result = validateStreamPayload({
      recipient,
      amount,
      ratePerSecond,
    });
    setValidationErrors(result.errors);
  };

  useEffect(() => {
    if (feeDebounceRef.current) {
      clearTimeout(feeDebounceRef.current);
    }

    const result = validateStreamPayload({
      recipient,
      amount,
      ratePerSecond,
    });

    if (!result.valid || !FACTORY_ADDRESS) {
      setFeeEstimate(null);
      setFeeError(null);
      return;
    }

    feeDebounceRef.current = setTimeout(async () => {
      setFeeLoading(true);
      setFeeError(null);

      try {
        const operation: StreamOperation = 'CreateStream';
        const estimate = await estimateFee(RPC_URL, FACTORY_ADDRESS, '', operation);
        setFeeEstimate(estimate);
      } catch (e) {
        setFeeError(e instanceof Error ? e.message : 'Failed to estimate fee');
        setFeeEstimate(null);
      } finally {
        setFeeLoading(false);
      }
    }, FEE_DEBOUNCE_MS);

    return () => {
      if (feeDebounceRef.current) {
        clearTimeout(feeDebounceRef.current);
      }
    };
  }, [recipient, amount, ratePerSecond]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setValidationErrors([]);

    const payload = { recipient, amount, ratePerSecond };
    const result = validateStreamPayload(payload);
    if (!result.valid) {
      setValidationErrors(result.errors);
      return;
    }

    setLoading(true);

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('RPC provider timed out. Please try again.')), RPC_TIMEOUT_MS);
    });

    try {
      await Promise.race([createStreamOnChain(payload), timeout]);
    } catch (e) {
      setValidationErrors([e instanceof Error ? e.message : 'Failed to create stream.']);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="stream-creation" onSubmit={handleSubmit}>
      <h2>Create Stream</h2>

      <label>
        Recipient address
        <input value={recipient} onChange={(e) => { setRecipient(e.target.value); validateCurrentInputs(); }} />
      </label>

      <label>
        Amount
        <input value={amount} onChange={(e) => { setAmount(e.target.value); validateCurrentInputs(); }} />
      </label>

      <label>
        Rate per second
        <input value={ratePerSecond} onChange={(e) => { setRatePerSecond(e.target.value); validateCurrentInputs(); }} />
      </label>

      {(feeEstimate || feeLoading || feeError) && (
        <div className="fee-estimate">
          {feeLoading && <p>Estimating network fee...</p>}
          {feeError && <p className="fee-error">{feeError}</p>}
          {feeEstimate && !feeLoading && (
            <div className="fee-details">
              <div>Network Fee: {feeEstimate.fee_xlm} XLM</div>
              <div>CPU Instructions: {feeEstimate.cpu_instructions.toLocaleString()}</div>
              <div>Ledger Entries: {feeEstimate.ledger_entries}</div>
            </div>
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

      <button type="submit" disabled={loading || validationErrors.length > 0}>
        {loading ? 'Creating stream...' : 'Create stream'}
      </button>
    </form>
  );
};
