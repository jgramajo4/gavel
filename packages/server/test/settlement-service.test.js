const assert = require("node:assert/strict");
const test = require("node:test");
const { Interface } = require("ethers");
const { QUOTE_SETTLED_EVENT_ABI } = require("@gavel/gate");
const { createBaseSettlementAdapter } = require("../src/gate/base-settlement-adapter");
const { SettlementRequestError, createSettlementService } = require("../src/gate/settlement-service");
const { QuoteExpiredError } = require("../src/gate/store-errors");

const A = (digit) => `0x${digit.repeat(40)}`;
const H = (digit) => `0x${digit.repeat(64)}`;
const PAYER = A("1"); const VOTER = A("2"); const SPLITTER = A("3"); const GAVEL = A("4"); const TOKEN = A("5");
const QUOTE_ID = H("6"); const SUBMISSION_HASH = H("7"); const TX = H("8"); const BLOCK_HASH = H("9");
const iface = new Interface([QUOTE_SETTLED_EVENT_ABI]);
function rpcBlockHash(number) { return Number(number) === 10 ? BLOCK_HASH : `0x${Number(number).toString(16).padStart(64, "0")}`; }
function chainLog(overrides = {}) {
  const encoded = iface.encodeEventLog(iface.getEvent("QuoteSettled"), [
    QUOTE_ID, PAYER, VOTER, 1_000_000n, GAVEL, 250_000n, TOKEN, SUBMISSION_HASH,
  ]);
  return { address: SPLITTER, topics: encoded.topics, data: encoded.data, transactionHash: TX, index: 2,
    blockNumber: 10, blockHash: BLOCK_HASH, ...overrides };
}
function rpc(overrides = {}) {
  const log = chainLog();
  return {
    async getChainId() { return 8453; },
    async getBlockNumber() { return 12; },
    async getBlock(number) { return { number: Number(number), hash: rpcBlockHash(number),
      parentHash: rpcBlockHash(Number(number) - 1), timestamp: 100,
      transactions: Number(number) === 10 ? [TX] : [] }; },
    async getBlockTransactionCount(number) { return Number(number) === 10 ? 1 : 0; },
    async getLogs() { return [log]; },
    async getBlockReceipts(number) {
      return Number(number) === 10 ? [await this.getTransactionReceipt(TX)] : [];
    },
    async getTransactionReceipt() { return { status: 1, transactionHash: TX, blockNumber: 10, blockHash: BLOCK_HASH, logs: [log] }; },
    async getTransaction() { return { hash: TX }; },
    ...overrides,
  };
}
function quote(overrides = {}) {
  return { quoteId: QUOTE_ID, payer: PAYER, voter: VOTER, attentionAmount: "1000000", feeAmount: "250000",
    gavelRecipient: GAVEL, token: TOKEN, submissionHash: SUBMISSION_HASH, quoteVersion: 1, baseChainId: "8453",
    splitter: SPLITTER, expiresAt: new Date(101_000), issuanceLifecycle: "VOTING", dao: "nouns", proposalId: "42",
    trustedSummary: { subject: "New paid pitch", text: "A paid pitch is ready." }, destinationRef: "opaque:delivery-1", ...overrides };
}
function candidate(overrides = {}) {
  return { quoteId: QUOTE_ID, txHash: TX, logIndex: 2, receiptBlock: "10", receiptBlockHash: BLOCK_HASH,
    receiptBlockTimestamp: new Date(100_000), settledAt: new Date(102_000),
    event: { quoteId: QUOTE_ID, payer: PAYER, voter: VOTER, attentionAmount: "1000000", gavelRecipient: GAVEL,
      gavelFeeAmount: "250000", token: TOKEN, submissionHash: SUBMISSION_HASH },
    evidence: { chainId: "8453", splitter: SPLITTER, canonical: true, scannerVerified: true, oneConfirmation: true, confirmations: 1 },
    ...overrides };
}
function fakeHarness(options = {}) {
  const calls = [];
  const state = { q: options.quote === null ? null : quote(options.quote), candidate: candidate(options.candidate),
    safeHead: options.safeHead ?? 12n, canonicalHead: options.canonicalHead ?? options.safeHead ?? 12n,
    lifecycle: options.lifecycle ?? "VOTING", settlement: null, pending: [], lifecycleAttempted: false,
    persistedLifecycle: null, unsettled: options.unsettled ?? [] };
  const store = {
    async recordSettlementHint(value) {
      calls.push(["hint", value]);
      if (options.hintError) throw options.hintError;
      return { publicId: value.publicId, state: "pending_settlement", updatedAt: new Date(0) };
    },
    async getScannerState() { calls.push(["cursor"]); return { deploymentId: "deployment-1",
      deploymentBlock: options.deploymentBlock ?? "5", nextRangeFrom: options.nextRangeFrom ?? "10",
      generation: options.generation ?? "4", overlap: options.storeOverlap ?? 64 }; },
    async findSettlementQuote(id) { calls.push(["quote", id]); return id === QUOTE_ID ? state.q : null; },
    async recordScannerRange(value) {
      calls.push(["range", value]);
      state.unsettled = value.observations.filter((item) => item.kind === "exact_log")
        .map((item) => ({ quoteId: item.quoteId, settlement: item.details.settlement }));
      return options.rangeResult ?? { released: 0 };
    },
    async listUnsettledSettlementObservations() { calls.push(["unsettled"]); return state.unsettled; },
    async claimSettlementLifecycle(value) {
      calls.push(["claimLifecycle", value]);
      if (options.lifecycleClaimPending) return { attempt: false, pending: true, lifecycle: null };
      if (!state.lifecycleAttempted) { state.lifecycleAttempted = true; return { attempt: true, pending: false, lifecycle: null }; }
      return { attempt: false, pending: false, lifecycle: state.persistedLifecycle };
    },
    async recordSettlementLifecycle(value) { calls.push(["recordLifecycle", value]); state.persistedLifecycle = value.lifecycle; return true; },
    async settle(value) {
      calls.push(["settle", value]);
      if (options.settleError) throw options.settleError;
      state.settlement = value; state.unsettled = state.unsettled.filter((item) => item.quoteId !== value.quoteId);
      return { settled: true, inboxCreatedAt: new Date(103_000) };
    },
    async listPendingSettlementHints() { return state.pending; },
    async resolveSettlementHint(value) { calls.push(["resolve", value]); },
    async claimSettlementMonitors(value) { calls.push(["claimMonitors", value]); return options.monitors ?? []; },
    async advanceSettlementMonitor(value) { calls.push(["monitor", value]); return true; },
  };
  const adapter = {
    chainId: "8453", splitter: SPLITTER, confirmationDepth: 1, overlap: options.adapterOverlap ?? 64,
    maxBlockRange: options.maxBlockRange ?? 5_000,
    async getSafeHead() { return state.safeHead; },
    async getCanonicalHead() { return state.canonicalHead; },
    async scanRange(range) { calls.push(["scan", range]); return {
      canonicalBlocks: Array.from({ length: Number(range.throughBlock - range.fromBlock + 1n) }, (_, index) => ({
        blockNumber: String(range.fromBlock + BigInt(index)), blockHash: H("a"), blockTimestamp: new Date(100_000),
      })), candidates: options.candidates ?? [state.candidate], anomalies: options.anomalies ?? [],
    }; },
    async inspectTransaction(hash) { calls.push(["inspect", hash]); return options.txState ?? { state: "pending" }; },
    async revalidateMonitor(monitor) {
      calls.push(["revalidate", monitor.id]);
      if (options.revalidationError) throw options.revalidationError;
      return options.revalidation ?? { canonical: true };
    },
  };
  let lifecycleCalls = 0;
  const lifecycleReader = options.lifecycleReader ?? (async () => { lifecycleCalls += 1; if (options.lifecycleError) throw options.lifecycleError; return state.lifecycle; });
  const countedLifecycleReader = options.lifecycleReader
    ? async (...args) => { lifecycleCalls += 1; return options.lifecycleReader(...args); }
    : lifecycleReader;
  const operatorAlerts = [];
  const service = createSettlementService({ store, adapter, lifecycleReader: countedLifecycleReader, lifecycleTimeoutMs: options.lifecycleTimeoutMs ?? 20,
    operatorAlert: options.operatorAlert ?? (async (alert) => { operatorAlerts.push(alert); }), clock: () => new Date(102_000) });
  return { calls, state, store, adapter, service, operatorAlerts, lifecycleCalls: () => lifecycleCalls };
}

