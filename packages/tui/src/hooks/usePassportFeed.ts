/** Passport feed state — EAS GraphQL, on-demand refresh. */
import { useCallback, useEffect, useState } from 'react';
import { fetchPassportFeed } from '../data/eas.js';
import type { Attestation } from '../types.js';
import { useServices } from './AppContext.js';

export function usePassportFeed() {
  const { config } = useServices();
  const [items, setItems] = useState<Attestation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const feed = await fetchPassportFeed(config);
      setItems(feed);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [config]);

  useEffect(() => {
    void load();
  }, [load]);

  return { items, loading, error, refresh: load };
}

