import type {
  AuthChallenge,
  DuplicateReceipt,
  InboxArchiveResult,
  InboxItem,
  IssuedQuote,
  PublicGateProfile,
  SubmissionReceipt,
  SubmissionRequest,
  VerifiedSession,
} from './types';

/**
 * Thin HTTP client for the merged Gate API. It holds no policy: every limit,
 * eligibility rule, capacity decision, quote and settlement verdict belongs to
 * the server. Client-side checks elsewhere in this app are UX only and are
 * always overridden by whatever this client returns.
 */

export class GateApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly state?: string;
  readonly body: unknown;

  constructor(status: number, code: string, message: string, body: unknown, state?: string) {
    super(message);
    this.name = 'GateApiError';
    this.status = status;
    this.code = code;
    this.state = state;
    this.body = body;
  }
}

export interface DirectoryFilters {
  dao?: string;
  availability?: string;
  minVotingPower?: string;
  sort?: 'recent' | 'power';
}

export interface GateApi {
  listGates(filters?: DirectoryFilters): Promise<PublicGateProfile[]>;
  getGate(wallet: string): Promise<PublicGateProfile | null>;
  requestChallenge(input: Record<string, unknown>): Promise<AuthChallenge>;
  verifyProof(proof: Record<string, unknown>): Promise<VerifiedSession>;
  updateProfile(token: string, body: Record<string, unknown>): Promise<PublicGateProfile>;
  createSubmission(
    token: string,
    voterWallet: string,
    request: SubmissionRequest,
  ): Promise<SubmissionReceipt | DuplicateReceipt>;
  /** Frozen duplicate recovery. Returns the ORIGINAL quote; issues nothing new. */
  resumeSubmission(token: string, resumeUrl: string): Promise<SubmissionReceipt | null>;
  getStatus(publicId: string): Promise<SubmissionReceipt | null>;
  recordSettlementHint(
    token: string,
    publicId: string,
    txHash: string,
    chainId: string,
  ): Promise<SubmissionReceipt>;

  // --- Private inbox (owner-bound, `dao_inbox` session only) ---------------
  // These are the three routes the merged server actually serves:
  //   GET  /v1/gate/me/inbox
  //   GET  /v1/gate/me/inbox/:id
  //   POST /v1/gate/me/inbox/:id/archive
  // There is no public inbox route and no follow-up/reply route; the server
  // answers both with 404, and nothing is added here to paper over that.
  listInbox(token: string): Promise<InboxItem[]>;
  getInboxItem(token: string, id: string): Promise<InboxItem | null>;
  archiveInboxItem(token: string, id: string): Promise<InboxArchiveResult>;
}