test("6. Base adapter verifies receipt success, canonical block evidence, and one-confirmation safe head", async () => {
  const adapter = createBaseSettlementAdapter({ client: rpc(), chainId: 8453, splitter: SPLITTER,
    confirmationDepth: 1, clock: () => new Date(102_000) });
  assert.equal(await adapter.getSafeHead(), 12n);
  assert.equal(await adapter.getCanonicalHead(), 12n);
  const result = await adapter.scanRange({ fromBlock: 10n, throughBlock: 10n });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].evidence.confirmations, 1);
  assert.deepEqual(result.candidates[0].event, candidate().event);
  assert.equal(result.candidates[0].receiptBlockTimestamp.valueOf(), 100_000);
  assert.equal(result.candidates[0].settledAt.valueOf(), 100_000);
});

test("6a. scanner derives release evidence from complete block receipts when filtered logs omit a payment", async () => {
  const adapter = createBaseSettlementAdapter({
    client: rpc({ getLogs: async () => [] }),
    chainId: 8453,
    splitter: SPLITTER,
  });

  const result = await adapter.scanRange({ fromBlock: 10n, throughBlock: 10n });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].quoteId, QUOTE_ID);
});

test("6b. scanner aborts rather than releasing capacity when block receipts omit a transaction", async () => {
  const adapter = createBaseSettlementAdapter({
    client: rpc({ getBlockReceipts: async () => [] }),
    chainId: 8453,
    splitter: SPLITTER,
  });

  await assert.rejects(adapter.scanRange({ fromBlock: 10n, throughBlock: 10n }), /receipt count.*incomplete/i);
});

