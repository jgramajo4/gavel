/** Small shared presentational components. */
import React from 'react';
import { Box, Text } from 'ink';
import type { ProposalStatus } from '../types.js';
import { statusColor } from '../utils/format.js';

export function StatusBadge({ status }: { status: ProposalStatus }) {
  return (
    <Text color={statusColor(status)} bold>
      {status.replace('_', ' ')}
    </Text>
  );
}

/** Colored quorum/vote progress bar. */
export function Bar({
  value,
  total,
  width = 20,
  color = 'green',
}: {
  value: bigint | number;
  total: bigint | number;
  width?: number;
  color?: string;
}) {
  const v = Number(value);
  const t = Number(total);
  const ratio = t <= 0 ? 0 : Math.min(1, Math.max(0, v / t));
  const filled = Math.round(ratio * width);
  return (
    <Text>
      <Text color={color}>{'█'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(Math.max(0, width - filled))}</Text>
      <Text> {Math.round(ratio * 100)}%</Text>
    </Text>
  );
}

export function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="magenta" bold>
          ⚖  Gavel
        </Text>
        <Text dimColor> · {title}</Text>
      </Box>
      {subtitle ? <Text dimColor>{subtitle}</Text> : null}
    </Box>
  );
}

export function Footer({ hints }: { hints: Array<[string, string]> }) {
  return (
    <Box marginTop={1}>
      <Text dimColor>
        {hints.map(([key, label], i) => (
          <Text key={key}>
            {i > 0 ? '  ' : ''}
            <Text color="cyan">{key}</Text> {label}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

export function ErrorLine({ message }: { message: string }) {
  return (
    <Text color="red">
      ✗ {message}
    </Text>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Box width={16}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{children}</Text>
    </Box>
  );
}

