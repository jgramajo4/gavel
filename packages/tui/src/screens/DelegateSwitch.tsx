/**
 * Screen 4 — Delegate Switching. Shows current delegate, prompts for a new
 * delegatee (ENS/address), builds + signs delegate() via the session key, and
 * polls for confirmation. First signed tx in the build order.
 */
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { delegateTo, currentDelegate } from '../actions/delegate.js';
import { resolveToAddress } from '../data/ens.js';
import { useServices } from '../hooks/AppContext.js';
import { Header, Footer, Field } from '../components/common.js';
import { shortAddress } from '../utils/format.js';
import type { TxResult } from '../actions/vote.js';

type Step =
  | { kind: 'loadingCurrent' }
  | { kind: 'input'; current: `0x${string}` }
  | { kind: 'confirm'; current: `0x${string}`; next: `0x${string}`; raw: string }
  | { kind: 'broadcasting' }
  | { kind: 'done'; result: TxResult }
  | { kind: 'error'; message: string };

export function DelegateSwitch({ onBack }: { onBack: () => void }) {
  const { publicClient, signer } = useServices();
  const [step, setStep] = useState<Step>({ kind: 'loadingCurrent' });
  const [input, setInput] = useState('');

  useEffect(() => {
    if (!signer) {
      setStep({ kind: 'error', message: 'Canonical wallet handoff is not implemented yet.' });
      return;
    }
    let cancelled = false;
    void currentDelegate(publicClient, signer.address)
      .then((current) => {
        if (!cancelled) setStep({ kind: 'input', current });
      })
      .catch((err) => {
        if (!cancelled) setStep({ kind: 'error', message: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [publicClient, signer]);

  useInput((key, keys) => {
    if (step.kind === 'confirm') {
      if (key === 'y' || key === 'Y') void broadcast(step.next);
      else if (key === 'n' || key === 'N' || keys.escape) setStep({ kind: 'input', current: step.current });
    } else if (step.kind === 'done' || step.kind === 'error') {
      if (keys.return || keys.escape) onBack();
    } else if (keys.escape) {
      onBack();
    }
  });

  async function submitNew(raw: string) {
    if (step.kind !== 'input') return;
    const next = await resolveToAddress(publicClient, raw);
    if (!next) {
      setStep({ kind: 'error', message: `Could not resolve "${raw}".` });
      return;
    }
    setStep({ kind: 'confirm', current: step.current, next, raw });
  }

  async function broadcast(next: `0x${string}`) {
    if (!signer) return;
    setStep({ kind: 'broadcasting' });
    try {
      const result = await delegateTo(publicClient, signer, next);
      setStep({ kind: 'done', result });
    } catch (err) {
      setStep({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <Box flexDirection="column">
      <Header title="Switch Delegation" subtitle={signer ? shortAddress(signer.address) : 'no key'} />

      {step.kind === 'loadingCurrent' && (
        <Text><Spinner type="dots" /> Reading current delegate…</Text>
      )}

      {step.kind === 'input' && (
        <Box flexDirection="column">
          <Field label="current">
            {step.current.toLowerCase() === signer?.address.toLowerCase()
              ? 'self'
              : shortAddress(step.current)}
          </Field>
          <Box marginTop={1}>
            <Text>New delegate (ENS/address): </Text>
            <TextInput value={input} onChange={setInput} onSubmit={submitNew} placeholder="self or 0x… / name.eth" />
          </Box>
        </Box>
      )}

      {step.kind === 'confirm' && (
        <Box flexDirection="column">
          <Text bold>Confirm delegation</Text>
          <Field label="function">delegate(address)</Field>
          <Field label="from">{shortAddress(step.current)}</Field>
          <Field label="to">{step.raw} → {shortAddress(step.next)}</Field>
          <Box marginTop={1}>
            <Text>Broadcast? <Text color="green" bold>[y]</Text> / <Text color="red" bold>[n]</Text></Text>
          </Box>
        </Box>
      )}

      {step.kind === 'broadcasting' && (
        <Text><Spinner type="dots" /> Signing &amp; broadcasting delegate()…</Text>
      )}

      {step.kind === 'done' && (
        <Box flexDirection="column">
          <Text color={step.result.status === 'success' ? 'green' : 'red'} bold>
            {step.result.status === 'success' ? '✓ Delegation updated' : '✗ Reverted'}
          </Text>
          <Field label="tx">{step.result.hash}</Field>
          <Field label="block">{step.result.blockNumber.toString()}</Field>
          <Text dimColor>[enter] back</Text>
        </Box>
      )}

      {step.kind === 'error' && (
        <Box flexDirection="column">
          <Text color="red">✗ {step.message}</Text>
          <Text dimColor>[enter] back</Text>
        </Box>
      )}

      <Footer hints={[['esc', 'back']]} />
    </Box>
  );
}