test("6c. scanner aborts when receipt identities do not equal the canonical block transaction set", async () => {
  const adapter = createBaseSettlementAdapter({
    client: rpc({ getTransactionReceipt: async () => ({ status: 1, transactionHash: H("a"),
      blockNumber: 10, blockHash: BLOCK_HASH, logs: [] }) }),
    chainId: 8453,
    splitter: SPLITTER,
  });

  await assert.rejects(adapter.scanRange({ fromBlock: 10n, throughBlock: 10n }), /receipt transaction set.*incomplete/i);
});

test("7. Base adapter records malformed or failed target receipt evidence as anomalies", async () => {
  for (const client of [
    rpc({ getTransactionReceipt: async () => ({ status: 0, transactionHash: TX,
      blockNumber: 10, blockHash: BLOCK_HASH, logs: [chainLog()] }) }),
    rpc({ getTransactionReceipt: async () => ({ status: 1, transactionHash: TX,
      blockNumber: 10, blockHash: BLOCK_HASH,
      logs: [chainLog({ data: "0x12" })] }) }),
  ]) {
    const adapter = createBaseSettlementAdapter({ client, chainId: 8453, splitter: SPLITTER });
    const result = await adapter.scanRange({ fromBlock: 10n, throughBlock: 10n });
    assert.equal(result.candidates.length, 0);
    assert.equal(result.anomalies.length, 1);
  }

  const noncanonical = createBaseSettlementAdapter({
    client: rpc({ getBlock: async (number) => ({ number: Number(number), hash: H("f"), parentHash: H("e"),
      timestamp: 100, transactions: Number(number) === 10 ? [TX] : [] }) }),
    chainId: 8453,
    splitter: SPLITTER,
  });
  await assert.rejects(noncanonical.scanRange({ fromBlock: 10n, throughBlock: 10n }), /block receipts.*not canonical/i);
});

test("7a. receipt RPC failures abort the scanner range without recording its cursor", async () => {
  const timeout = Object.assign(new Error("receipt RPC timed out"), { code: "ETIMEDOUT" });
  const adapter = createBaseSettlementAdapter({
    client: rpc({ getTransactionReceipt: async () => { throw timeout; } }),
    chainId: 8453,
    splitter: SPLITTER,
  });
  const h = fakeHarness({ candidates: [] });
  h.adapter.scanRange = adapter.scanRange;

  await assert.rejects(h.service.scanOnce(), (error) => error === timeout);
  assert.equal(h.calls.some(([name]) => name === "range"), false);

  const incomplete = createBaseSettlementAdapter({
    client: rpc({ getTransactionReceipt: async () => ({ status: 1, blockNumber: 10, blockHash: BLOCK_HASH,
      logs: [{ address: SPLITTER, topics: [chainLog().topics[0]], data: "0x", blockNumber: 10, blockHash: BLOCK_HASH, index: 2 }] }) }),
    chainId: 8453, splitter: SPLITTER,
  });
  await assert.rejects(incomplete.scanRange({ fromBlock: 10n, throughBlock: 10n }), /receipts? RPC result is incomplete/);
});

