"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflow = fs.readFileSync(path.join(__dirname, "../../../.github/workflows/test.yml"), "utf8");

test("CI makes PostgreSQL 16 Gate integration mandatory with a disposable database and zero skips", () => {
  assert.match(workflow, /image:\s*postgres:16(?:-alpine)?/);
  assert.match(workflow, /createdb[^\n]*gavel_gate_ci_disposable/);
  assert.match(workflow, /GAVEL_GATE_TEST_DATABASE_URL:\s*postgres:\/\/postgres:[^\s]+@127\.0\.0\.1:5432\/gavel_gate_ci_disposable/);
  assert.match(workflow, /GAVEL_GATE_TEST_DATABASE_DISPOSABLE:\s*yes/);
  assert.match(workflow, /node --test --test-concurrency=1/);
  assert.match(workflow, /gate-store-postgres\.test\.js/);
  assert.match(workflow, /durable-persistence\.test\.js/);
  assert.match(workflow, /auth-session-environment\.test\.js/);
  assert.match(workflow, /status=\$\?/);
  assert.match(workflow, /\[ "\$status" -ne 0 \]/);
  assert.match(workflow, /# skipped \[1-9\]/);
  assert.match(workflow, /exit 1/);
});
