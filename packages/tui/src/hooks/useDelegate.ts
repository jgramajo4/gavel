/**
 * Delegate lookup for one DAO.
 *
 * The DAO is a parameter, not an assumption. Only DAOs with a direct history
 * source are answerable here; anything else reports that plainly instead of
 * returning another DAO's delegation, which is the kind of mistake a merged
 * governance client must never make.
 */
import { useCallback, useState } from 'react';
import { daoTerm, findDaoDescriptor } from '@gavel/core';
import { fetchDelegate } from '../data/subgraph.js';
import { resolveToAddress, lookupEns } from '../data/ens.js';
import type { DelegateInfo } from '../types.js';
import { useServices } from './AppContext.js';

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; info: DelegateInfo }
  | { kind: 'error'; message: string };

export function useDelegate(dao: string) {
  const { config, publicClient } = useServices();
  const [state, setState] = useState<State>({ kind: 'idle' });

  const lookup = useCallback(
    async (query: string) => {
      setState({ kind: 'loading' });
      try {
        const descriptor = findDaoDescriptor(dao);
        if (descriptor?.capabilities.delegation !== true) {
          setState({ kind: 'error', message: `${descriptor?.displayName ?? dao} has no delegation model.` });
          return;
        }
        if (dao !== 'nouns') {
          // Delegation history needs a per-DAO source. Until one is wired,
          // the canonical CLI path is the honest answer.
          setState({
            kind: 'error',
            message: `${descriptor.displayName} delegation history is not available in the TUI yet. ` +
              `Use: gavel prepare-delegation --dao ${dao} --asset-owner-address <address>`,
          });
          return;
        }
        const address = await resolveToAddress(publicClient, query);
        if (!address) {
          setState({ kind: 'error', message: `Could not resolve "${query}" to an address.` });
          return;
        }
        const [sub, ens] = await Promise.all([
          fetchDelegate(config, address),
          lookupEns(publicClient, address),
        ]);
        setState({
          kind: 'ready',
          info: {
            dao,
            address,
            ens: ens ?? undefined,
            votingPower: sub.votingPower,
            votingPowerLabel: daoTerm(dao, 'votingPower'),
            delegatingTo: sub.delegatingTo,
            delegationLabel: daoTerm(dao, 'delegate'),
            votes: sub.votes,
          },
        });
      } catch (err) {
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    },
    [config, publicClient, dao],
  );

  return { state, lookup };
}

