/**
 * Home: the unified governance inbox.
 *
 * Two sections, in the order a user needs them: what wants a decision, then
 * what is being followed. Every row names its DAO, because the failure mode
 * that matters most in a merged inbox is acting on the wrong governance
 * system.
 *
 * A DAO that could not be read appears in "Following" with its error, rather
 * than disappearing or turning the whole screen into a failure. One unreachable
 * indexer is one degraded row.
 */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useInbox } from '../hooks/useInbox.js';
import { useIdle } from '../hooks/useIdle.js';
import { Header, Footer, StatusBadge } from '../components/common.js';
import { truncate, timeRemaining, relativeTime } from '../utils/format.js';
import { POLL_INTERVALS } from '../constants.js';
import { useServices } from '../hooks/AppContext.js';
import type { Route } from '../navigation.js';

const PAGE = 10;

const ATTENTION_LABEL: Record<string, string> = {
  EXECUTION_REQUIRED: 'needs execution',
  VOTING_ENDS_SOON: 'ends soon',
  VOTE_OPEN: 'voting open',
  NEW_PROPOSAL: 'new proposal',
  VOTING_OPENS_SOON: 'opens soon',
};

export function Inbox({ navigate }: { navigate: (r: Route) => void }) {
  const idle = useIdle(POLL_INTERVALS.idleTimeout);
  const { config } = useServices();
  const { inbox, proposals, loading, lastUpdated, refresh } = useInbox(true, idle);
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);

  const rows = inbox.needsAttention;

  useInput((input, key) => {
    if (key.downArrow || input === 'j') {
      setCursor((c) => {
        const next = Math.min(Math.max(rows.length - 1, 0), c + 1);
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
      const entry = rows[cursor];
      const proposal = entry && proposals.find((p) => p.key === entry.key);
      if (proposal) navigate({ screen: 'detail', proposal });
    } else if (input === 'r') {
      void refresh();
    } else if (input === 'f') {
      // Filter into one DAO: the same data, scoped, not a different app.
      const entry = rows[cursor];
      const dao = entry?.dao ?? config.gavel.followedDaos[0];
      if (dao) navigate({ screen: 'daoProposals', dao });
    } else if (input === 's') {
      navigate({ screen: 'settings' });
    }
  });

  const visible = rows.slice(offset, offset + PAGE);
  const staleness = lastUpdated ? relativeTime(Math.floor(lastUpdated / 1000)) : 'never';

  return (
    <Box flexDirection="column">
      <Header
        title="Governance inbox"
        subtitle={`${inbox.counts.needsAttention} need attention · ${inbox.counts.followed} DAOs · updated ${staleness}${idle ? ' · idle' : ''}`}
      />

      {config.gavel.followedDaos.length === 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="yellow">You are not following any DAOs yet.</Text>
          <Text dimColor>Press s to open Settings and choose which DAOs Gavel should follow.</Text>
        </Box>
      ) : null}

      <Text bold>Needs attention</Text>
      {loading && rows.length === 0 ? (
        <Text>
          <Spinner type="dots" /> Reading followed DAOs…
        </Text>
      ) : rows.length === 0 ? (
        <Text dimColor>  Nothing waiting on you right now.</Text>
      ) : (
        <Box flexDirection="column">
          {visible.map((entry, i) => (
            <Box key={entry.key}>
              <Box width={2}>
                <Text color="cyan">{offset + i === cursor ? '›' : ' '}</Text>
              </Box>
              <Box width={18}>
                <Text bold={offset + i === cursor}>{entry.label}</Text>
              </Box>
              <Box width={34}>
                <Text>{truncate(entry.title, 32)}</Text>
              </Box>
              <Box width={14}>
                <Text color="yellow">{ATTENTION_LABEL[entry.attention ?? ''] ?? ''}</Text>
              </Box>
              <Box>
                <Text dimColor>{entry.endsAt ? timeRemaining(entry.endsAt) : '—'}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text bold>Following</Text>
        {inbox.daos.map((dao) => (
          <Box key={dao.dao}>
            <Box width={14}>
              <Text>{dao.displayName}</Text>
            </Box>
            <Box width={16}>
              {dao.available ? (
                <Text dimColor>{dao.active} active</Text>
              ) : (
                <Text color="red">unavailable</Text>
              )}
            </Box>
            <Text dimColor>{dao.available ? '' : dao.error}</Text>
          </Box>
        ))}
      </Box>

      <Footer
        hints={[
          ['↑/↓ j/k', 'move'],
          ['↵', 'open'],
          ['f', 'filter by DAO'],
          ['r', 'refresh'],
          ['s', 'settings'],
          ['q', 'quit'],
        ]}
      />
    </Box>
  );
}

/** Re-exported for the DAO-scoped view, which is the same screen filtered. */
export { StatusBadge };
