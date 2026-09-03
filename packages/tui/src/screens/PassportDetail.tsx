/** Passport attestation detail — full decoded EAS attestation data. */
import React from 'react';
import { Box, Text, useInput } from 'ink';
import { Header, Footer, Field } from '../components/common.js';
import { shortAddress, relativeTime } from '../utils/format.js';
import type { Attestation } from '../types.js';

function renderValue(v: unknown): string {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === null || v === undefined) return '—';
  return String(v);
}

export function PassportDetail({ attestation, onBack }: { attestation: Attestation; onBack: () => void }) {
  useInput((input, key) => {
    if (key.escape || input === 'q' || key.leftArrow) onBack();
  });

  const typeText =
    attestation.passportType === 'MILESTONE'
      ? 'Builder Milestone (Schema 1)'
      : attestation.passportType === 'PEER'
        ? 'Peer Verification (Schema 2)'
        : attestation.passportType === 'PASSPORT'
          ? 'Builder Passport (Schema 3)'
          : 'Attestation';

  return (
    <Box flexDirection="column">
      <Header title="Attestation Detail" subtitle={typeText} />
      <Field label="uid">{attestation.id}</Field>
      <Field label="schema">{attestation.schemaId}</Field>
      <Field label="attester">{shortAddress(attestation.attester)}</Field>
      <Field label="recipient">{shortAddress(attestation.recipient)}</Field>
      {attestation.refUID && !/^0x0+$/.test(attestation.refUID) ? (
        <Field label="ref (milestone)">{attestation.refUID}</Field>
      ) : null}
      <Field label="time">{relativeTime(attestation.time)}</Field>
      <Field label="revocable">{attestation.revocable ? 'yes' : 'no'}</Field>
      {attestation.revocationTime > 0 ? (
        <Field label="revoked">{relativeTime(attestation.revocationTime)}</Field>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Text bold dimColor>Decoded data</Text>
        {attestation.decoded ? (
          Object.entries(attestation.decoded).map(([k, v]) => (
            <Field key={k} label={k}>{renderValue(v)}</Field>
          ))
        ) : (
          <Text dimColor>raw: {attestation.data}</Text>
        )}
      </Box>

      {attestation.passportType === 'PEER' && attestation.decoded ? (
        <Box marginTop={1}>
          <Text color={attestation.decoded.verified ? 'green' : 'red'}>
            {attestation.decoded.verified ? '✓ Verified' : '✗ Disputed'} by holder
          </Text>
        </Box>
      ) : null}

      <Footer hints={[['esc', 'back']]} />
    </Box>
  );
}

