/**
 * Screen 6 — Nouns Passport Validate. Two on-chain EAS attest() flows:
 *   Peer verification (Schema 2) — a Noun holder verifies/disputes a milestone
 *   Builder milestone (Schema 1) — a prop update admin records a milestone
 * On-chain resolvers enforce eligibility; Gavel just builds and signs.
 * No clientId 38 — EAS attest() is not rewards-eligible.
 */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import {
  attestPeerVerification,
  attestBuilderMilestone,
} from '../actions/attest.js';
import { useServices } from '../hooks/AppContext.js';
import { Header, Footer, Field } from '../components/common.js';
import { shortAddress } from '../utils/format.js';
import type { TxResult } from '../actions/vote.js';

type Mode = 'menu' | 'peer' | 'milestone';

const ZERO_HASH =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

interface FormField {
  key: string;
  label: string;
  placeholder: string;
  hint?: string;
}

const PEER_FIELDS: FormField[] = [
  { key: 'milestoneUID', label: 'Milestone UID', placeholder: '0x… (Schema 1 attestation UID)' },
  { key: 'propId', label: 'Prop ID', placeholder: 'e.g. 512' },
  { key: 'verified', label: 'Verified?', placeholder: 'true / false', hint: 'true = verify, false = dispute' },
  { key: 'comment', label: 'Comment', placeholder: '(optional)' },
];

const MILESTONE_FIELDS: FormField[] = [
  { key: 'propId', label: 'Prop ID', placeholder: 'e.g. 512' },
  { key: 'milestoneTitle', label: 'Title', placeholder: 'Milestone title' },
  { key: 'evidenceURI', label: 'Evidence URI', placeholder: 'ipfs://… or https://…' },
  { key: 'isFinal', label: 'Is final?', placeholder: 'true / false' },
  { key: 'propdateTxHash', label: 'Propdate tx', placeholder: '0x… (or blank)' },
];

type Phase =
  | { kind: 'form'; index: number }
  | { kind: 'confirm' }
  | { kind: 'broadcasting' }
  | { kind: 'done'; result: TxResult }
  | { kind: 'error'; message: string };