test("7b. Base adapter verifies the RPC chain identity instead of trusting its configured label", async () => {
  const adapter = createBaseSettlementAdapter({ client: rpc({ getChainId: async () => 1 }), chainId: 8453, splitter: SPLITTER });
  await assert.rejects(adapter.getSafeHead(), /RPC chain.*8453/i);
  await assert.rejects(adapter.scanRange({ fromBlock: 10n, throughBlock: 10n }), /RPC chain.*8453/i);
});

test("7c. Base adapter rejects canonical block snapshots whose parent linkage mixes forks", async () => {
  const adapter = createBaseSettlementAdapter({
    client: rpc({
      getLogs: async () => [],
      getBlock: async (number) => ({
        number: Number(number),
        hash: Number(number) === 10 ? H("9") : H("a"),
        parentHash: H("f"),
        timestamp: 100,
        transactions: Number(number) === 10 ? [TX] : [],
      }),
    }),
    chainId: 8453,
    splitter: SPLITTER,
  });

  await assert.rejects(adapter.scanRange({ fromBlock: 10n, throughBlock: 11n }), /parent.*canonical|ancestry/i);
});

test("7d. Base adapter aborts when a range boundary changes during collection", async () => {
  let blockReads = 0;
  const adapter = createBaseSettlementAdapter({
    client: rpc({
      getLogs: async () => [],
      getBlock: async (number) => {
        blockReads += 1;
        if (Number(number) === 10) return { number: 10, hash: blockReads > 2 ? H("b") : H("9"),
          parentHash: H("0"), timestamp: 100, transactions: [TX] };
        return { number: 11, hash: H("a"), parentHash: H("9"), timestamp: 101, transactions: [] };
      },
    }),
    chainId: 8453,
    splitter: SPLITTER,
  });

  await assert.rejects(adapter.scanRange({ fromBlock: 10n, throughBlock: 11n }), /changed.*scan|canonical.*changed/i);
});

test("7e. Base adapter exposes a bounded configurable scan span", () => {
  const adapter = createBaseSettlementAdapter({ client: rpc(), chainId: 8453, splitter: SPLITTER,
    overlap: 64, maxBlockRange: 500 });
  assert.equal(adapter.maxBlockRange, 500);
  assert.throws(() => createBaseSettlementAdapter({ client: rpc(), chainId: 8453, splitter: SPLITTER,
    overlap: 64, maxBlockRange: 64 }), /maxBlockRange.*overlap/i);
});

test("7f. transient monitor RPC failures abort revalidation instead of becoming reorg evidence", async () => {
  const timeout = Object.assign(new Error("monitor receipt RPC timed out"), { code: "ETIMEDOUT" });
  const adapter = createBaseSettlementAdapter({
    client: rpc({ getTransactionReceipt: async () => { throw timeout; } }),
    chainId: 8453,
    splitter: SPLITTER,
  });
  await assert.rejects(adapter.revalidateMonitor({
    quoteId: QUOTE_ID, receiptBlock: "10", receiptBlockHash: BLOCK_HASH, txHash: TX, logIndex: 2,
  }), (error) => error === timeout);
  const incomplete = createBaseSettlementAdapter({
    client: rpc({ getTransactionReceipt: async () => null }), chainId: 8453, splitter: SPLITTER,
  });
  await assert.rejects(incomplete.revalidateMonitor({
    quoteId: QUOTE_ID, receiptBlock: "10", receiptBlockHash: BLOCK_HASH, txHash: TX, logIndex: 2,
  }), /receipt RPC result is incomplete/);
});

test("7g. hung Base RPC calls time out so serialized jobs can retry", async () => {
  const adapter = createBaseSettlementAdapter({
    client: rpc({ getBlockNumber: async () => new Promise(() => {}) }),
    chainId: 8453,
    splitter: SPLITTER,
    rpcTimeoutMs: 10,
  });
  await assert.rejects(adapter.getCanonicalHead(), /Base RPC getBlockNumber timed out/);
});

test("8. submitted browser hash authenticates exact base_sender owner and stores pending only", async () => {
  const h = fakeHarness();
  const response = await h.service.submitTxHash({ session: { role: "base_sender", wallet: PAYER }, publicId: "A".repeat(22),
    txHash: TX, chainId: "8453" });
  assert.equal(response.state, "pending_settlement");
  assert.equal(h.calls.some(([name]) => name === "settle"), false);
  assert.deepEqual(h.calls[0][1], { publicId: "A".repeat(22), payer: PAYER, txHash: TX, chainId: "8453", splitter: SPLITTER });
});

