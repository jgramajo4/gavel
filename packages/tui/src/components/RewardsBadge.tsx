/**
 * Nouns client rewards.
 *
 * Deliberately gated on Nouns being followed. This is not "Gavel's rewards" --
 * it is the balance accrued to Gavel's Nouns client id, which is meaningless
 * to someone following only ENS, and showing it to them would imply Gavel is a
 * Nouns application with other DAOs attached.
 */
import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { fetchRewardsBalance } from '../data/rewards.js';
import { formatEth } from '../utils/format.js';
import { CLIENT_ID } from '../constants.js';
import { useServices } from '../hooks/AppContext.js';
import type { RewardsBalance } from '../types.js';

export function RewardsBadge() {
  const { publicClient, config } = useServices();
  const followsNouns = config.gavel.followedDaos.includes('nouns');
  const [balance, setBalance] = useState<RewardsBalance | null>(null);

  useEffect(() => {
    if (!followsNouns) return undefined;
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
  }, [publicClient, followsNouns]);

  if (!followsNouns || !balance) return null;
  return (
    <Text dimColor>
      nouns client {CLIENT_ID} · {formatEth(balance.balance)}
      {balance.approved ? '' : ' (pending)'} ·{' '}
    </Text>
  );
}
