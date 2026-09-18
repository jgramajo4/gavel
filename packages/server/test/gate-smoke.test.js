"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

function response(text) {
  const bytes = Buffer.from(text);
  return { status: 200, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
}

test("smoke validator accepts only the bounded no-secret health projection", async () => {
  const { validateGateSmoke } = require("../../../scripts/gate-smoke");
  const output = [];
  const result = await validateGateSmoke({
    baseUrl: "http://gate.invalid",
    timeoutMs: 100,
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://gate.invalid/health");
      assert.equal(options.redirect, "error");
      return response('{"ok":true,"status":"ready"}');
    },
    stdout: { write(value) { output.push(String(value)); } },
  });
  assert.deepEqual(result, { ok: true, status: "ready" });
  assert.deepEqual(output, ['{"ok":true,"status":"ready"}\n']);
});

test("smoke validator rejects extra health fields and never relays a response body", async () => {
  const { validateGateSmoke } = require("../../../scripts/gate-smoke");
  const output = [];
  await assert.rejects(validateGateSmoke({
    baseUrl: "https://gate.invalid",
    fetchImpl: async () => response('{"ok":true,"status":"ready","signer":"PRIVATE"}'),
    stdout: { write(value) { output.push(String(value)); } },
  }), /unexpected health response/);
  assert.deepEqual(output, []);
});

test("smoke validator requires an explicit HTTP(S) origin without credentials, path, query, or fragment", async () => {
  const { validateGateSmoke } = require("../../../scripts/gate-smoke");
  for (const baseUrl of [undefined, "ftp://gate.invalid", "https://user:pass@gate.invalid", "https://gate.invalid/path",
    "https://gate.invalid?x=1", "https://gate.invalid/#x"]) {
    await assert.rejects(validateGateSmoke({ baseUrl, fetchImpl: async () => { throw new Error("must not fetch"); } }),
      /GAVEL_GATE_URL|origin/);
  }
});

test("smoke validator cancels an oversized response before buffering its remainder", async () => {
  const { validateGateSmoke } = require("../../../scripts/gate-smoke");
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(Buffer.alloc(129, "x")); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(validateGateSmoke({
    baseUrl: "https://gate.invalid",
    fetchImpl: async () => ({ status: 200, body, async text() { throw new Error("must not buffer"); } }),
  }), /unexpected health response/);
  assert.equal(cancelled, true);
});
