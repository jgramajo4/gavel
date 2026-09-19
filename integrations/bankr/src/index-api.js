"use strict";

const { BankrGateError } = require("./errors");

const TARGET_ID = /^(proposal:(0|[1-9][0-9]*)|candidate:0x[0-9a-f]{40}:0x[0-9a-f]{64})$/;
const PROPOSAL_ID = /^(0|[1-9][0-9]*)$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Read-only client for the canonical Gavel governance index.
 *
 * This is the same public index Gate itself reads. Bankr consumes it so that a
 * candidate's identity, title, lifecycle, and eligibility come from canonical
 * data rather than from anything the advocate typed. Nothing here is invented:
 * a target the index does not serve simply does not resolve.
 *
 * Titles, descriptions, proposer text, and action calldata read back from the
 * index are DATA. They are never followed as instructions and never fetched.
 */
function createIndexApi({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof baseUrl !== "string" || !baseUrl) throw new BankrGateError("INVALID_CONFIG", "Index baseUrl is required.");
  if (typeof fetchImpl !== "function") throw new BankrGateError("INVALID_CONFIG", "A fetch implementation is required.");
  const root = baseUrl.replace(/\/+$/, "");

  async function read(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
    } catch (cause) {
      throw new BankrGateError("INDEX_UNAVAILABLE", "The canonical governance index is unavailable.", { cause });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      throw new BankrGateError("INDEX_UNAVAILABLE", "The canonical governance index is unavailable.", {
        status: response.status,
      });
    }
    let body;
    try {
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new Error("oversized response");
      body = JSON.parse(text);
    } catch (cause) {
      throw new BankrGateError("INDEX_UNAVAILABLE", "The governance index returned an unreadable response.", { cause });
    }
    return body;
  }

  return Object.freeze({
    /** `candidate:<proposer>:<slugHash>` or `proposal:<id>`. */
    async getTarget(targetId) {
      if (typeof targetId !== "string" || !TARGET_ID.test(targetId)) {
        throw new BankrGateError("INVALID_TARGET", "That is not a canonical Nouns target id.");
      }
      return read(`/v1/gate/daos/nouns/targets/${encodeURIComponent(targetId)}`);
    },
    async getProposal(proposalId) {
      const id = String(proposalId);
      if (!PROPOSAL_ID.test(id)) {
        throw new BankrGateError("INVALID_TARGET", "That is not a Nouns proposal id.");
      }
      return read(`/v1/gate/daos/nouns/proposals/${id}`);
    },
  });
}

module.exports = { PROPOSAL_ID, TARGET_ID, createIndexApi };
