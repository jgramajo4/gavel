const http = require("node:http");
const { getAddress } = require("ethers");
const { z } = require("zod");
const { decodeCursor, decodeProposalCursor } = require("./memory-store");
const { redactErrorMessage } = require("./redaction");

const limitSchema = z.coerce.number().int().min(1).max(100).default(25);
const daoSchema = z.enum(["nouns", "ens", "railgun-eth"]);
const proposalSchema = z.string().regex(/^\d+$/);
function json(res, status, body) { const payload = JSON.stringify(body); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" }); res.end(payload); }
function publicProposal(row) { return row?.normalized || row; }
function publicEndpoint(value, explicit) {
  try {
    const url = new URL(explicit || value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return explicit ? url.toString().replace(/\/$/, url.pathname === "/" ? "" : "/") : url.origin;
  } catch { return "https://source.invalid"; }
}
function publicVote(row) {
  if (!row) return row;
  const { normalized, sourcePublicEndpoint, ...event } = row;
  return { ...event, sourceEndpoint: publicEndpoint(event.sourceEndpoint, sourcePublicEndpoint) };
}
function publicCheckpoint(row) {
  return { ...row, lastError: row.lastError ? "sync_failed" : null };
}
function publicStatus(status) {
  return { ...status, checkpoints: (status.checkpoints || []).map(publicCheckpoint) };
}
function requestPath(value) {
  try { return new URL(value, "http://localhost").pathname; }
  catch { return String(value || "").split(/[?#]/, 1)[0] || "/"; }
}

function createReadOnlyApi({ store, logger = null }) {
  const log = logger || { info() {}, error() {} };
  return http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      if (!["GET", "HEAD"].includes(req.method)) return json(res, 405, { error: "method_not_allowed" });
      const url = new URL(req.url, "http://localhost"); const parts = url.pathname.split("/").filter(Boolean);
      if (["/health", "/healthz"].includes(url.pathname)) return json(res, 200, { ok: true });
      if (url.pathname === "/v1/daos") return json(res, 200, { items: await store.listDaos() });
      if (url.pathname === "/v1/status") return json(res, 200, publicStatus(await store.status()));
      if (parts[0] !== "v1" || parts[1] !== "daos") return json(res, 404, { error: "not_found" });
      const dao = daoSchema.parse(parts[2]); const limit = limitSchema.parse(url.searchParams.get("limit") || undefined);
      if (parts.length === 3) { const row = await store.getDao(dao); return row ? json(res, 200, row) : json(res, 404, { error: "dao_not_found" }); }
      if (parts[3] === "proposals" && parts.length === 4) {
        const cursor = decodeProposalCursor(url.searchParams.get("cursor"));
        const page = await store.listProposals({ daoId: dao, limit, cursor }); return json(res, 200, page);
      }
      if (parts[3] === "proposals" && parts.length === 5) { const id = proposalSchema.parse(parts[4]); const row = await store.getProposal(dao, id); return row ? json(res, 200, publicProposal(row)) : json(res, 404, { error: "proposal_not_found" }); }
      if (parts[3] === "voters" && parts[5] === "history" && parts.length === 6) { const voter = getAddress(parts[4]); const cursor = decodeCursor(url.searchParams.get("cursor")); const page = await store.listVotes({ daoId: dao, voter, limit, cursor }); return json(res, 200, { dao, chainId: 1, voter, ...page, items: page.items.map(publicVote) }); }
      if (parts[3] === "votes" && parts.length === 4) { const voter = url.searchParams.get("voter"); const cursor = decodeCursor(url.searchParams.get("cursor")); const page = await store.listVotes({ daoId: dao, voter: voter ? getAddress(voter) : null, limit, cursor }); return json(res, 200, { ...page, items: page.items.map(publicVote) }); }
      if (parts[3] === "sync-status" && parts.length === 4) return json(res, 200, { dao, sources: (await store.syncStatus(dao)).map(publicCheckpoint) });
      return json(res, 404, { error: "not_found" });
    } catch (error) { const bad = error instanceof z.ZodError || error instanceof TypeError; log.error({ event: "api_error", method: req.method, path: requestPath(req.url), error: redactErrorMessage(error) }); return json(res, bad ? 400 : 500, { error: bad ? "invalid_request" : "internal_error", message: bad ? error.message : "Internal server error" }); }
    finally { log.info({ event: "http_request", method: req.method, path: requestPath(req.url), durationMs: Date.now() - started }); }
  });
}
module.exports = { createReadOnlyApi, publicEndpoint };
