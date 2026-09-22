/**
 * The vote panel.
 *
 * It does not build a transaction. Every Gavel vote originates as a canonical
 * adapter-generated intent -- natural language → governance intent → execution
 * intent → validation → executor -- and a terminal component is not allowed to
 * be a second path around that. So this screen explains what the configured
 * execution mode will do, and hands over the exact canonical command.
 *
 * That is also why the panel is DAO-aware rather than Nouns-shaped: the old
 * flow built `castRefundableVote` with a Nouns client id for every proposal it
 * was shown, which is simply the wrong call for ENS or Railgun.
 */
import React from 'react';
import { Box, Text, useInput } from 'ink';
import { findDaoDescriptor } from '@gavel/core';
import { Field } from './common.js';
import { useServices } from '../hooks/AppContext.js';
import type { Proposal } from '../types.js';

const MODE_EXPLANATION: Record<string, string> = {
  unsigned: 'Gavel validates against live chain state and hands back calldata. Nothing is signed or broadcast.',
  'eoa-supervised': 'Gavel prepares the vote; you approve and sign it in your own wallet.',
  'safe-supervised': 'Gavel proposes the vote into your Safe. Your Safe owners approve and execute it.',
  'waap-autonomous': 'A policy-constrained execution wallet signs and broadcasts, within its configured scope.',
};

export function VoteFlow({ proposal, onExit }: { proposal: Proposal; onExit: () => void }) {
  const { config, wallet } = useServices();
  const descriptor = findDaoDescriptor(proposal.dao);
  const mode = config.gavel.execution.mode;
  const canVote = descriptor?.capabilities.voting === true;

  useInput((input, key) => {
    if (key.escape || key.return || input === 'b') onExit();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Vote · {proposal.label}
      </Text>

      {!canVote ? (
        <Text color="yellow">
          {descriptor?.displayName ?? proposal.dao} voting is not supported by this build's adapter.
        </Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Field label="dao">{descriptor?.displayName ?? proposal.dao}</Field>
          <Field label="chain">{descriptor?.chainId ?? '?'}</Field>
          <Field label="identity">{wallet.address ?? '(none configured)'}</Field>
          <Field label="wallet">{wallet.label}</Field>
          <Field label="execution">{mode}</Field>
          <Box marginTop={1}>
            <Text dimColor>{MODE_EXPLANATION[mode] ?? ''}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Prepare this vote through the canonical path:</Text>
            <Text color="cyan">
              {'  '}gavel execution prepare &lt;prediction.json&gt; &lt;proposal.json&gt; --support FOR
            </Text>
            <Text dimColor>
              {'  '}The adapter re-validates live chain state, so a stored intent is an audit
              artifact and never an authorization.
            </Text>
          </Box>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>[esc] back</Text>
      </Box>
    </Box>
  );
}