const RESUME_PATH = /^\/v1\/submissions\/[A-Za-z0-9_-]{22}\/resume$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function malformed(): GateApiError {
  // Deliberately coarse and free of the offending body: a projection this
  // client cannot read is a bug to report, not content to echo back at a user.
  return new GateApiError(
    200,
    'MALFORMED_RESPONSE',
    'The server returned an inbox response this app cannot read.',
    null,
  );
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function recordOr(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function arrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Narrows one `projectInbox` row to the declared shape.
 *
 * The server owns this projection, but the browser still refuses to assume it:
 * a partial or unexpected body becomes a readable error instead of a half-drawn
 * item. Advocate-controlled fields (`pitch`, `disclosures`, `evidenceUrls`) are
 * carried through verbatim and are sanitized at RENDER time by MarkdownPitch
 * and ExternalLink — never here, because a client-side scrub would quietly
 * change what the voter paid to read.
 */
function toInboxItem(body: unknown): InboxItem {
  if (!isRecord(body) || typeof body.id !== 'string' || !body.id) throw malformed();
  const decoded = recordOr(body.decodedFacts);
  return {
    id: body.id,
    archived: body.archived === true,
    createdAt: stringOrNull(body.createdAt),
    pitch: stringOr(body.pitch, ''),
    disclosures: stringOr(body.disclosures, ''),
    evidenceUrls: arrayOf<unknown>(body.evidenceUrls).filter(
      (url): url is string => typeof url === 'string',
    ),
    canonicalFacts: recordOr(body.canonicalFacts),
    decodedFacts: {
      ...(typeof decoded.decoderVersion === 'string' ? { decoderVersion: decoded.decoderVersion } : {}),
      actions: arrayOf(decoded.actions),
    },
    enrichedFacts: arrayOf(body.enrichedFacts),
    rawUnknownActions: arrayOf(body.rawUnknownActions),
    issuanceLifecycle: stringOrNull(body.issuanceLifecycle),
    currentLifecycle: stringOrNull(body.currentLifecycle),
    stateChangedAfterQuote: body.stateChangedAfterQuote === true,
  };
}

function errorFrom(status: number, body: unknown): GateApiError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  const state = isRecord(body) && typeof body.state === 'string' ? body.state : undefined;
  return new GateApiError(
    status,
    typeof error?.code === 'string' ? error.code : 'REQUEST_FAILED',
    typeof error?.message === 'string' ? error.message : `Request failed with status ${status}`,
    body,
    state,
  );
}

export function createGateApi(
  baseUrl = '',
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): GateApi {
  async function call(
    method: string,
    path: string,
    options: { token?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    // The session token travels in the Authorization header only. It is never
    // placed in a URL, a query string, or a log line.
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  }

  async function expectOk(
    method: string,
    path: string,
    options: { token?: string; body?: unknown } = {},
  ): Promise<unknown> {
    const { status, body } = await call(method, path, options);
    if (status >= 200 && status < 300) return body;
    throw errorFrom(status, body);
  }

  return {
    async listGates(filters = {}) {
      const params = new URLSearchParams();
      params.set('dao', filters.dao ?? 'nouns');
      params.set('availability', filters.availability ?? 'accepting_now');
      params.set('sort', filters.sort ?? 'recent');
      if (filters.minVotingPower) params.set('minVotingPower', filters.minVotingPower);
      const body = await expectOk('GET', `/v1/gates?${params.toString()}`);
      return isRecord(body) && Array.isArray(body.items) ? (body.items as PublicGateProfile[]) : [];
    },

    async getGate(wallet) {
      const { status, body } = await call('GET', `/v1/gates/${wallet}`);
      if (status === 404) return null;
      if (status < 200 || status >= 300) throw errorFrom(status, body);
      return body as PublicGateProfile;
    },

    async requestChallenge(input) {
      return (await expectOk('POST', '/v1/gate/auth/challenge', { body: input })) as AuthChallenge;
    },

    async verifyProof(proof) {
      return (await expectOk('POST', '/v1/gate/auth/verify', { body: proof })) as VerifiedSession;
    },

    async updateProfile(token, body) {
      return (await expectOk('PUT', '/v1/gate/me/profile', { token, body })) as PublicGateProfile;
    },

    async createSubmission(token, voterWallet, request) {
      const { status, body } = await call('POST', `/v1/gates/${voterWallet}/submissions`, {
        token,
        body: request,
      });
      // 409 with a resumeUrl is a recoverable duplicate receipt, not a failure.
      if (status === 409 && isRecord(body) && body.state === 'duplicate') {
        return body as unknown as DuplicateReceipt;
      }
      if (status < 200 || status >= 300) throw errorFrom(status, body);
      return body as SubmissionReceipt;
    },

    async resumeSubmission(token, resumeUrl) {
      // The path is server-issued; it is still shape-checked before use so a
      // tampered response cannot redirect an authenticated GET somewhere else.
      if (!RESUME_PATH.test(resumeUrl)) {
        throw new GateApiError(400, 'INVALID_RESUME_URL', 'Resume path is not a Gate resume route.', null);
      }
      const { status, body } = await call('GET', resumeUrl, { token });
      if (status === 404) return null;
      if (status < 200 || status >= 300) throw errorFrom(status, body);
      return body as SubmissionReceipt;
    },

    async getStatus(publicId) {
      const { status, body } = await call('GET', `/v1/submissions/${publicId}/status`);
      if (status === 404) return null;
      if (status < 200 || status >= 300) throw errorFrom(status, body);
      return body as SubmissionReceipt;
    },

    async recordSettlementHint(token, publicId, txHash, chainId) {
      // 202 means only "the browser tx hash was recorded as a hint". It is not
      // payment, delivery, or acceptance.
      return (await expectOk('POST', `/v1/submissions/${publicId}/settlement`, {
        token,
        body: { txHash, chainId },
      })) as SubmissionReceipt;
    },

    async listInbox(token) {
      const body = await expectOk('GET', '/v1/gate/me/inbox', { token });
      if (!isRecord(body) || !Array.isArray(body.items)) throw malformed();
      return body.items.map(toInboxItem);
    },

    async getInboxItem(token, id) {
      // The ID is server-issued but still arrives back through component state,
      // so it is encoded rather than interpolated: a crafted value cannot
      // escape the path segment and reach another authenticated route.
      const { status, body } = await call('GET', `/v1/gate/me/inbox/${encodeURIComponent(id)}`, { token });
      // The server answers a foreign item and a missing one identically; so
      // does this client, so a 404 can never be read as "it exists".
      if (status === 404) return null;
      if (status < 200 || status >= 300) throw errorFrom(status, body);
      return toInboxItem(body);
    },

    async archiveInboxItem(token, id) {
      const body = await expectOk('POST', `/v1/gate/me/inbox/${encodeURIComponent(id)}/archive`, { token });
      if (!isRecord(body) || typeof body.id !== 'string') throw malformed();
      return { id: body.id, archived: body.archived === true };
    },
  };
}

/** A quote is server-owned and immutable; this returns a defensive deep copy. */
export function freezeQuote(quote: IssuedQuote): IssuedQuote {
  return Object.freeze({
    domain: Object.freeze({ ...quote.domain }),
    message: Object.freeze({ ...quote.message }),
    totalAmount: quote.totalAmount,
    signature: quote.signature,
  }) as IssuedQuote;
}
