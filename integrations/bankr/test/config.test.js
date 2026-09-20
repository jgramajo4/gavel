"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULT_INDEX_URL, resolveConfig } = require("../src/config");

test("Gate and index origins are required and credential-free", () => {
  const config = resolveConfig({ GAVEL_GATE_URL: "https://gate.example" });
  assert.equal(config.gateUrl, "https://gate.example");
  assert.equal(config.indexUrl, DEFAULT_INDEX_URL);
  assert.equal(config.dao, "nouns");

  for (const value of ["", "not-a-url", "https://user:pass@gate.example", "https://gate.example/path", "https://gate.example/?token=abc"]) {
    assert.throws(() => resolveConfig({ GAVEL_GATE_URL: value }), (error) => error.code === "INVALID_CONFIG");
  }
});

test("Base mainnet is the only chain allowed by default", () => {
  assert.deepEqual([...resolveConfig({ GAVEL_GATE_URL: "https://gate.example" }).allowedChainIds], [8453]);
});

test("no contract address, token, fee, or price is configurable here", () => {
  const config = resolveConfig({ GAVEL_GATE_URL: "https://gate.example" });
  for (const field of ["splitter", "token", "attentionAmount", "gavelFeeAmount", "quoteSigner"]) {
    assert.equal(Object.hasOwn(config, field), false, `${field} must come from the Gate quote, not configuration`);
  }
});
