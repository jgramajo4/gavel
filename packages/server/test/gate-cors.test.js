const assert = require("node:assert/strict");
const test = require("node:test");

const { createGateHttpServer } = require("../src/gate/http");

const ALLOWED = "https://gate.0773h.com";
const OTHER = "https://evil.example";

function stubAuth() {
  return {
    async issueChallenge() { return {}; },
    async verifyProof() { return {}; },
    async authenticateSession() { throw new Error("session unavailable"); },
  };
}
function stubProfile() {
  return {
    async updateProfile() { return {}; },
    async listPublicProfiles() { return []; },
    async getPublicProfile() { return null; },
  };
}
function stubServer(corsOrigins = [ALLOWED]) {
  return createGateHttpServer({ authService: stubAuth(), profileService: stubProfile(), corsOrigins });
}
async function withServer(server, callback) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}
async function send(baseUrl, path, method, origin) {
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  return fetch(`${baseUrl}${path}`, { method, headers });
}

test("preflight OPTIONS from an allowlisted origin returns 204 with exact allow headers", async () => {
  await withServer(stubServer(), async (baseUrl) => {
    const response = await send(baseUrl, "/v1/gate/me/inbox", "OPTIONS", ALLOWED);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), ALLOWED);
    assert.match(response.headers.get("vary"), /Origin/i);
    const methods = response.headers.get("access-control-allow-methods");
    for (const method of ["GET", "POST", "PUT", "OPTIONS"]) assert.match(methods, new RegExp(method));
    const headers = response.headers.get("access-control-allow-headers");
    for (const header of ["Authorization", "Content-Type", "Accept"]) assert.match(headers, new RegExp(header, "i"));
    assert.ok(response.headers.get("access-control-max-age"));
  });
});

test("normal request from an allowlisted origin carries exact origin header, never a wildcard", async () => {
  await withServer(stubServer(), async (baseUrl) => {
    const response = await send(baseUrl, "/health", "GET", ALLOWED);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), ALLOWED);
  });
});

test("request from a disallowed origin gets no CORS headers at all", async () => {
  await withServer(stubServer(), async (baseUrl) => {
    const response = await send(baseUrl, "/health", "GET", OTHER);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const response2 = await send(baseUrl, "/health", "OPTIONS", OTHER);
    assert.notEqual(response2.status, 204);
  });
});

test("request without an Origin header gets no CORS headers", async () => {
  await withServer(stubServer(), async (baseUrl) => {
    const response = await send(baseUrl, "/health", "GET");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });
});

test("empty allowlist emits no CORS headers", async () => {
  await withServer(stubServer([]), async (baseUrl) => {
    const response = await send(baseUrl, "/health", "GET", ALLOWED);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });
});

test("corsOrigins rejects wildcards, paths, and non-HTTPS origins", () => {
  assert.throws(() => stubServer(["https://gate.0773h.com/*"]), /corsOrigins/);
  assert.throws(() => stubServer(["https://gate.0773h.com/inbox"]), /corsOrigins/);
  assert.throws(() => stubServer(["http://gate.0773h.com"]), /corsOrigins/);
  assert.throws(() => stubServer(["*"]), /corsOrigins/);
  assert.throws(() => stubServer(["gate.0773h.com"]), /corsOrigins/);
});