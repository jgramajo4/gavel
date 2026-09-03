/**
 * Prediction panel — pass/fail probability from the DistilBERT model with a
 * confidence bar and staleness indicator. Refreshes on demand only.
 */
import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { usePrediction } from '../hooks/usePrediction.js';
import { Bar } from './common.js';
import { relativeTime } from '../utils/format.js';

export function PredictionPanel({
  proposalId,
  proposalText,
  bindRefresh,
}: {
  proposalId: number;
  proposalText: string;
  bindRefresh?: (fn: () => void) => void;
}) {
  const { state, refresh } = usePrediction(proposalId, proposalText);
  React.useEffect(() => {
    bindRefresh?.(() => void refresh());
  }, [bindRefresh, refresh]);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">
        Outcome Prediction
      </Text>
      {state.kind === 'idle' ? (
        <Text dimColor>Press [R] to fetch a prediction.</Text>
      ) : state.kind === 'loading' ? (
        <Text>
          <Spinner type="dots" /> Querying model…
        </Text>
      ) : state.kind === 'cold' ? (
        <Text color="yellow">Space cold-starting — retry in ~30s ([R])</Text>
      ) : state.kind === 'error' ? (
        <Text color="red">✗ {state.message}</Text>
      ) : (
        <Box flexDirection="column">
          <Box>
            <Text bold color={state.prediction.label === 'PASS' ? 'green' : 'red'}>
              {state.prediction.label}
            </Text>
            <Text> · {(state.prediction.passProbability * 100).toFixed(1)}% pass</Text>
          </Box>
          <Bar
            value={Math.round(state.prediction.passProbability * 100)}
            total={100}
            width={24}
            color={state.prediction.label === 'PASS' ? 'green' : 'red'}
          />
          <Text dimColor>
            {state.stale ? 'cached ' : 'fresh · '}
            {relativeTime(Math.floor(state.prediction.fetchedAt / 1000))}
            {state.stale ? ' — [R] to refresh' : ''}
          </Text>
        </Box>
      )}
    </Box>
  );
}

