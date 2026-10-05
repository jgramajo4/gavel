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

/**
 * The exact instant, ISO-8601. This is the machine value: it is used as the
 * `title` behind a human-readable time, never as the text a person reads.
 */
export function formatTimestamp(value: string | number | undefined | null): string {
  if (value === undefined || value === null || value === '') return '—';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString();
}

export function shortenAddress(address: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A human-readable instant for people, e.g. `16 Sep 2026, 09:45 UTC`.
 *
 * Raw ISO-8601 is a machine format; a voter deciding whether a price is current
 * should not have to parse `2026-09-19T11:42:47.000Z`. It is built by hand
 * rather than through `Intl` so the string is identical on every machine, ICU
 * build, locale, and CI runner — a directory card that renders differently per
 * viewer is a screenshot bug waiting to happen.
 *
 * UTC is explicit and labelled: an "as of" a voter cannot place in time is
 * worse than no timestamp. `formatTimestamp` still returns the exact ISO value
 * and is used as the `title`, so the precise instant is never lost.
 */
export function formatDateTime(value: string | number | undefined | null): string {
  if (value === undefined || value === null || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${hours}:${minutes} UTC`;
}

/** Quote expiry is a Unix-second string in the signed message. */
export function formatExpiryDateTime(unixSeconds: string): string {
  const seconds = Number(unixSeconds);
  if (!Number.isFinite(seconds)) return '—';
  return formatDateTime(seconds * 1000);
}
