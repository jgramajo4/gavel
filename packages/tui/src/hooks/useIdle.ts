/**
 * Idle detection. Returns true once no keypress has occurred for `timeoutMs`.
 * Consumers pause polling while idle; any keypress resets the timer.
 */
import { useEffect, useState } from 'react';
import { useStdin } from 'ink';

export function useIdle(timeoutMs: number): boolean {
  const [idle, setIdle] = useState(false);
  const { stdin, isRawModeSupported } = useStdin();

  useEffect(() => {
    if (!stdin || !isRawModeSupported) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), timeoutMs);
    };
    reset();
    stdin.on('data', reset);
    return () => {
      clearTimeout(timer);
      stdin.off('data', reset);
    };
  }, [stdin, isRawModeSupported, timeoutMs]);

  return idle;
}

