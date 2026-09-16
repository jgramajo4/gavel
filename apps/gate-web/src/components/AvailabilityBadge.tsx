import type { Availability } from '../types';

const LABELS: Record<Availability, string> = {
  accepting_now: 'Accepting now',
  paused: 'Paused',
  closed: 'Closed',
};

/**
 * Availability is a server-owned fact. `acceptingSubmissions` is the only thing
 * that governs whether a paid pitch can be composed — never voting power, and
 * never an availability value the browser reinterprets on its own.
 */
export function AvailabilityBadge({
  availability,
  acceptingSubmissions,
}: {
  availability: Availability;
  acceptingSubmissions: boolean;
}) {
  const state = acceptingSubmissions ? 'accepting_now' : availability;
  return (
    <span className={`badge availability availability-${state}`} data-availability={state}>
      {acceptingSubmissions ? LABELS.accepting_now : LABELS[availability]}
    </span>
  );
}
