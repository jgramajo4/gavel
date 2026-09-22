"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULT_INDEX_URL, resolveConfig } = require("../src/config");

test("Gate and index origins are required and credential-free", () => {
  const config = resolveConfig({ GAVEL_GATE_URL: "https://gate.gavel.vote" });
  assert.equal(config.gateUrl, "https://gate.gavel.vote");
  assert.equal(config.indexUrl, DEFAULT_INDEX_URL);
  assert.equal(config.dao, "nouns");

  for (const value of ["", "not-a-url", "https://user:pass@gate.example", "https://gate.example/path", "https://gate.example/?token=abc"]) {
    assert.throws(() => resolveConfig({ GAVEL_GATE_URL: value }), (error) => error.code === "INVALID_CONFIG");
  }
});

test("the production Gate origin must be a public HTTPS hostname", () => {
  for (const gateUrl of [
    "http://localhost:3000",
    "http://192.168.1.7:8080",
    "https://127.0.0.1",
    "https://gate.test",
    "https://gate.example.com",
    "https://localhost.",
    "https://gate.local.",
    "https://gate.test.",
    "https://example.com.",
    "https://localhost..",
    "https://gate.local..",
    "https://gate.test..",
    "https://example.com..",
  ]) {
    assert.throws(
      () => resolveConfig({ GAVEL_GATE_URL: gateUrl }),
      (error) => error.code === "INVALID_CONFIG" && /HTTPS (?:origin|hostname)/.test(error.message),
    );
    assert.throws(
      () => resolveConfig({
        GAVEL_GATE_URL: "https://gate.gavel.vote",
        GAVEL_GATE_RELAYER_URL: gateUrl,
      }),
      (error) => error.code === "INVALID_CONFIG" && /HTTPS (?:origin|hostname)/.test(error.message),
    );
  }
});

test("a trailing DNS root dot is canonicalized for a valid public Gate hostname", () => {
  const config = resolveConfig({ GAVEL_GATE_URL: "https://gate.gavel.vote." });
  assert.equal(config.gateUrl, "https://gate.gavel.vote");

  const relayConfig = resolveConfig({
    GAVEL_GATE_URL: "https://gate.gavel.vote",
    GAVEL_GATE_RELAYER_URL: "https://relay.gavel.vote.",
  });
  assert.equal(relayConfig.relayerUrl, "https://relay.gavel.vote");
});

test("Base mainnet is the only chain allowed by default", () => {
  assert.deepEqual([...resolveConfig({ GAVEL_GATE_URL: "https://gate.gavel.vote" }).allowedChainIds], [8453]);
});

test("Bankr production cannot be configured for Base Sepolia or another chain", () => {
  for (const chainIds of ["84532", "8453,84532", "1", [84532]]) {
    assert.throws(
      () => resolveConfig({ GAVEL_GATE_URL: "https://gate.gavel.vote", GAVEL_GATE_CHAIN_IDS: chainIds }),
      (error) => error.code === "INVALID_CONFIG" && /exactly 8453/.test(error.message),
    );
  }
});

test("no contract address, token, fee, or price is configurable here", () => {
  const config = resolveConfig({ GAVEL_GATE_URL: "https://gate.gavel.vote" });
  for (const field of ["splitter", "token", "attentionAmount", "gavelFeeAmount", "quoteSigner"]) {
    assert.equal(Object.hasOwn(config, field), false, `${field} must come from the Gate quote, not configuration`);
  }
});
