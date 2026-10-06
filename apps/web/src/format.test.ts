import { describe, expect, it } from 'vitest';
import { formatDateTime, formatExpiryDateTime, formatTimestamp, shortenAddress } from './format';

describe('shortenAddress', () => {
  it('keeps the first four and last two bytes, and nothing between them', () => {
    expect(shortenAddress('0x650C1B4D2f5B9e3a0f8C7d6E5a4B3c2d1E0f50E1')).toBe('0x650C…50E1');
  });

  it('is short enough to sit in a header without truncation', () => {
    expect(shortenAddress('0x650C1B4D2f5B9e3a0f8C7d6E5a4B3c2d1E0f50E1')).toHaveLength(11);
  });

  it('leaves anything that is not a 20-byte address exactly as it found it', () => {
    // Never invent an ellipsis for a value that is not an address: a mangled
    // identifier is worse than a long one.
    expect(shortenAddress('voter.eth')).toBe('voter.eth');
    expect(shortenAddress('0x1234')).toBe('0x1234');
    expect(shortenAddress('')).toBe('');
  });
});

describe('formatDateTime', () => {
  it('renders a human-readable UTC instant instead of an ISO string', () => {
    expect(formatDateTime('2026-09-19T11:42:47.000Z')).toBe('19 Sep 2026, 11:42 UTC');
    expect(formatDateTime('2026-09-16T09:45:00.000Z')).toBe('16 Sep 2026, 09:45 UTC');
  });

  it('pads hours and minutes so a column of times stays aligned', () => {
    expect(formatDateTime('2026-01-02T04:05:00.000Z')).toBe('2 Jan 2026, 04:05 UTC');
  });

  it('accepts epoch milliseconds as well as an ISO string', () => {
    expect(formatDateTime(Date.UTC(2026, 8, 19, 11, 42, 47))).toBe('19 Sep 2026, 11:42 UTC');
  });

  it('shows an em dash rather than guessing at a missing or unreadable value', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
    expect(formatDateTime('')).toBe('—');
    expect(formatDateTime('not a date')).toBe('—');
  });

  it('is independent of the machine locale and time zone', () => {
    // Built by hand rather than through Intl, so CI, a laptop in Buenos Aires,
    // and a recording rig in Lisbon all render the same card.
    const original = process.env.TZ;
    try {
      process.env.TZ = 'Pacific/Kiritimati';
      expect(formatDateTime('2026-09-16T09:45:00.000Z')).toBe('16 Sep 2026, 09:45 UTC');
    } finally {
      process.env.TZ = original;
    }
  });

  it('leaves the exact instant available through formatTimestamp', () => {
    expect(formatTimestamp('2026-09-16T09:45:00.000Z')).toBe('2026-09-16T09:45:00.000Z');
  });
});

describe('formatExpiryDateTime', () => {
  it('reads the signed message Unix seconds', () => {
    expect(formatExpiryDateTime('1793577600')).toBe(formatDateTime(1793577600 * 1000));
  });

  it('refuses a value it cannot read', () => {
    expect(formatExpiryDateTime('later')).toBe('—');
  });
});
