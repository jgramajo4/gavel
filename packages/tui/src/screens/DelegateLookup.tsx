/**
 * Delegate lookup, scoped to one DAO.
 *
 * Labels come from the DAO catalog, because the quantity differs: Nouns shows
 * "Votes" and a delegation target, Railgun shows staked power behind a voting
 * key. A single screen calling all of them "voting power" would be wrong for
 * at least two of the three.
 *
 * History comes from the DAO's own source, so a DAO with no direct source says
 * so rather than rendering another DAO's votes.
 */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { useDelegate } from '../hooks/useDelegate.js';
import { useServices } from '../hooks/AppContext.js';
import { Header, Footer, Field, ErrorLine } from '../components/common.js';
import { daoTerm, findDaoDescriptor } from '@gavel/core';
import { hasChainReader } from '../chain/daoReaders.js';
import { shortAddress, formatVotes } from '../utils/format.js';
import type { VoteSupport } from '../types.js';
import type { Route } from '../navigation.js';

const SUPPORT_TEXT: Record<VoteSupport, { label: string; color: string }> = {
  0: { label: 'AGAINST', color: 'red' },
  1: { label: 'FOR', color: 'green' },
  2: { label: 'ABSTAIN', color: 'gray' },
};

export function DelegateLookup({
  dao,
  navigate,
  onBack,
}: {
  dao: string;
  navigate: (r: Route) => void;
  onBack: () => void;
}) {
  const { signer, wallet } = useServices();
  const { state, lookup } = useDelegate(dao);
  const descriptor = findDaoDescriptor(dao);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(true);

  useInput((input, key) => {
    if (editing) return;
    if (key.escape || input === 'q') onBack();
    else if (input === '/') setEditing(true);
    else if (input === 's' && state.kind === 'ready' && hasChainReader(dao)) {
      navigate({ screen: 'delegateSwitch', dao });
    }
  });

  const isSelf =
    state.kind === 'ready' &&
    signer &&
    state.info.address.toLowerCase() === signer.address.toLowerCase();

  return (
    <Box flexDirection="column">
      <Header
        title={`${descriptor?.displayName ?? dao} · ${daoTerm(dao, 'delegate')}`}
        subtitle={`search by ENS name or address · shows ${daoTerm(dao, 'votingPower').toLowerCase()}`}
      />
      <Box>
        <Text color="cyan">search › </Text>
        {editing ? (
          <TextInput
            value={query}
            onChange={setQuery}
            onSubmit={(val) => {
              setEditing(false);
              if (val.trim()) void lookup(val.trim());
            }}
            placeholder={wallet.address ?? 'vitalik.eth'}
          />
        ) : (
          <Text dimColor>{query || '(empty)'} — press / to edit</Text>
        )}
      </Box>

      {state.kind === 'loading' && (
        <Box marginTop={1}>
          <Text><Spinner type="dots" /> Looking up…</Text>
        </Box>
      )}
      {state.kind === 'error' && (
        <Box marginTop={1}><ErrorLine message={state.message} /></Box>
      )}
      {state.kind === 'ready' && (
        <Box flexDirection="column" marginTop={1}>
          <Field label="address">
            {state.info.ens ? `${state.info.ens} (${shortAddress(state.info.address)})` : state.info.address}
            {isSelf ? '  ← you' : ''}
          </Field>
          <Field label={state.info.votingPowerLabel.toLowerCase()}>
            {formatVotes(state.info.votingPower)}
          </Field>
          <Field label={state.info.delegationLabel.toLowerCase()}>
            {!state.info.delegatingTo || state.info.delegatingTo.toLowerCase() === state.info.address.toLowerCase()
              ? 'self'
              : shortAddress(state.info.delegatingTo)}
          </Field>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Voting history ({state.info.votes.length})</Text>
            {state.info.votes.length === 0 ? (
              <Text dimColor>  no votes recorded</Text>
            ) : (
              state.info.votes.slice(0, 12).map((v) => (
                <Box key={`${v.proposalKey}-${v.support}`}>
                  <Box width={8}><Text dimColor>#{v.proposalId}</Text></Box>
                  <Box width={10}>
                    <Text color={SUPPORT_TEXT[v.support].color}>{SUPPORT_TEXT[v.support].label}</Text>
                  </Box>
                  <Box width={12}><Text>{formatVotes(v.votes)} votes</Text></Box>
                  {v.reason ? <Text dimColor>“{v.reason.slice(0, 30)}”</Text> : null}
                </Box>
              ))
            )}
          </Box>
        </Box>
      )}

      <Footer
        hints={[
          ['/', 'search'],
          ...(state.kind === 'ready' ? [['s', 'switch delegate'] as [string, string]] : []),
          ['esc', 'back'],
        ]}
      />
    </Box>
  );
}

