"use strict";

const { BankrGateError, gateCopy } = require("./errors");

const RESUME_PATH = /^\/v1\/submissions\/[A-Za-z0-9_-]{22}\/resume$/;
const PUBLIC_ID = /^[A-Za-z0-9_-]{22}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorFrom(status, body) {
  const detail = isRecord(body) && isRecord(body.error) ? body.error : {};
  const code = typeof detail.code === "string" ? detail.code : "REQUEST_FAILED";
  const state = isRecord(body) && typeof body.state === "string" ? body.state : undefined;
  const message = gateCopy(code, typeof detail.message === "string" && detail.message
    ? detail.message
    : `Gate rejected this request (HTTP ${status}).`);
  return new BankrGateError(code, message, { state, status });
}

/**
 * Thin HTTP client for the advocate-facing Gate surfaces.
 *
 * It holds no policy. Price, eligibility, capacity, duplicate detection, quote
 * issuance, settlement verification, and acceptance are all Gate's, and this
 * client only carries the bytes. It also never reaches a voter-private route:
 * the voter's own profile and inbox routes are deliberately not implemented
 * here, because a payer must not be able to read the inbox it paid into.
 *
 * The session token travels only in an `Authorization` header. It is never put
 * into a URL, a query string, an error message, or any returned object.
 */
function createGateApi({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof baseUrl !== "string" || !baseUrl) throw new BankrGateError("INVALID_CONFIG", "Gate baseUrl is required.");
  if (typeof fetchImpl !== "function") throw new BankrGateError("INVALID_CONFIG", "A fetch implementation is required.");
  const root = baseUrl.replace(/\/+$/, "");

  async function call(method, path, { token, body } = {}) {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers,
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      // The request may or may not have reached Gate. This is reported as an
      // UNKNOWN outcome, never as a failure that justifies a fresh quote.
      throw new BankrGateError(
        "TRANSPORT_FAILED",
        "The Gate request did not complete. Its outcome is unknown.",
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }
    let parsed = null;
    try {
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new Error("oversized response");
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  }

  async function expectOk(method, path, options) {
    const { status, body } = await call(method, path, options);
    if (status >= 200 && status < 300) return body;
    throw errorFrom(status, body);
  }

  return Object.freeze({
    /** Public discovery. No authentication, no payer identity, no voter privacy. */
    async listGates({ dao = "nouns", availability = "accepting_now", minVotingPower, sort = "recent" } = {}) {
      const params = new URLSearchParams({ dao, availability, sort });
      if (minVotingPower) params.set("minVotingPower", String(minVotingPower));
      const body = await expectOk("GET", `/v1/gates?${params.toString()}`);
      return isRecord(body) && Array.isArray(body.items) ? body.items : [];
    },

    /** Complete server-side exact lookup; response is capped at two for ambiguity. */
    async findGatesByLabel(label, { dao = "nouns", stage } = {}) {
      if (typeof label !== "string" || !label.trim()) {
        throw new BankrGateError("INVALID_REQUEST", "A Gate label is required.");
      }
      const params = new URLSearchParams({ dao, label: label.trim() });
      if (stage !== undefined) params.set("stage", stage);
      const body = await expectOk("GET", `/v1/gates/matches?${params.toString()}`);
      return isRecord(body) && Array.isArray(body.items) ? body.items : [];
    },

    async getGate(wallet) {
      if (typeof wallet !== "string" || !ADDRESS.test(wallet)) {
        throw new BankrGateError("INVALID_REQUEST", "A voter wallet address is required.");
      }
      const { status, body } = await call("GET", `/v1/gates/${wallet}`);
      if (status === 404) return null;
      if (status < 200 || status >= 300) throw errorFrom(status, body);
      return body;
    },

    async requestChallenge(input) {
      return expectOk("POST", "/v1/gate/auth/challenge", { body: input });
    },

    async verifyProof(proof) {
      return expectOk("POST", "/v1/gate/auth/verify", { body: proof });
    },

    /**
     * Creates exactly one Gate submission.
     *
     * A 409 `duplicate` is a RECEIPT, not a failure: Gate already holds a quote
     * for this exact owner-bound submission hash, and the only correct next step
     * is to resume that one.
     */
    async createSubmission(token, voterWallet, request) {
      if (typeof voterWallet !== "string" || !ADDRESS.test(voterWallet)) {
        throw new BankrGateError("INVALID_REQUEST", "A voter wallet address is required.");
      }
      const { status, body } = await call("POST", `/v1/gates/${voterWallet}/submissions`, { token, body: request });
      if (status === 409 && isRecord(body) && body.state === "duplicate") return body;
      if (status < 200 || status >= 300) throw errorFrom(status, body);
      return body;
    },

    /** Owner-bound recovery of the ORIGINAL quote. Issues nothing. */
    async resumeSubmission(token, resumeUrl) {
      if (typeof resumeUrl !== "string" || !RESUME_PATH.test(resumeUrl)) {
        throw new BankrGateError("INVALID_RESUME_URL", "That is not a Gate resume path.");
      }
      const { status, body } = await call("GET", resumeUrl, { token });
      if (status === 404) return null;
      if (status < 200 || status >= 300) throw errorFrom(status, body);
      return body;
    },

    /** Public, authoritative status. This is the only source of acceptance. */
    async getStatus(publicId) {
      if (typeof publicId !== "string" || !PUBLIC_ID.test(publicId)) {
        throw new BankrGateError("INVALID_REQUEST", "A Gate submission id is required.");
      }
      const { status, body } = await call("GET", `/v1/submissions/${publicId}/status`);
      if (status === 404) return null;
      if (status < 200 || status >= 300) throw errorFrom(status, body);
      return body;
    },

    /**
     * Records a broadcast transaction hash as a SETTLEMENT HINT.
     *
     * 202 means the hint was recorded. It is not payment, not delivery, and not
     * acceptance: only Gate's own scanner can make that call.
     */
    async recordSettlementHint(token, publicId, txHash, chainId) {
      if (typeof publicId !== "string" || !PUBLIC_ID.test(publicId)) {
        throw new BankrGateError("INVALID_REQUEST", "A Gate submission id is required.");
      }
      return expectOk("POST", `/v1/submissions/${publicId}/settlement`, {
        token,
        body: { txHash, chainId: String(chainId) },
      });
    },
  });
}

module.exports = { PUBLIC_ID, RESUME_PATH, createGateApi, errorFrom };