test("9. settlement submission rejects wrong role, malformed hash, wrong chain, and non-owner store result", async () => {
  const h = fakeHarness();
  await assert.rejects(h.service.submitTxHash({ session: { role: "dao_inbox", wallet: PAYER }, publicId: "A".repeat(22), txHash: TX, chainId: "8453" }), SettlementRequestError);
  await assert.rejects(h.service.submitTxHash({ session: { role: "base_sender", wallet: PAYER }, publicId: "A".repeat(22), txHash: "0x12", chainId: "8453" }),
    (error) => error.state === "malformed" && /transaction hash/i.test(error.message));
  await assert.rejects(h.service.submitTxHash({ session: { role: "base_sender", wallet: PAYER }, publicId: "A".repeat(22), txHash: TX, chainId: "1" }),
    (error) => error.state === "malformed" && /chain/i.test(error.message));
  h.store.recordSettlementHint = async () => null;
  await assert.rejects(h.service.submitTxHash({ session: { role: "base_sender", wallet: PAYER }, publicId: "A".repeat(22), txHash: TX, chainId: "8453" }), /not found/i);
});

test("9a. expired quote hints become a frozen coarse Gone error", async () => {
  const updatedAt = new Date("2026-01-01T00:00:00.000Z");
  const h = fakeHarness({ hintError: new QuoteExpiredError(updatedAt) });
  await assert.rejects(h.service.submitTxHash({ session: { role: "base_sender", wallet: PAYER },
    publicId: "A".repeat(22), txHash: TX, chainId: "8453" }), (error) => {
    assert.ok(error instanceof SettlementRequestError);
    assert.deepEqual({ statusCode: error.statusCode, code: error.code, message: error.message,
      state: error.state, updatedAt: error.updatedAt },
    { statusCode: 410, code: "EXPIRED", message: "Quote expired", state: "expired", updatedAt });
    return true;
  });
});

test("10. canonical expected log settles without any submitted transaction hash", async () => {
  const h = fakeHarness();
  const result = await h.service.scanOnce();
  assert.equal(result.accepted, 1);
  assert.equal(h.state.settlement.quoteId, QUOTE_ID);
  assert.equal(h.calls.some(([name]) => name === "hint"), false);
});

test("11. scanner resumes durable cursor and rescans the default 64-block overlap", async () => {
  const h = fakeHarness({ candidates: [] });
  await h.service.scanOnce();
  const scan = h.calls.find(([name]) => name === "scan")[1];
  assert.deepEqual(scan, { fromBlock: 5n, throughBlock: 12n });
  const range = h.calls.find(([name]) => name === "range")[1];
  assert.equal(range.generation, "5");
});

test("12. unknown quote IDs create only redacted scanner anomalies", async () => {
  const unknown = candidate({ quoteId: H("f"), event: { ...candidate().event, quoteId: H("f") } });
  const h = fakeHarness({ candidates: [unknown] });
  const result = await h.service.scanOnce();
  assert.equal(result.accepted, 0);
  assert.equal(h.calls.some(([name]) => name === "settle"), false);
  const range = h.calls.find(([name]) => name === "range")[1];
  assert.deepEqual(range.observations[0].details, { code: "UNKNOWN_QUOTE" });
  assert.equal(JSON.stringify(range).includes(PAYER), false);
});

test("13. every persisted quote/event/economics/deployment binding and quote version is compared", async () => {
  const fields = ["payer", "voter", "attentionAmount", "feeAmount", "gavelRecipient", "token", "submissionHash", "quoteVersion", "baseChainId", "splitter"];
  for (const field of fields) {
    const patch = field === "quoteVersion" ? 2 : field.endsWith("Amount") ? "999999" : field === "baseChainId" ? "1"
      : field === "submissionHash" ? H("f") : A("f");
    const h = fakeHarness({ quote: { [field]: patch } });
    const result = await h.service.scanOnce();
    assert.equal(result.accepted, 0, field);
    assert.equal(h.calls.some(([name]) => name === "settle"), false, field);
  }
});

test("14. receipt block timestamp must be strictly before expiry", async () => {
  for (const timestamp of [new Date(101_000), new Date(102_000)]) {
    const h = fakeHarness({ candidate: { receiptBlockTimestamp: timestamp } });
    assert.equal((await h.service.scanOnce()).accepted, 0);
  }
  const before = fakeHarness({ candidate: { receiptBlockTimestamp: new Date(100_999) } });
  assert.equal((await before.service.scanOnce()).accepted, 1);
});

