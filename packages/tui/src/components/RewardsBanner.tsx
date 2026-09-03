/** Rewards accumulator banner — reads clientBalance(38); free, so shown early. */
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { fetchRewardsBalance } from '../data/rewards.js';
import { formatEth } from '../utils/format.js';
import { CLIENT_ID } from '../constants.js';
import { useServices } from '../hooks/AppContext.js';
import type { RewardsBalance } from '../types.js';

export function RewardsBanner() {
  const { publicClient, signer } = useServices();
  const [balance, setBalance] = useState<RewardsBalance | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchRewardsBalance(publicClient)
      .then((b) => {
        if (!cancelled) setBalance(b);
      })
      .catch(() => {
        /* rewards read is best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [publicClient]);

  return (
    <Box justifyContent="space-between">
      <Text dimColor>
        clientId <Text color="magenta">{CLIENT_ID}</Text>
        {balance
          ? <Text> · rewards {formatEth(balance.balance)}{balance.approved ? '' : ' (pending DAO approval)'}</Text>
          : <Text> · reading rewards…</Text>}
      </Text>
      <Text dimColor>{signer ? '🔑 wallet connected' : '👁  read-only migration mode'}</Text>
    </Box>
  );
}
