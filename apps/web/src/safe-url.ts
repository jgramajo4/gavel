/**
 * The one place that decides whether an advocate-supplied URL may become a
 * live `href`.
 *
 * Evidence URLs and Markdown link destinations are both untrusted strings. The
 * server validates them at submission time, but that is not a reason for the
 * browser to trust whatever a response hands back: a mistaken 200, a future
 * endpoint, or a changed projection must not be able to turn `javascript:` into
 * a click handler. Re-validating at render time costs nothing and closes that
 * class of bug permanently.
 */

/** Returns the URL unchanged when it parses and is exactly HTTPS, else null. */
export function httpsUrlOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  // `protocol` is already lowercased by the URL parser, so a `JavaScript:`
  // spelling cannot slip past this comparison.
  if (parsed.protocol !== 'https:' || !parsed.hostname) return null;
  return value;
}

export function isHttpsUrl(value: unknown): boolean {
  return httpsUrlOrNull(value) !== null;
}
