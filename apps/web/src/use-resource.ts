import { useEffect, useState } from 'react';
import { ApiError, isAbort, type ErrorKind } from './http';

/**
 * Loads data for one entity, identified by `key`.
 *
 * Stale-state rules, enforced here instead of per page:
 *  - The result is tagged with the key it was loaded for. When the key changes
 *    (another DAO, another proposal), the old data is never returned for the
 *    new key; the caller sees `loading` until the new entity resolves.
 *  - Each load gets its own AbortController. Navigating away aborts it, and a
 *    late response for an old key can never overwrite the current one.
 *  - `key === null` means "nothing to load" (for example, an invalid route).
 */
export type Resource<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; kind: ErrorKind; code: string; message: string };

interface Settled<T> {
  key: string;
  value: Resource<T>;
}

export function useResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): Resource<T> {
  const [settled, setSettled] = useState<Settled<T> | null>(null);

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setSettled({ key, value: { status: 'ready', data } });
      },
      (cause: unknown) => {
        if (controller.signal.aborted || isAbort(cause)) return;
        const value: Resource<T> =
          cause instanceof ApiError
            ? { status: 'error', kind: cause.kind, code: cause.code, message: cause.message }
            : { status: 'error', kind: 'defect', code: 'UNEXPECTED', message: 'Something went wrong loading this.' };
        setSettled({ key, value });
      },
    );
    return () => controller.abort();
    // `load` is expected to be derived from `key`; the key alone decides reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (key === null) return { status: 'idle' };
  if (!settled || settled.key !== key) return { status: 'loading' };
  return settled.value;
}
