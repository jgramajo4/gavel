/** Screen 2 — Proposal Detail + Prediction Panel + Vote. */
import React, { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useProposalDetail } from '../hooks/useProposalDetail.js';
import { useIdle } from '../hooks/useIdle.js';
import { PredictionPanel } from '../components/PredictionPanel.js';
import { VoteFlow } from '../components/VoteFlow.js';
import { StatusBadge, Bar, Header, Footer, Field } from '../components/common.js';
import { formatVotes, shortAddress, relativeTime, timeRemaining } from '../utils/format.js';
import { POLL_INTERVALS } from '../constants.js';
import type { Proposal } from '../types.js';

const DESC_LINES = 8;

export function ProposalDetail({
  proposal,
  onBack,
}: {
  proposal: Proposal;
  onBack: () => void;
}) {
  const idle = useIdle(POLL_INTERVALS.idleTimeout);
  const { tally, status, lastUpdated, error, terminal } = useProposalDetail(proposal, idle);
  const [descScroll, setDescScroll] = useState(0);
  const [voting, setVoting] = useState(false);
  const predictionRefresh = useRef<(() => void) | null>(null);

  const descLines = (proposal.description || '(no description)').split('\n');
  const maxScroll = Math.max(0, descLines.length - DESC_LINES);
  const canVote = status === 'ACTIVE' || status === 'OBJECTION_PERIOD';

  useInput((input, key) => {
    if (voting) return;
    if (key.escape || input === 'q' || key.leftArrow || input === 'h') {
      onBack();
    } else if (key.downArrow || input === 'j') {
      setDescScroll((s) => Math.min(maxScroll, s + 1));
    } else if (key.upArrow || input === 'k') {
      setDescScroll((s) => Math.max(0, s - 1));
    } else if (input === 'r') {
      predictionRefresh.current?.();
    } else if ((input === 'v' || key.return) && canVote) {
      setVoting(true);
    }
  });

  const staleness = lastUpdated ? relativeTime(Math.floor(lastUpdated / 1000)) : '…';

  return (
    <Box flexDirection="column">
      <Header
        title={`Proposal ${proposal.id}`}
        subtitle={terminal ? 'finished — static (no polling)' : `live · updated ${staleness}${idle ? ' · idle' : ''}`}
      />
      <Box>
        <Text bold>{proposal.title}</Text>
      </Box>
      <Box marginBottom={1}>
        <Box marginRight={2}>
          <StatusBadge status={status} />
        </Box>
        <Text dimColor>proposer </Text>
        <Text>{shortAddress(proposal.proposer)}</Text>
        <Text dimColor>  ·  {timeRemaining(proposal.endTimestamp)}</Text>
      </Box>

      {/* Tally */}
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Box width={12}><Text color="green">For</Text></Box>
          <Box width={10}><Text>{formatVotes(tally.forVotes)}</Text></Box>
          <Bar value={tally.forVotes} total={tally.quorumVotes} width={20} color="green" />
        </Box>
        <Box>
          <Box width={12}><Text color="red">Against</Text></Box>
          <Box width={10}><Text>{formatVotes(tally.againstVotes)}</Text></Box>
          <Bar value={tally.againstVotes} total={tally.quorumVotes} width={20} color="red" />
        </Box>
        <Box>
          <Box width={12}><Text dimColor>Abstain</Text></Box>
          <Box width={10}><Text>{formatVotes(tally.abstainVotes)}</Text></Box>
        </Box>
        <Field label="quorum">{formatVotes(tally.quorumVotes)} needed</Field>
      </Box>

      {/* Description (scrollable) */}
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
        <Text dimColor>
          Description {maxScroll > 0 ? `(${descScroll + 1}-${Math.min(descLines.length, descScroll + DESC_LINES)}/${descLines.length}, j/k to scroll)` : ''}
        </Text>
        {descLines.slice(descScroll, descScroll + DESC_LINES).map((line, i) => (
          <Text key={i}>{line || ' '}</Text>
        ))}
      </Box>

      {/* Prediction */}
      <PredictionPanel
        proposalId={proposal.id}
        proposalText={`${proposal.title}\n\n${proposal.description}`}
        bindRefresh={(fn) => {
          predictionRefresh.current = fn;
        }}
      />

      {error ? (
        <Text color="yellow" dimColor>
          ⚠ tally refresh failed: {error}
        </Text>
      ) : null}

      {voting ? (
        <Box marginTop={1}>
          <VoteFlow proposalId={proposal.id} onExit={() => setVoting(false)} />
        </Box>
      ) : (
        <Footer
          hints={[
            ['j/k', 'scroll desc'],
            ['r', 'refresh prediction'],
            ...(canVote ? [['v/↵', 'vote'] as [string, string]] : []),
            ['esc', 'back'],
          ]}
        />
      )}
    </Box>
  );
}

