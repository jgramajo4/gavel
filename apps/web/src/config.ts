/**
 * The one place Gavel Web learns where its services live.
 *
 * Two services, two origins — they are genuinely different deployments:
 *
 *   VITE_GAVEL_GATE_API_URL   Gate API (auth, profiles, quotes, settlement, inbox)
 *   VITE_GAVEL_INDEX_API_URL  Governance Indexer (public, read-only DAO data)
 *
 * Plus the canonical public frontend origin, used for absolute links only:
 *
 *
 * Rules:
 *  - A production build refuses to start without both API origins. There is no
 *    fallback to a historical or staging host, and no "same origin" guess:
 *    a missing variable is a deployment defect and must fail loudly.
 *  - In development (and tests) an absent API origin means same-origin, so a
 *    Vite dev proxy or a local server works with no configuration.
 *  - Values must be bare origins (scheme + host [+ port]); a path, query,
 *    fragment, or credential is refused. Production requires HTTPS.
 *  - Nothing here is secret. Frontend env vars are compiled into the bundle.
 */

export interface GavelWebConfig {
  /** Gate API origin, or '' for same-origin (development only). */
  gateApiUrl: string;
  /** Governance Indexer origin, or '' for same-origin (development only). */
  indexApiUrl: string;
  /** Canonical public frontend origin, or null when not configured. */
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface RawEnv {
  VITE_GAVEL_GATE_API_URL?: string;
  VITE_GAVEL_INDEX_API_URL?: string;
  /** Removed in Issue 9. Present only so a stale build env fails loudly. */
  VITE_GATE_API_URL?: string;
}

/** localhost, *.localhost, 127.0.0.0/8, ::1, and 0.0.0.0: never reachable as a visitor's API. */
function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127(\.\d{1,3}){3}$/.test(host) ||
    host === '::1' ||
    host === '0.0.0.0'
  );
}

function origin(name: string, value: string | undefined, production: boolean): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConfigError(`${name} must be an absolute origin such as https://example.com.`);
  }
  const bare = parsed.origin;
  const withoutSlash = trimmed.replace(/\/$/, '');
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    withoutSlash !== bare
  ) {
    throw new ConfigError(`${name} must be a bare origin with no path, query, fragment, or credentials.`);
  }
  if (production && parsed.protocol !== 'https:') {
    throw new ConfigError(`${name} must use HTTPS in a production build.`);
  }
  if (production && isLoopback(parsed.hostname)) {
    throw new ConfigError(`${name} must not be a loopback host in a production build.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConfigError(`${name} must be an http(s) origin.`);
  }
  return bare;
}

export function resolveConfig(env: RawEnv, { production }: { production: boolean }): GavelWebConfig {
  if (env.VITE_GATE_API_URL !== undefined && env.VITE_GATE_API_URL !== '') {
    // Silently ignoring the old name would ship a bundle that talks to
    // same-origin while the operator believes it targets their API.
    throw new ConfigError(
      'VITE_GATE_API_URL was renamed to VITE_GAVEL_GATE_API_URL in Issue 9. Rename it in the build environment.',
    );
  }
  const gate = origin('VITE_GAVEL_GATE_API_URL', env.VITE_GAVEL_GATE_API_URL, production);
  const index = origin('VITE_GAVEL_INDEX_API_URL', env.VITE_GAVEL_INDEX_API_URL, production);
  if (production) {
    const missing = [!gate && 'VITE_GAVEL_GATE_API_URL', !index && 'VITE_GAVEL_INDEX_API_URL'].filter(Boolean);
    if (missing.length > 0) {
      throw new ConfigError(`Production build is missing ${missing.join(' and ')}.`);
    }
  }
  return { gateApiUrl: gate ?? '', indexApiUrl: index ?? '' };
}