test("15. known lifecycle is read exactly once and changed iff it differs from issuance", async () => {
  const h = fakeHarness({ lifecycle: "CLOSED" });
  await h.service.scanOnce();
  assert.equal(h.lifecycleCalls(), 1);
  assert.deepEqual({ current: h.state.settlement.inbox.currentLifecycle, changed: h.state.settlement.inbox.lifecycleChanged,
    unavailable: h.state.settlement.inbox.currentLifecycleUnavailable }, { current: "CLOSED", changed: true, unavailable: false });
});

test("16. unavailable, timeout, stale, and UNKNOWN lifecycle never veto acceptance or retry", async () => {
  for (const options of [
    { lifecycleError: new Error("offline") },
    { lifecycle: "UNKNOWN" },
    { lifecycleError: Object.assign(new Error("stale"), { code: "STALE" }) },
    { lifecycleReader: () => new Promise(() => {}) },
  ]) {
    const h = options.lifecycleReader ? fakeHarness({ ...options, lifecycleTimeoutMs: 2 }) : fakeHarness(options);
    const result = await h.service.scanOnce();
    assert.equal(result.accepted, 1);
    assert.equal(h.lifecycleCalls(), 1);
    assert.equal(h.state.settlement.inbox.currentLifecycle, "UNKNOWN");
    assert.equal(h.state.settlement.inbox.currentLifecycleUnavailable, true);
  }
});

test("17. settlement critical path reruns no profile, policy, capacity, price, sender, or eligibility veto", async () => {
  const h = fakeHarness();
  for (const forbidden of ["getProfile", "getPolicy", "isProfileAccepting", "checkSender", "getPrice", "getEligibility"]) {
    h.store[forbidden] = async () => { throw new Error(`${forbidden} must not run`); };
  }
  assert.equal((await h.service.scanOnce()).accepted, 1);
});

test("18. pending stays pending; dropped/reverted/mismatched resolve to quoted while valid and expired otherwise", async () => {
  for (const [txState, expected] of [["pending", "pending_settlement"], ["unconfirmed", "pending_settlement"],
    ["dropped", "payment_required"], ["reverted", "payment_required"], ["mismatched", "payment_required"]]) {
    const h = fakeHarness({ txState: { state: txState } }); h.state.pending = [{ publicId: "A".repeat(22), quoteId: QUOTE_ID, txHash: TX, expiresAt: new Date(200_000) }];
    await h.service.reconcileSubmitted();
    const resolved = h.calls.find(([name]) => name === "resolve");
    if (txState === "pending" || txState === "unconfirmed") assert.equal(resolved, undefined);
    else assert.equal(resolved[1].state, expected);
  }
  const expired = fakeHarness({ txState: { state: "dropped" } }); expired.state.pending = [{ publicId: "A".repeat(22), txHash: TX, expiresAt: new Date(100_000) }];
  await expired.service.reconcileSubmitted();
  assert.equal(expired.calls.find(([name]) => name === "resolve")[1].state, "expired");
});

test("18a. a submitted tx whose expected event belongs to another or mismatched quote is not left pending", async () => {
  for (const mismatched of [candidate({ event: { ...candidate().event, quoteId: `0x${"9".repeat(64)}` } }),
    candidate({ event: { ...candidate().event, payer: `0x${"9".repeat(40)}` } })]) {
    const h = fakeHarness({ txState: { state: "matched", candidate: mismatched } });
    h.state.pending = [{ publicId: "A".repeat(22), quoteId: QUOTE_ID, txHash: TX, expiresAt: new Date(200_000) }];
    await h.service.reconcileSubmitted();
    assert.equal(h.calls.find(([name]) => name === "resolve")[1].state, "payment_required");
  }
});

test("19. accepted monitor claims only at the canonical head and advances durable scheduling before 64 confirmations", async () => {
  const monitor = { id: "m", claimToken: "7", quoteId: QUOTE_ID, receiptBlock: "10", receiptBlockHash: BLOCK_HASH, txHash: TX, logIndex: 2 };
  const pending = fakeHarness({ safeHead: 60n, canonicalHead: 72n, monitors: [monitor] });
  await pending.service.monitorOnce();
  assert.deepEqual(pending.calls.find(([name]) => name === "claimMonitors")[1], {
    chainId: "8453", splitter: SPLITTER, headBlock: "72", limit: 1, leaseMs: 300000,
  });
  assert.deepEqual(pending.calls.find(([name]) => name === "monitor")[1], {
    id: "m", claimToken: "7", progressBlock: "72", nextCheckBlock: "73", completed: false, reorged: false,
  });
});

