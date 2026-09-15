const http = require("node:http");
const { SubmissionPolicyError } = require("@gavel/gate");
const { ProfileRequestError } = require("./profile-service");
const { IndexUnavailableError } = require("./index-client");

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_CHALLENGE_LIMIT = 20;
const DEFAULT_CHALLENGE_WINDOW_MS = 60_000;
const DEFAULT_CHALLENGE_MAX_KEYS = 1_024;

function createChallengeLimiter({ limit = DEFAULT_CHALLENGE_LIMIT, windowMs = DEFAULT_CHALLENGE_WINDOW_MS,
  maxKeys = DEFAULT_CHALLENGE_MAX_KEYS, clock = Date.now } = {}) {
  for (const [name, value] of [["limit", limit], ["windowMs", windowMs], ["maxKeys", maxKeys]]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  const windows = new Map();
  return Object.freeze({
    allow(key) {
      const now = Number(clock());
      if (!Number.isFinite(now)) return false;
      const id = typeof key === "string" && key ? key : "unknown";
      let entry = windows.get(id);
      if (!entry || now - entry.startedAt >= windowMs) {
        if (!entry && windows.size >= maxKeys) {
          for (const [candidate, value] of windows) {
            if (now - value.startedAt >= windowMs) windows.delete(candidate);
          }
          if (windows.size >= maxKeys) return false;
        }
        entry = { startedAt: now, count: 0 };
        windows.set(id, entry);
      }
      entry.count += 1;
      return entry.count <= limit;
    },
  });
}

function sendJson(response, statusCode, value) {
  const payload = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  response.end(payload);
}

async function readJson(request, maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      request.destroy();
      throw new ProfileRequestError("request body is too large", 413, "REQUEST_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("object required");
    return result;
  } catch {
    throw new ProfileRequestError("request body must be a JSON object", 400, "INVALID_REQUEST");
  }
}

function bearerToken(request) {
  const value = request.headers.authorization;
  const match = typeof value === "string" && /^Bearer ([^\s]+)$/.exec(value);
  if (!match) throw new ProfileRequestError("authentication required", 401, "UNAUTHORIZED");
  return match[1];
}

function createGateHttpServer({ authService, profileService, submissionService,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES, challengeLimiter = createChallengeLimiter() } = {}) {
  if (!authService || typeof authService.issueChallenge !== "function" || typeof authService.verifyProof !== "function"
      || typeof authService.authenticateSession !== "function") throw new TypeError("complete authService is required");
  if (!profileService || typeof profileService.updateProfile !== "function"
      || typeof profileService.listPublicProfiles !== "function" || typeof profileService.getPublicProfile !== "function") {
    throw new TypeError("complete profileService is required");
  }
  if (submissionService !== undefined && (typeof submissionService.createSubmission !== "function"
      || typeof submissionService.getPublicStatus !== "function"
      || typeof submissionService.resumeSubmission !== "function")) {
    throw new TypeError("complete submissionService is required");
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new TypeError("maxBodyBytes must be a positive integer");
  if (!challengeLimiter || typeof challengeLimiter.allow !== "function") throw new TypeError("challengeLimiter.allow is required");

  return http.createServer(async (request, response) => {
    try {
      if (typeof request.url !== "string" || !/^\/(?![\\/])/.test(request.url)) {
        return sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
      }
      const url = new URL(request.url, "http://gate.invalid");
      const path = url.pathname;

      if (request.method === "POST" && path === "/v1/gate/auth/challenge") {
        let allowed = false;
        try { allowed = await challengeLimiter.allow(request.socket.remoteAddress || "unknown"); } catch { /* fail closed */ }
        if (!allowed) {
          return sendJson(response, 429, { error: { code: "RATE_LIMITED", message: "Too many authentication challenges" } });
        }
        const body = await readJson(request, maxBodyBytes);
        try { return sendJson(response, 200, await authService.issueChallenge(body)); }
        catch {
          throw new ProfileRequestError("authentication challenge is invalid", 400, "INVALID_AUTH_CHALLENGE");
        }
      }
      if (request.method === "POST" && path === "/v1/gate/auth/verify") {
        const body = await readJson(request, maxBodyBytes);
        try { return sendJson(response, 200, await authService.verifyProof(body)); }
        catch {
          throw new ProfileRequestError("authentication proof is invalid", 401, "INVALID_AUTH_PROOF");
        }
      }
      if (request.method === "PUT" && path === "/v1/gate/me/profile") {
        const token = bearerToken(request);
        let session;
        try { session = await authService.authenticateSession(token, { role: "dao_profile" }); }
        catch { throw new ProfileRequestError("authentication required", 401, "UNAUTHORIZED"); }
        const body = await readJson(request, maxBodyBytes);
        return sendJson(response, 200, await profileService.updateProfile({ ...body, session }));
      }
      if (request.method === "GET" && path === "/v1/gates") {
        const minVotingPower = url.searchParams.get("minVotingPower");
        const filters = {
          dao: url.searchParams.get("dao") || "nouns",
          availability: url.searchParams.get("availability") || "accepting_now",
          ...(minVotingPower === null || minVotingPower === "" ? {} : { minVotingPower }),
          sort: url.searchParams.get("sort") || "recent",
        };
        return sendJson(response, 200, { items: await profileService.listPublicProfiles(filters) });
      }
      const submissions = /^\/v1\/gates\/(0x[0-9a-fA-F]{40})\/submissions$/.exec(path);
      if (submissionService && request.method === "POST" && submissions) {
        const token = bearerToken(request);
        let session;
        try { session = await authService.authenticateSession(token, { role: "base_sender" }); }
        catch { throw new ProfileRequestError("authentication required", 401, "UNAUTHORIZED"); }
        const payload = await readJson(request, maxBodyBytes);
        const result = await submissionService.createSubmission({
          session, voterWallet: submissions[1], request: payload, ip: request.socket.remoteAddress,
        });
        // A duplicate is an owner-bound receipt, never a second quoted row.
        return result.state === "duplicate"
          ? sendJson(response, 409, result)
          : sendJson(response, 201, result);
      }
      // Resume is owner-bound: identity comes only from the session, never from
      // the path, query string, or body. A non-owner gets a plain 404.
      const resume = /^\/v1\/submissions\/([A-Za-z0-9_-]{22})\/resume$/.exec(path);
      if (submissionService && request.method === "GET" && resume) {
        const token = bearerToken(request);
        let session;
        try { session = await authService.authenticateSession(token, { role: "base_sender" }); }
        catch { throw new ProfileRequestError("authentication required", 401, "UNAUTHORIZED"); }
        const resumed = await submissionService.resumeSubmission({ session, publicId: resume[1] });
        return resumed
          ? sendJson(response, 200, resumed)
          : sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
      }
      const status = /^\/v1\/submissions\/([A-Za-z0-9_-]{22})\/status$/.exec(path);
      if (submissionService && request.method === "GET" && status) {
        const receipt = await submissionService.getPublicStatus(status[1]);
        return receipt
          ? sendJson(response, 200, receipt)
          : sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
      }
      const direct = /^\/v1\/gates\/(0x[0-9a-fA-F]{40})$/.exec(path);
      if (request.method === "GET" && direct) {
        const profile = await profileService.getPublicProfile(direct[1].toLowerCase());
        return profile ? sendJson(response, 200, profile) : sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Gate profile not found" } });
      }
      return sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof SubmissionPolicyError) {
        return sendJson(response, error.statusCode, {
          state: error.state, error: { code: error.code, message: error.message },
        });
      }
      const known = error instanceof ProfileRequestError || error instanceof IndexUnavailableError;
      const statusCode = known ? error.statusCode : 500;
      const code = known ? error.code : "INTERNAL_ERROR";
      const message = known ? error.message : "Internal server error";
      return sendJson(response, statusCode, { error: { code, message } });
    }
  });
}

module.exports = {
  DEFAULT_CHALLENGE_LIMIT,
  DEFAULT_CHALLENGE_MAX_KEYS,
  DEFAULT_CHALLENGE_WINDOW_MS,
  DEFAULT_MAX_BODY_BYTES,
  createChallengeLimiter,
  createGateHttpServer,
};
