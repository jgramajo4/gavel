/** Screen 1 — Proposal List (home). Scrollable, active-first. */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useProposals } from '../hooks/useProposals.js';
import { useIdle } from '../hooks/useIdle.js';
import { StatusBadge, Bar, Header, Footer, ErrorLine } from '../components/common.js';
import { truncate, formatVotes, timeRemaining, relativeTime } from '../utils/format.js';
import { POLL_INTERVALS } from '../constants.js';
import type { Proposal } from '../types.js';
import type { Route } from '../navigation.js';

const PAGE = 12;

function Row({ proposal, selected }: { proposal: Proposal; selected: boolean }) {
  const totalFor = proposal.forVotes;
  const quorum = proposal.quorumVotes;
  return (
    <Box>
      <Box width={2}>
        <Text color="cyan">{selected ? '›' : ' '}</Text>
      </Box>
      <Box width={5}>
        <Text dimColor>{proposal.id}</Text>
      </Box>
      <Box width={36}>
        <Text bold={selected}>{truncate(proposal.title, 34)}</Text>
      </Box>
      <Box width={12}>
        <StatusBadge status={proposal.status} />
      </Box>
      <Box width={20}>
        <Text>
          <Text color="green">{formatVotes(proposal.forVotes)}</Text>
          <Text dimColor> / </Text>
          <Text color="red">{formatVotes(proposal.againstVotes)}</Text>
        </Text>
      </Box>
      <Box width={16}>
        <Bar value={totalFor} total={quorum} width={8} />
      </Box>
      <Box>
        <Text dimColor>{timeRemaining(proposal.endTimestamp)}</Text>
      </Box>
    </Box>
  );
}

export function ProposalList({ navigate }: { navigate: (r: Route) => void }) {
  const idle = useIdle(POLL_INTERVALS.idleTimeout);
  const { proposals, loading, error, lastUpdated, refresh } = useProposals(true, idle);
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);

  useInput((input, key) => {
    if (loading && proposals.length === 0) return;
    if (key.downArrow || input === 'j') {
      setCursor((c) => {
        const next = Math.min(proposals.length - 1, c + 1);
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
      const p = proposals[cursor];
      if (p) navigate({ screen: 'detail', proposal: p });
    } else if (input === 'r') {
      void refresh();
    } else if (input === 'd') {
      navigate({ screen: 'delegateLookup' });
    } else if (input === 'p') {
      navigate({ screen: 'passportFeed' });
    }
  });

  const visible = proposals.slice(offset, offset + PAGE);
  const staleness = lastUpdated ? relativeTime(Math.floor(lastUpdated / 1000)) : 'never';

  return (
    <Box flexDirection="column">
      <Header
        title="Proposals"
        subtitle={`${proposals.length} proposals · updated ${staleness}${idle ? ' · idle (polling paused)' : ''}`}
      />
      {loading && proposals.length === 0 ? (
        <Text>
          <Spinner type="dots" /> Loading proposals…
        </Text>
      ) : error && proposals.length === 0 ? (
        <ErrorLine message={error} />
      ) : (
        <Box flexDirection="column">
          {visible.map((p, i) => (
            <Row key={p.id} proposal={p} selected={offset + i === cursor} />
          ))}
        </Box>
      )}
      {error && proposals.length > 0 ? (
        <Text dimColor color="yellow">
          ⚠ refresh failed: {error}
        </Text>
      ) : null}
      <Footer
        hints={[
          ['↑/↓ j/k', 'move'],
          ['↵', 'open'],
          ['r', 'refresh'],
          ['d', 'delegates'],
          ['p', 'passport'],
          ['q', 'quit'],
        ]}
      />
    </Box>
  );
}

