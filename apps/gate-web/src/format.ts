/**
 * Display helpers. Amounts are USDC atomic units as decimal strings; they are
 * formatted with exact integer arithmetic so a price is never rounded through a
 * float on its way to a human deciding whether to pay it.
 */

const USDC_DECIMALS = 6n;
const USDC_SCALE = 10n ** USDC_DECIMALS;

export function formatUsdc(atomic: string): string {
  let value: bigint;
  try {
    value = BigInt(atomic);
  } catch {
    return '—';
  }
  const whole = value / USDC_SCALE;
  const fraction = (value % USDC_SCALE).toString().padStart(Number(USDC_DECIMALS), '0');
  // Two decimals is the display minimum; extra precision is kept when present.
  const trimmed = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `${whole.toString()}.${trimmed} USDC`;
}

export function sumAtomic(...amounts: string[]): string {
  try {
    return amounts.reduce((total, amount) => total + BigInt(amount), 0n).toString();
  } catch {
    return '0';
  }
}

export function formatTimestamp(value: string | number | undefined | null): string {
  if (value === undefined || value === null || value === '') return '—';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString();
}

/** Quote expiry is a Unix-second string in the signed message. */
export function formatExpiry(unixSeconds: string): string {
  const seconds = Number(unixSeconds);
  if (!Number.isFinite(seconds)) return '—';
  return formatTimestamp(seconds * 1000);
}

export function shortenAddress(address: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
