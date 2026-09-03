/** Screen 5 — Nouns Passport Feed. Recent EAS attestations, three types. */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { usePassportFeed } from '../hooks/usePassportFeed.js';
import { Header, Footer, ErrorLine } from '../components/common.js';
import { shortAddress, relativeTime, truncate } from '../utils/format.js';
import type { Attestation } from '../types.js';
import type { Route } from '../navigation.js';

const TYPE_LABEL: Record<NonNullable<Attestation['passportType']>, { text: string; color: string }> = {
  MILESTONE: { text: 'Milestone', color: 'cyan' },
  PEER: { text: 'Peer-Verify', color: 'yellow' },
  PASSPORT: { text: 'Passport', color: 'magenta' },
  UNKNOWN: { text: 'Attestation', color: 'gray' },
};

function summarize(a: Attestation): string {
  const d = a.decoded;
  if (!d) return `schema ${shortAddress(a.schemaId)}`;
  if (a.passportType === 'MILESTONE') {
    return truncate(String(d.milestoneTitle ?? ''), 34) + (d.isFinal ? ' (final)' : '');
  }
  if (a.passportType === 'PEER') {
    return `${d.verified ? '✓ verified' : '✗ disputed'} · ${truncate(String(d.comment ?? ''), 24)}`;
  }
  if (a.passportType === 'PASSPORT') {
    return `${d.completedProps}/${d.totalProps} props · ${d.totalMilestones} milestones`;
  }
  return '';
}

const PAGE = 12;

export function PassportFeed({ navigate, onBack }: { navigate: (r: Route) => void; onBack: () => void }) {
  const { items, loading, error, refresh } = usePassportFeed();
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.escape || input === 'q') onBack();
    else if (key.downArrow || input === 'j') setCursor((c) => Math.min(items.length - 1, c + 1));
    else if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
    else if (key.return) {
      const a = items[cursor];
      if (a) navigate({ screen: 'passportDetail', attestation: a });
    } else if (input === 'r') void refresh();
    else if (input === 'v') navigate({ screen: 'passportValidate' });
  });

  const offset = Math.max(0, Math.min(cursor - PAGE + 1, items.length - PAGE));
  const visible = items.slice(offset, offset + PAGE);

  return (
    <Box flexDirection="column">
      <Header title="Passport Feed" subtitle={`${items.length} recent attestations (EAS)`} />
      {loading && items.length === 0 ? (
        <Text><Spinner type="dots" /> Loading feed…</Text>
      ) : error && items.length === 0 ? (
        <ErrorLine message={error} />
      ) : items.length === 0 ? (
        <Text dimColor>No attestations found.</Text>
      ) : (
        <Box flexDirection="column">
          {visible.map((a, i) => {
            const idx = offset + i;
            const label = TYPE_LABEL[a.passportType ?? 'UNKNOWN'];
            return (
              <Box key={a.id}>
                <Box width={2}><Text color="cyan">{idx === cursor ? '›' : ' '}</Text></Box>
                <Box width={12}><Text color={label.color}>{label.text}</Text></Box>
                <Box width={14}><Text dimColor>{shortAddress(a.attester)}</Text></Box>
                <Box width={38}><Text bold={idx === cursor}>{summarize(a)}</Text></Box>
                <Text dimColor>{relativeTime(a.time)}</Text>
              </Box>
            );
          })}
        </Box>
      )}
      <Footer
        hints={[
          ['↑/↓ j/k', 'move'],
          ['↵', 'detail'],
          ['v', 'validate/attest'],
          ['r', 'refresh'],
          ['esc', 'back'],
        ]}
      />
    </Box>
  );
}