export function PassportValidate({ onBack }: { onBack: () => void }) {
  const { publicClient, signer } = useServices();
  const [mode, setMode] = useState<Mode>('menu');
  const [values, setValues] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>({ kind: 'form', index: 0 });
  const [draft, setDraft] = useState('');

  const fields = mode === 'peer' ? PEER_FIELDS : MILESTONE_FIELDS;

  function startMode(next: Mode) {
    setMode(next);
    setValues({});
    setDraft('');
    setPhase({ kind: 'form', index: 0 });
  }

  useInput((input, key) => {
    if (mode === 'menu') {
      if (input === '1') startMode('peer');
      else if (input === '2') startMode('milestone');
      else if (key.escape || input === 'q') onBack();
      return;
    }
    if (phase.kind === 'confirm') {
      if (input === 'y' || input === 'Y') void broadcast();
      else if (input === 'n' || input === 'N' || key.escape) setPhase({ kind: 'form', index: 0 });
    } else if (phase.kind === 'done' || phase.kind === 'error') {
      if (key.return || key.escape) setMode('menu');
    } else if (phase.kind === 'form' && key.escape) {
      setMode('menu');
    }
  });

  function submitField(val: string) {
    if (phase.kind !== 'form') return;
    const field = fields[phase.index];
    const nextValues = { ...values, [field.key]: val };
    setValues(nextValues);
    setDraft('');
    if (phase.index + 1 < fields.length) {
      setPhase({ kind: 'form', index: phase.index + 1 });
    } else {
      setPhase({ kind: 'confirm' });
    }
  }

  async function broadcast() {
    if (!signer) {
      setPhase({ kind: 'error', message: 'Canonical wallet handoff is not implemented yet.' });
      return;
    }
    setPhase({ kind: 'broadcasting' });
    try {
      let result: TxResult;
      if (mode === 'peer') {
        result = await attestPeerVerification(publicClient, signer, {
          milestoneUID: (values.milestoneUID || ZERO_HASH) as `0x${string}`,
          propId: BigInt(values.propId || '0'),
          verified: /^true$/i.test(values.verified ?? ''),
          comment: values.comment ?? '',
        });
      } else {
        result = await attestBuilderMilestone(publicClient, signer, {
          propId: BigInt(values.propId || '0'),
          milestoneTitle: values.milestoneTitle ?? '',
          evidenceURI: values.evidenceURI ?? '',
          isFinal: /^true$/i.test(values.isFinal ?? ''),
          propdateTxHash: (values.propdateTxHash || ZERO_HASH) as `0x${string}`,
        });
      }
      setPhase({ kind: 'done', result });
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (mode === 'menu') {
    return (
      <Box flexDirection="column">
        <Header title="Passport · Validate" subtitle="submit an on-chain EAS attestation" />
        <Text><Text color="cyan" bold>[1]</Text> Peer verification (Schema 2) — verify/dispute a milestone</Text>
        <Text dimColor>     requires holding ≥ 1 Noun (enforced by NounHolderResolver)</Text>
        <Text><Text color="cyan" bold>[2]</Text> Builder milestone (Schema 1) — record a prop milestone</Text>
        <Text dimColor>     requires being the prop's propUpdateAdmin (enforced by resolver)</Text>
        <Box marginTop={1}>
          {!signer ? (
            <Text color="yellow">⚠ attestations are disabled during the TUI migration</Text>
          ) : (
            <Text dimColor>signing as {shortAddress(signer.address)}</Text>
          )}
        </Box>
        <Footer hints={[['1/2', 'choose flow'], ['esc', 'back']]} />
      </Box>
    );
  }

  const title = mode === 'peer' ? 'Peer Verification (Schema 2)' : 'Builder Milestone (Schema 1)';

  return (
    <Box flexDirection="column">
      <Header title="Passport · Validate" subtitle={title} />

      {/* Already-entered fields */}
      {fields.map((f, i) =>
        phase.kind === 'form' && i >= phase.index ? null : (
          <Field key={f.key} label={f.label}>{values[f.key] || '—'}</Field>
        ),
      )}

      {phase.kind === 'form' && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            {fields[phase.index].label}
            {fields[phase.index].hint ? <Text dimColor> — {fields[phase.index].hint}</Text> : null}
          </Text>
          <Box>
            <Text color="cyan">› </Text>
            <TextInput
              value={draft}
              onChange={setDraft}
              onSubmit={submitField}
              placeholder={fields[phase.index].placeholder}
            />
          </Box>
        </Box>
      )}

      {phase.kind === 'confirm' && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Confirm attestation</Text>
          <Field label="via">EAS.attest()</Field>
          <Field label="schema">{mode === 'peer' ? 'Peer Verification' : 'Builder Milestone'}</Field>
          <Field label="clientId">n/a (not rewards-eligible)</Field>
          <Box marginTop={1}>
            <Text>Broadcast? <Text color="green" bold>[y]</Text> / <Text color="red" bold>[n]</Text></Text>
          </Box>
        </Box>
      )}

      {phase.kind === 'broadcasting' && (
        <Text><Spinner type="dots" /> Signing &amp; broadcasting attestation…</Text>
      )}

      {phase.kind === 'done' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={phase.result.status === 'success' ? 'green' : 'red'} bold>
            {phase.result.status === 'success' ? '✓ Attestation on-chain' : '✗ Reverted'}
          </Text>
          <Field label="tx">{phase.result.hash}</Field>
          <Field label="block">{phase.result.blockNumber.toString()}</Field>
          {mode === 'milestone' ? (
            <Text dimColor>Schema 3 Builder Passport auto-refreshed in the same tx.</Text>
          ) : null}
          <Text dimColor>[enter] back to menu</Text>
        </Box>
      )}

      {phase.kind === 'error' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red">✗ {phase.message}</Text>
          <Text dimColor>[enter] back</Text>
        </Box>
      )}

      <Footer hints={[['↵', 'next field'], ['esc', 'cancel']]} />
    </Box>
  );
}
