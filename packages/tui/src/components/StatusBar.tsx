/**
 * The global status line.
 *
 * DAO-agnostic by construction: it shows the followed DAOs, the wallet
 * connection and the execution mode, and nothing that belongs to one
 * governance system. The Nouns client-rewards read that used to live here is
 * now a Nouns-only badge, rendered only when Nouns is actually followed --
 * because a client id and a rewards balance are Nouns concepts, not Gavel ones.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { daoDisplayName } from '@gavel/core';
import { useServices } from '../hooks/AppContext.js';
import { RewardsBadge } from './RewardsBadge.js';

const WALLET_ICON: Record<string, string> = {
  'read-only': '👁',
  local: '🔑',
  walletconnect: '🔗',
};

export function StatusBar() {
  const { config, wallet } = useServices();
  const followed = config.gavel.followedDaos;

  return (
    <Box justifyContent="space-between">
      <Text dimColor>
        {followed.length === 0 ? (
          <Text color="yellow">no DAOs followed</Text>
        ) : (
          <Text>{followed.map((dao) => daoDisplayName(dao)).join(' · ')}</Text>
        )}
        <Text dimColor> · {config.gavel.execution.mode}</Text>
      </Text>
      <Text dimColor>
        <RewardsBadge />
        {WALLET_ICON[wallet.type] ?? '•'} {wallet.label}
        {wallet.address ? <Text> {wallet.address}</Text> : null}
        {wallet.sessionExpired ? <Text color="yellow"> (session expired)</Text> : null}
      </Text>
    </Box>
  );
}
