/**
 * Adaptive polling. Runs `fn` on an interval, pausing when `enabled` is false
 * (navigation away, idle, terminal proposal). Pure client-side setInterval — no
 * background process, no external state.
 */
import { useEffect, useRef } from 'react';

export function usePolling(
  fn: () => void | Promise<void>,
  intervalMs: number,
  enabled: boolean,
): void {
  const saved = useRef(fn);
  saved.current = fn;

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void saved.current();
    };
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs, enabled]);
}

