const assert = require("node:assert/strict");
const test = require("node:test");

const { createReadOnlyApi, corsOriginsFromEnv } = require("../packages/governance-index/src/api");
const { MemoryGovernanceStore } = require("../packages/governance-index/src/memory-store");

// Gavel Web (https://gavel.0773h.com) reads the public index from the browser.
// The index must allow exactly the configured web origins and nothing else.
const WEB = "https://gavel.0773h.com";

async function withServer(server, callback) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("index API emits CORS only for an exact configured origin", async () => {
  const server = createReadOnlyApi({ store: new MemoryGovernanceStore(), corsOrigins: [WEB] });
  await withServer(server, async (base) => {
    const allowed = await fetch(`${base}/v1/daos`, { headers: { origin: WEB } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), WEB);
    assert.equal(allowed.headers.get("vary"), "Origin");
    assert.equal(allowed.headers.get("access-control-allow-credentials"), null);

    for (const origin of ["https://evil.example", "http://gavel.0773h.com", "https://gavel.0773h.com.evil.example", "null"]) {
      const denied = await fetch(`${base}/v1/daos`, { headers: { origin } });
      assert.equal(denied.headers.get("access-control-allow-origin"), null, origin);
      // Still varies by Origin, so a shared cache never serves this copy to the web app.
      assert.equal(denied.headers.get("vary"), "Origin", origin);
    }
    const noOrigin = await fetch(`${base}/v1/daos`);
    assert.equal(noOrigin.headers.get("vary"), "Origin");

    const preflight = await fetch(`${base}/v1/daos/nouns/proposals`, {
      method: "OPTIONS",
      headers: { origin: WEB, "access-control-request-method": "GET" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");

    // A disallowed preflight gets no CORS answer and the read-only 405.
    const deniedPreflight = await fetch(`${base}/v1/daos`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    assert.equal(deniedPreflight.status, 405);
    assert.equal(deniedPreflight.headers.get("access-control-allow-origin"), null);

    // CORS never widens the read-only method surface.
    const post = await fetch(`${base}/v1/daos`, { method: "POST", headers: { origin: WEB } });
    assert.equal(post.status, 405);
  });
});

test("index API emits no CORS headers by default", async () => {
  const server = createReadOnlyApi({ store: new MemoryGovernanceStore() });
  await withServer(server, async (base) => {
    const response = await fetch(`${base}/v1/daos`, { headers: { origin: WEB } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });
});

test("index CORS configuration accepts only exact HTTPS origins", () => {
  assert.deepEqual(corsOriginsFromEnv({}), []);
  assert.deepEqual(corsOriginsFromEnv({ GAVEL_INDEX_CORS_ORIGINS: "" }), []);
  assert.deepEqual(
    corsOriginsFromEnv({ GAVEL_INDEX_CORS_ORIGINS: `${WEB}, https://gate.0773h.com` }),
    [WEB, "https://gate.0773h.com"],
  );
  for (const bad of ["*", "http://gavel.0773h.com", `${WEB}/`, `${WEB}/path`, `${WEB}?x=1`, "https://user@gavel.0773h.com", "gavel.0773h.com"]) {
    assert.throws(() => corsOriginsFromEnv({ GAVEL_INDEX_CORS_ORIGINS: bad }), TypeError, bad);
    assert.throws(() => createReadOnlyApi({ store: new MemoryGovernanceStore(), corsOrigins: [bad] }), TypeError, bad);
  }
});
