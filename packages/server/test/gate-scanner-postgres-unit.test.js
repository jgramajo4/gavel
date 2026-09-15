const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { PostgresGateStore } = require("../src/gate/store");

const A = `0x${"a".repeat(40)}`;
const B = `0x${"b".repeat(40)}`;
const H = (digit) => `0x${digit.repeat(64)}`;
const blocks = (from, through, hashDigit = "2") => Array.from(
  { length: through - from + 1 },
  (_, offset) => ({ blockNumber: String(from + offset), blockHash: H(hashDigit),
    blockTimestamp: new Date("2026-01-01T00:00:00Z") }),
);

function mockStore(handler) {
  const calls = [];
  const client = {
    async query(sql, values) { calls.push({ sql: String(sql), values }); return handler(String(sql), values); },
    release() {},
  };
  return { calls, store: new PostgresGateStore({ pool: { connect: async () => client } }) };
}

test("scanner deployment starts exactly at deployment block and cannot be cursor-injected", async () => {
  const { calls, store } = mockStore((sql) => /INSERT INTO gate\.splitter_deployments/.test(sql)
    ? { rows: [{ id: "d", deploymentBlock: "40", nextBlock: "40" }] }
    : { rows: [], rowCount: 1 });
  await store.configureDeployment({ id: "d", chainId: "8453", splitter: A, signer: B, token: A,
    gavelRecipient: B, deploymentBlock: "40", nextBlock: "999", contractCodeHash: H("1"), rpcAccess: "cipher" });
  const deployment = calls.find(({ sql }) => /INSERT INTO gate\.splitter_deployments/.test(sql));
  const cursor = calls.find(({ sql }) => /INSERT INTO gate\.settlement_cursors/.test(sql));
  assert.equal(deployment.values[7], "40");
  assert.equal(cursor.values[4], "40");
  assert.doesNotMatch(deployment.sql, /scanner_cursor=EXCLUDED\.scanner_cursor/);
});

test("scanner sends a complete no-match or exact observation result through one atomic SQL function", async () => {
  const { calls, store } = mockStore((sql) => /record_scanner_range/.test(sql)
    ? { rows: [{ released: 0 }] }
    : { rows: [], rowCount: 1 });
  await store.recordScannerRange({ deploymentId: "d", generation: "1", fromBlock: "40", throughBlock: "41",
    canonicalBlockHash: H("2"), canonicalBlockTimestamp: new Date("2026-01-01T00:00:00Z"),
    canonicalBlocks: blocks(40, 41),
    observations: [{ kind: "exact_log", quoteId: H("3"), txHash: H("4"), logIndex: 0, blockNumber: "41",
      blockHash: H("2"), blockTimestamp: new Date("2026-01-01T00:00:00Z"), exactMatch: true }] });
  const call = calls.find(({ sql }) => /record_scanner_range/.test(sql));
  assert.match(call.sql, /SELECT gate\.record_scanner_range/);
  const result = JSON.parse(call.values[5]);
  assert.equal(result.kind, "observations");
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].quoteId, H("3"));
  assert.equal(result.generation, "1");
  assert.equal(result.canonicalBlocks.length, 2);
});

test("scanner rejects incomplete canonical block evidence before opening a transaction", async () => {
  const { calls, store } = mockStore(() => ({ rows: [], rowCount: 1 }));
  await assert.rejects(store.recordScannerRange({ deploymentId: "d", generation: "1", fromBlock: "40", throughBlock: "41",
    canonicalBlockHash: H("2"), canonicalBlockTimestamp: new Date("2026-01-01T00:00:00Z"),
    canonicalBlocks: blocks(40, 40), observations: [] }), /canonicalBlocks.*every block/i);
  assert.equal(calls.length, 0);
});

test("migration makes persisted contiguous ranges and exact logs the sole release authority", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS gate\.settlement_scan_ranges/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS gate\.settlement_scan_blocks/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS gate\.settlement_scan_observations/i);
  assert.match(sql, /scan_generation bigint NOT NULL/i);
  assert.match(sql, /INSERT INTO gate\.settlement_scan_ranges[\s\S]*INSERT INTO gate\.settlement_scan_blocks[\s\S]*INSERT INTO gate\.settlement_scan_observations[\s\S]*UPDATE gate\.settlement_cursors/i);
  assert.match(sql, /max\(b\.scan_generation\)[\s\S]*settlement_scan_blocks/i);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM gate\.settlement_scan_observations[\s\S]*scan_generation/i);
  assert.match(sql, /settlement evidence was not persisted by scanner/i);
  assert.match(sql, /CREATE TRIGGER settlement_scan_ranges_immutable[\s\S]*CREATE TRIGGER settlement_scan_blocks_immutable[\s\S]*CREATE TRIGGER settlement_scan_observations_immutable/i);
  assert.match(sql, /gavel_gate_catalog_manifest[\s\S]*pg_constraint[\s\S]*pg_index/);
  assert.match(sql, /sha256:gate-001-v3-postgres-parity/);
  const release = sql.match(/CREATE OR REPLACE FUNCTION gate\.release_expired_reservation[\s\S]*?END \$\$;/i)?.[0] || "";
  assert.ok(release.indexOf("FROM gate.settlement_cursors") < release.indexOf("FROM gate.quotes"), "cursor lock must precede quote lock");
  assert.doesNotMatch(sql, /GRANT[^;]*settlement_scan_(?:ranges|observations)/i);
});

test("scanner range retries accept only the exact durable outcome and recheck full coverage before release", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  const record = sql.match(/CREATE OR REPLACE FUNCTION gate\.record_scanner_range[\s\S]*?END \$\$;/i)?.[0] || "";
  assert.match(sql, /scanner_result jsonb NOT NULL/i);
  assert.match(record, /scan_generation=p_generation[\s\S]*scanner_result=p_metadata[\s\S]*RETURN 0/i);
  assert.match(record, /conflicting scanner generation replay/i);
  assert.match(record, /greatest\(c\.deployment_block,c\.next_range_from-overlap_blocks\)/i);
  assert.match(record, /next_range_from=greatest\(c\.next_range_from,p_through\+1\)/i);
  assert.match(record, /count\(\*\)[\s\S]*p_through-c\.deployment_block\+1/i);
  const coverageCheck = record.search(/p_through-c\.deployment_block\+1/i);
  const cursorAdvance = record.search(/UPDATE gate\.settlement_cursors/i);
  const release = record.search(/WITH eligible AS/i);
  assert.ok(coverageCheck >= 0 && coverageCheck < cursorAdvance && cursorAdvance < release,
    "durable full-range coverage must be proven before cursor advance and release");
});

test("latest canonical generation alone authorizes settlement and release while accepted reorgs are only flagged", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  const bindings = sql.match(/CREATE OR REPLACE FUNCTION gate\.validate_relational_bindings[\s\S]*?END \$\$;/i)?.[0] || "";
  const record = sql.match(/CREATE OR REPLACE FUNCTION gate\.record_scanner_range[\s\S]*?END \$\$;/i)?.[0] || "";
  assert.match(bindings, /max\(b\.scan_generation\)[\s\S]*o\.scan_generation|o\.scan_generation[\s\S]*max\(b\.scan_generation\)/i);
  assert.match(record, /settlement_reorged_at=COALESCE/i);
  assert.match(record, /status='SETTLEMENT_PENDING'/i);
  assert.match(record, /status=CASE[\s\S]*'QUOTED'[\s\S]*'EXPIRED'/i);
  assert.doesNotMatch(record, /DELETE FROM gate\.settlement_scan/);
});