test("19a. final monitor check uses 64 canonical confirmations independent of acceptance confirmation depth", async () => {
  const monitor = { id: "m", claimToken: "7", quoteId: QUOTE_ID, receiptBlock: "10", receiptBlockHash: BLOCK_HASH, txHash: TX, logIndex: 2 };
  const final = fakeHarness({ safeHead: 60n, canonicalHead: 73n, monitors: [monitor] });
  final.adapter.confirmationDepth = 20;
  await final.service.monitorOnce();
  assert.deepEqual(final.calls.find(([name]) => name === "monitor")[1], {
    id: "m", claimToken: "7", progressBlock: "73", nextCheckBlock: null, completed: true, reorged: false,
  });
});

test("19b. post-acceptance monitor reorg preserves acceptance and emits only a narrow redacted operator alert", async () => {
  const monitor = { id: "m", claimToken: "8", quoteId: QUOTE_ID, receiptBlock: "10", receiptBlockHash: BLOCK_HASH, txHash: TX, logIndex: 2 };
  const reorg = fakeHarness({ canonicalHead: 20n, monitors: [monitor], revalidation: { canonical: false } });
  await reorg.service.monitorOnce();
  assert.deepEqual(reorg.calls.find(([name]) => name === "monitor")[1], {
    id: "m", claimToken: "8", progressBlock: "20", nextCheckBlock: null, completed: true, reorged: true,
  });
  assert.equal(reorg.calls.some(([name]) => name === "resolve"), false);
  assert.deepEqual(reorg.operatorAlerts, [{ code: "POST_ACCEPTANCE_SETTLEMENT_REORG", source: "monitor",
    chainId: "8453", splitter: SPLITTER }]);
  assert.equal(JSON.stringify(reorg.operatorAlerts).includes(QUOTE_ID), false);
  assert.equal(JSON.stringify(reorg.operatorAlerts).includes(TX), false);
});

test("19c. transient monitor RPC failure leaves the durable monitor active for lease-expiry retry", async () => {
  const timeout = Object.assign(new Error("monitor RPC timed out"), { code: "ETIMEDOUT" });
  const monitor = { id: "m", claimToken: "9", quoteId: QUOTE_ID, receiptBlock: "10", receiptBlockHash: BLOCK_HASH, txHash: TX, logIndex: 2 };
  const h = fakeHarness({ canonicalHead: 73n, monitors: [monitor], revalidationError: timeout });
  await assert.rejects(h.service.monitorOnce(), (error) => error === timeout);
  assert.equal(h.calls.some(([name]) => name === "monitor"), false);
  assert.deepEqual(h.operatorAlerts, []);
});

test("19d. trailing-overlap reorg persistence emits the same narrow redacted operator alert", async () => {
  const h = fakeHarness({ candidates: [], rangeResult: { released: 0, reorged: 1 } });
  await h.service.scanOnce();
  assert.deepEqual(h.operatorAlerts, [{ code: "POST_ACCEPTANCE_SETTLEMENT_REORG", source: "scanner_overlap",
    chainId: "8453", splitter: SPLITTER }]);
  assert.equal(JSON.stringify(h.operatorAlerts).includes(QUOTE_ID), false);
  assert.equal(JSON.stringify(h.operatorAlerts).includes(TX), false);
});

test("20. duplicate scanner candidates are idempotently reduced to one settlement attempt", async () => {
  const h = fakeHarness({ candidates: [candidate(), candidate()] });
  const result = await h.service.scanOnce();
  assert.equal(result.accepted, 1);
  assert.equal(h.calls.filter(([name]) => name === "settle").length, 1);
});

test("21. scanner rejects overlap drift between durable deployment config and adapter", async () => {
  const h = fakeHarness({ candidates: [], storeOverlap: 32, adapterOverlap: 64 });
  await assert.rejects(h.service.scanOnce(), /overlap.*does not match/i);
  assert.equal(h.calls.some(([name]) => name === "scan"), false);
});

test("22. scanner limits each range while preserving the frozen overlap window", async () => {
  const h = fakeHarness({ candidates: [], safeHead: 10_000n, maxBlockRange: 100 });
  await h.service.scanOnce();
  assert.deepEqual(h.calls.find(([name]) => name === "scan")[1], { fromBlock: 5n, throughBlock: 104n });
});

