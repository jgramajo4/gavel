#!/usr/bin/env node
"use strict";

const { readBoundedText } = require("../packages/server/src/gate/bounded-response");

function canonicalOrigin(value) {
  if (typeof value !== "string" || value === "") throw new TypeError("GAVEL_GATE_URL is required");
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError("GAVEL_GATE_URL must be an HTTP(S) origin"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("GAVEL_GATE_URL must be an HTTP(S) origin without credentials, path, query, or fragment");
  }
  return parsed.origin;
}

async function validateGateSmoke({
  baseUrl = process.env.GAVEL_GATE_URL,
  timeoutMs = Number(process.env.GAVEL_GATE_SMOKE_TIMEOUT_MS || 5_000),
  fetchImpl = global.fetch,
  stdout = process.stdout,
} = {}) {
  const origin = canonicalOrigin(baseUrl);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError("GAVEL_GATE_SMOKE_TIMEOUT_MS must be an integer from 1 to 30000");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${origin}/health`, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status !== 200) throw new Error("Gate health check failed");
    const raw = await readBoundedText(response, 128, "unexpected health response");
    let body;
    try { body = JSON.parse(raw); } catch { throw new Error("unexpected health response"); }
    if (!body || Object.keys(body).length !== 2 || body.ok !== true || body.status !== "ready") {
      throw new Error("unexpected health response");
    }
    const result = Object.freeze({ ok: true, status: "ready" });
    stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally { clearTimeout(timer); }
}

async function main() {
  try { await validateGateSmoke(); }
  catch { process.stderr.write('{"ok":false,"status":"unavailable"}\n'); process.exitCode = 1; }
}

if (require.main === module) main();

module.exports = { validateGateSmoke };
