/**
 * Vote flow — the rewards-eligible signed action. F/A/Abstain → optional reason
 * → confirmation (tx params incl. clientId 38 + estimated gas) → sign/broadcast
 * → receipt with reward attribution. Refundable: gas is rebated for early votes.
 */
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { castVote, estimateVoteGas, type TxResult } from '../actions/vote.js';
import { CLIENT_ID } from '../constants.js';
import { Field } from './common.js';
import { shortAddress } from '../utils/format.js';
import { useServices } from '../hooks/AppContext.js';
import type { VoteSupport } from '../types.js';

type Step =
  | { kind: 'choose' }
  | { kind: 'reason'; support: VoteSupport }
  | { kind: 'confirm'; support: VoteSupport; reason: string; gas: bigint | null }
  | { kind: 'broadcasting' }
  | { kind: 'done'; result: TxResult; support: VoteSupport }
  | { kind: 'error'; message: string };

const SUPPORT_LABEL: Record<VoteSupport, string> = {
  0: 'AGAINST',
  1: 'FOR',
  2: 'ABSTAIN',
};

export function VoteFlow({
  proposalId,
  onExit,
}: {
  proposalId: number;
  onExit: () => void;
}) {
  const { publicClient, signer } = useServices();
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [reasonInput, setReasonInput] = useState('');

  // Move to confirm: estimate gas when we land on it.
  useEffect(() => {
    if (step.kind === 'confirm' && step.gas === null && signer) {
      let cancelled = false;
      void estimateVoteGas(publicClient, signer, proposalId, step.support, step.reason).then(
        (gas) => {
          if (!cancelled) setStep({ ...step, gas });
        },
      );
      return () => {
        cancelled = true;
      };
    }
  }, [step, signer, publicClient, proposalId]);

  useInput((input, key) => {
    if (step.kind === 'choose') {
      if (input === 'f' || input === 'F') setStep({ kind: 'reason', support: 1 });
      else if (input === 'a' || input === 'A') setStep({ kind: 'reason', support: 0 });
      else if (input === 's' || input === 'S') setStep({ kind: 'reason', support: 2 });
      else if (input === 'b' || input === 'B' || key.escape) onExit();
    } else if (step.kind === 'confirm') {
      if (input === 'y' || input === 'Y') void broadcast(step.support, step.reason);
      else if (input === 'n' || input === 'N' || key.escape) setStep({ kind: 'choose' });
    } else if (step.kind === 'done' || step.kind === 'error') {
      if (key.return || key.escape) onExit();
    }
  });

  async function broadcast(support: VoteSupport, reason: string) {
    if (!signer) {
      setStep({ kind: 'error', message: 'Canonical wallet handoff is not implemented yet.' });
      return;
    }
    setStep({ kind: 'broadcasting' });
    try {
      const result = await castVote(publicClient, signer, proposalId, support, reason);
      setStep({ kind: 'done', result, support });
    } catch (err) {
      setStep({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (!signer) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text color="yellow">Voting unavailable during the TUI migration.</Text>
        <Text dimColor>
          Use the canonical Gavel CLI to prepare an unsigned vote for review.
        </Text>
        <Text dimColor>[esc] back</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Cast Vote · Proposal {proposalId}
      </Text>
      <Text color="green" dimColor>
        gas-refundable vote available — the DAO rebates gas for early votes
      </Text>

      {step.kind === 'choose' && (
        <Box marginTop={1}>
          <Text>
            Vote <Text color="green" bold>[F]</Text>or ·{' '}
            <Text color="red" bold>[A]</Text>gainst ·{' '}
            <Text bold>[S]</Text>abstain ·{' '}
            <Text bold>[B]</Text>ack
          </Text>
        </Box>
      )}

      {step.kind === 'reason' && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            Optional reason (blank → castRefundableVote, no reason):
          </Text>
          <Box>
            <Text color="cyan">› </Text>
            <TextInput
              value={reasonInput}
              onChange={setReasonInput}
              onSubmit={(val) =>
                setStep({ kind: 'confirm', support: step.support, reason: val, gas: null })
              }
              placeholder="(press enter to skip)"
            />
          </Box>
        </Box>
      )}

      {step.kind === 'confirm' && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Confirm transaction</Text>
          <Field label="function">
            {step.reason.trim() ? 'castRefundableVoteWithReason' : 'castRefundableVote'}
          </Field>
          <Field label="proposalId">{proposalId}</Field>
          <Field label="support">
            {SUPPORT_LABEL[step.support]} ({step.support})
          </Field>
          {step.reason.trim() ? <Field label="reason">{step.reason.trim()}</Field> : null}
          <Field label="clientId">{CLIENT_ID}</Field>
          <Field label="from">{shortAddress(signer.address)}</Field>
          <Field label="est. gas">
            {step.gas === null ? 'estimating…' : `${step.gas.toString()} units (refundable)`}
          </Field>
          <Box marginTop={1}>
            <Text>
              Broadcast? <Text color="green" bold>[y]</Text> /{' '}
              <Text color="red" bold>[n]</Text>
            </Text>
          </Box>
        </Box>
      )}

      {step.kind === 'broadcasting' && (
        <Text>
          <Spinner type="dots" /> Signing &amp; broadcasting… polling for inclusion.
        </Text>
      )}

      {step.kind === 'done' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={step.result.status === 'success' ? 'green' : 'red'} bold>
            {step.result.status === 'success' ? '✓ Vote included' : '✗ Reverted'}
          </Text>
          <Field label="tx">{step.result.hash}</Field>
          <Field label="block">{step.result.blockNumber.toString()}</Field>
          <Field label="gas used">{step.result.gasUsed.toString()}</Field>
          <Field label="reward">attributed to clientId {CLIENT_ID}</Field>
          <Text dimColor>[enter] back to proposal</Text>
        </Box>
      )}

      {step.kind === 'error' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red">✗ {step.message}</Text>
          <Text dimColor>[enter] back</Text>
        </Box>
      )}
    </Box>
  );
}
