/**
 * The shared HTTP boundary for every Gavel service client.
 *
 *   UI component -> domain client (gate-api.ts, index-api.ts) -> requestJson -> configured origin
 *
 * Components never call `fetch` directly and never know a hostname. Domain
 * clients own paths and response shapes; this module owns transport, headers,
 * and the error model so every surface reports failures the same way.
 *
 * Transport invariants (unchanged from the original Gate client):
 *  - `credentials: 'omit'`: no cookie or ambient credential ever rides along.
 *  - `referrerPolicy: 'no-referrer'`.
 *  - A bearer token goes in the Authorization header only, never a URL or log.
 */

/**
 * What a person (or a future surface) should do about a failure.
 *
 *  - `action`      the user must do something: sign in again, switch wallet or
 *                  chain, fix input. Includes 401/403 and most 4xx.
 *  - `not_found`   the thing does not exist (or is not visible to this caller).
 *  - `retryable`   infrastructure: network down, 429, 5xx. Try again later.
 *  - `defect`      the server answered something this client cannot read. A
 *                  bug to report, never content to echo back.
 */
export type ErrorKind = 'action' | 'not_found' | 'retryable' | 'defect';

export type ServiceName = 'gate' | 'index';

export class ApiError extends Error {
  readonly service: ServiceName;
  /** HTTP status, or 0 when the request never got a response. */
  readonly status: number;
  /** Server error code when the server sent one; never flattened away. */
  readonly code: string;
  readonly kind: ErrorKind;
  readonly state?: string;
  readonly body: unknown;

  constructor(
    service: ServiceName,
    status: number,
    code: string,
    message: string,
    body: unknown,
    state?: string,
    kind: ErrorKind = classify(status, code),
  ) {
    super(message);
    this.name = 'ApiError';
    this.service = service;
    this.status = status;
    this.code = code;
    this.kind = kind;
    this.state = state;
    this.body = body;
  }
}

export function classify(status: number, code = ''): ErrorKind {
  if (code === 'MALFORMED_RESPONSE') return 'defect';
  if (status === 0 || status === 429 || status >= 500) return 'retryable';
  if (status === 404) return 'not_found';
  return 'action';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface JsonResponse {
  status: number;
  body: unknown;
}

export interface RequestOptions {
  token?: string;
  body?: unknown;
  signal?: AbortSignal;
}

export type FetchLike = typeof fetch;

const SERVICE_LABEL: Record<ServiceName, string> = {
  gate: 'the Gate service',
  index: 'the governance index',
};

/** Performs one request. Network failure becomes a retryable ApiError. */
export async function requestJson(
  service: ServiceName,
  fetchImpl: FetchLike,
  baseUrl: string,
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (cause: unknown) {
    // An abort is the caller's own decision (navigation), not a failure.
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(
      service,
      0,
      'NETWORK_UNAVAILABLE',
      `Gavel could not reach ${SERVICE_LABEL[service]}. Check your connection and try again.`,
      null,
    );
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

export function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError';
}