test("23. a persisted exact observation is recovered before the next scanner range", async () => {
  const persisted = candidate({ settledAt: new Date(101_000) });
  const h = fakeHarness({ unsettled: [{ quoteId: QUOTE_ID, settlement: persisted }], candidates: [persisted] });
  const result = await h.service.scanOnce();
  assert.equal(result.accepted, 1);
  assert.ok(h.calls.findIndex(([name]) => name === "scan") < h.calls.findIndex(([name]) => name === "settle"));
  assert.equal(h.state.settlement.settlement.settledAt.valueOf(), 101_000);
});

test("24. scanner persists lifecycle-attempt state and never retries the read after settlement rollback", async () => {
  const options = { settleError: new Error("simulated crash boundary") };
  const h = fakeHarness(options);
  await assert.rejects(h.service.scanOnce(), /simulated crash boundary/);
  const range = h.calls.find(([name]) => name === "range")[1];
  assert.deepEqual(range.observations[0].details.settlement, h.state.candidate);
  assert.ok(h.calls.findIndex(([name]) => name === "range") < h.calls.findIndex(([name]) => name === "settle"));
  assert.equal(h.state.unsettled.length, 1);
  assert.equal(h.lifecycleCalls(), 1);
  delete options.settleError;
  assert.equal((await h.service.scanOnce()).accepted, 1);
  assert.equal(h.lifecycleCalls(), 1);
});

test("25. a lagging safe head drains a current-generation durable observation without scanning or moving the cursor", async () => {
  const durable = candidate({ settledAt: new Date(101_000) });
  const h = fakeHarness({ nextRangeFrom: "100", safeHead: 34n,
    unsettled: [{ quoteId: QUOTE_ID, settlement: durable }], candidates: [] });

  assert.deepEqual(await h.service.scanOnce(), { scanned: 0, accepted: 1, anomalies: 0 });
  assert.equal(h.state.settlement.settlement, durable);
  assert.equal(h.calls.some(([name]) => name === "scan" || name === "range"), false);
  assert.deepEqual(h.operatorAlerts, []);

  assert.deepEqual(await h.service.scanOnce(), { scanned: 0, accepted: 0, anomalies: 0 });
  assert.equal(h.calls.filter(([name]) => name === "settle").length, 1);
  assert.equal(h.calls.some(([name]) => name === "scan" || name === "range"), false);
});

test("25a. durable observations settle while the safe head is before deployment", async () => {
  const h = fakeHarness({ deploymentBlock: "5", nextRangeFrom: "100", safeHead: 4n,
    unsettled: [{ quoteId: QUOTE_ID, settlement: candidate() }], candidates: [] });

  assert.deepEqual(await h.service.scanOnce(), { scanned: 0, accepted: 1, anomalies: 0 });
  assert.equal(h.calls.some(([name]) => name === "scan" || name === "range"), false);
});

test("25b. a shallow head regression neither fabricates canonical coverage nor releases capacity", async () => {
  const h = fakeHarness({ nextRangeFrom: "100", safeHead: 35n,
    unsettled: [{ quoteId: QUOTE_ID, settlement: candidate() }], candidates: [] });

  assert.deepEqual(await h.service.scanOnce(), { scanned: 0, accepted: 1, anomalies: 0 });
  assert.equal(h.calls.some(([name]) => name === "scan" || name === "range"), false);
  assert.deepEqual(h.operatorAlerts, []);
});

test("25c. a pending lifecycle claim remains retryable when the safe head is lagging", async () => {
  const h = fakeHarness({ nextRangeFrom: "100", safeHead: 34n, lifecycleClaimPending: true,
    unsettled: [{ quoteId: QUOTE_ID, settlement: candidate() }], candidates: [] });

  assert.deepEqual(await h.service.scanOnce(), { scanned: 0, accepted: 0, anomalies: 0 });
  assert.equal(h.calls.filter(([name]) => name === "claimLifecycle").length, 1);
  assert.equal(h.calls.some(([name]) => name === "settle" || name === "scan" || name === "range"), false);
  assert.equal(h.state.unsettled.length, 1);
});

test("25d. a lagging safe head with no durable observations is a no-op", async () => {
  const h = fakeHarness({ nextRangeFrom: "100", safeHead: 34n, unsettled: [], candidates: [] });

  assert.deepEqual(await h.service.scanOnce(), { scanned: 0, accepted: 0, anomalies: 0 });
  assert.equal(h.calls.some(([name]) => name === "scan" || name === "range" || name === "settle"), false);
});
