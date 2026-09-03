/**
 * Delegate lookup — combines the subgraph (voting history + delegated-to) with
 * an on-chain read for current voting power. Second data path in the build order.
 */
import { useCallback, useState } from 'react';
import { fetchDelegate } from '../data/subgraph.js';
import { resolveToAddress, lookupEns } from '../data/ens.js';
import type { DelegateInfo } from '../types.js';
import { useServices } from './AppContext.js';

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; info: DelegateInfo }
  | { kind: 'error'; message: string };

export function useDelegate() {
  const { config, publicClient } = useServices();
  const [state, setState] = useState<State>({ kind: 'idle' });

  const lookup = useCallback(
    async (query: string) => {
      setState({ kind: 'loading' });
      try {
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
            address,
            ens: ens ?? undefined,
            votingPower: sub.votingPower,
            delegatingTo: sub.delegatingTo,
            votes: sub.votes,
          },
        });
      } catch (err) {
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    },
    [config, publicClient],
  );

  return { state, lookup };
}

