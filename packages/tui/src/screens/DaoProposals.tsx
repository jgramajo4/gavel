/**
 * One DAO's proposals.
 *
 * The same data as the inbox, filtered. It is a scoped view rather than a
 * separate screen with its own fetching, which is what keeps "open a DAO" from
 * quietly becoming "a different application for that DAO".
 *
 * Column labels come from the DAO catalog, so a Railgun row says "Staked
 * voting power" where a Nouns row says "Votes".
 */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { daoTerm, findDaoDescriptor } from '@gavel/core';
import { useInbox } from '../hooks/useInbox.js';
import { useIdle } from '../hooks/useIdle.js';
import { StatusBadge, Bar, Header, Footer, ErrorLine } from '../components/common.js';
import { truncate, formatVotes, timeRemaining } from '../utils/format.js';
import { POLL_INTERVALS } from '../constants.js';
import type { Route } from '../navigation.js';

const PAGE = 12;

export function DaoProposals({
  dao,
  navigate,
  onBack,
}: {
  dao: string;
  navigate: (r: Route) => void;
  onBack: () => void;
}) {
  const idle = useIdle(POLL_INTERVALS.idleTimeout);
  const { proposals, failures, loading, refresh } = useInbox(true, idle);
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);

  const descriptor = findDaoDescriptor(dao);
  const mine = proposals.filter((proposal) => proposal.dao === dao);
  const failure = failures.find((entry) => entry.dao === dao);

  useInput((input, key) => {
    if (key.escape || input === 'q' || key.leftArrow || input === 'h') {
      onBack();
    } else if (key.downArrow || input === 'j') {
      setCursor((c) => {
        const next = Math.min(Math.max(mine.length - 1, 0), c + 1);
        if (next >= offset + PAGE) setOffset((o) => o + 1);
        return next;
      });
    } else if (key.upArrow || input === 'k') {
      setCursor((c) => {
        const next = Math.max(0, c - 1);
        if (next < offset) setOffset((o) => Math.max(0, o - 1));
        return next;
      });
    } else if (key.return) {
      const proposal = mine[cursor];
      if (proposal) navigate({ screen: 'detail', proposal });
    } else if (input === 'r') {
      void refresh();
    } else if (input === 'd' && descriptor?.capabilities.delegation) {
      navigate({ screen: 'delegateLookup', dao });
    }
  });

  const visible = mine.slice(offset, offset + PAGE);

  return (
    <Box flexDirection="column">
      <Header
        title={`${descriptor?.displayName ?? dao} proposals`}
        subtitle={`${mine.length} proposals · ${descriptor?.network ?? 'unknown network'} · ${daoTerm(dao, 'votingPower')}`}
      />
      {failure ? (
        <ErrorLine message={`${descriptor?.displayName ?? dao} indexer unavailable: ${failure.message}`} />
      ) : loading && mine.length === 0 ? (
        <Text>
          <Spinner type="dots" /> Loading proposals…
        </Text>
      ) : (
        <Box flexDirection="column">
          {visible.map((proposal, i) => (
            <Box key={proposal.key}>
              <Box width={2}>
                <Text color="cyan">{offset + i === cursor ? '›' : ' '}</Text>
              </Box>
              <Box width={8}>
                <Text dimColor>#{truncate(proposal.id, 6)}</Text>
              </Box>
              <Box width={34}>
                <Text bold={offset + i === cursor}>{truncate(proposal.title, 32)}</Text>
              </Box>
              <Box width={12}>
                <StatusBadge status={proposal.status} />
              </Box>
              <Box width={18}>
                <Text>
                  <Text color="green">{formatVotes(proposal.forVotes)}</Text>
                  <Text dimColor> / </Text>
                  <Text color="red">{formatVotes(proposal.againstVotes)}</Text>
                </Text>
              </Box>
              <Box width={14}>
                <Bar value={proposal.forVotes} total={proposal.quorumVotes} width={8} />
              </Box>
              <Box>
                <Text dimColor>{timeRemaining(proposal.endTimestamp)}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}
      <Footer
        hints={[
          ['↑/↓ j/k', 'move'],
          ['↵', 'open'],
          ['r', 'refresh'],
          ...(descriptor?.capabilities.delegation
            ? [[ 'd', daoTerm(dao, 'delegate').toLowerCase()] as [string, string]]
            : []),
          ['esc', 'back'],
        ]}
      />
    </Box>
  );
}
