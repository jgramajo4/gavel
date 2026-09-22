/**
 * Prediction state with optimistic stale cache. Loads the cached result
 * instantly (if any); refreshes only on demand — never polled, to avoid
 * hammering the Gradio Space.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  getCachedPrediction,
  fetchPrediction,
  ColdStartError,
} from '../data/prediction.js';
import type { Prediction } from '../types.js';
import { useServices } from './AppContext.js';

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'cold' }
  | { kind: 'ready'; prediction: Prediction; stale: boolean }
  | { kind: 'error'; message: string };

export function usePrediction(proposalKey: string, proposalText: string) {
  const { config } = useServices();
  const [state, setState] = useState<State>({ kind: 'idle' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cached = await getCachedPrediction(config, proposalKey);
      if (!cancelled && cached) {
        setState({ kind: 'ready', prediction: cached, stale: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, proposalKey]);

  const refresh = useCallback(async () => {
    setState((prev) =>
      prev.kind === 'ready'
        ? { kind: 'ready', prediction: prev.prediction, stale: true }
        : { kind: 'loading' },
    );
    try {
      const prediction = await fetchPrediction(config, proposalKey, proposalText);
      setState({ kind: 'ready', prediction, stale: false });
    } catch (err) {
      if (err instanceof ColdStartError) {
        setState({ kind: 'cold' });
      } else {
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    }
  }, [config, proposalKey, proposalText]);

  return { state, refresh };
}

