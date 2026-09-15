const {
  scannerWindow,
  settlementIdentity,
} = require("@gavel/gate");
const { QuoteExpiredError } = require("./store-errors");

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PUBLIC_ID = /^[A-Za-z0-9_-]{22}$/;
const KNOWN_LIFECYCLES = new Set(["VOTING", "CLOSED"]);

class SettlementRequestError extends Error {
  constructor(message, statusCode = 400, code = "INVALID_SETTLEMENT", state = statusCode === 400 ? "malformed" : undefined,
    updatedAt) {
    super(message); this.name = "SettlementRequestError"; this.statusCode = statusCode; this.code = code;
    this.state = state; this.updatedAt = updatedAt;
  }
}
function canonicalAddress(value, name) {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new SettlementRequestError(`${name} is invalid`);
  return value.toLowerCase();
}
function canonicalHash(value, name) {
  if (typeof value !== "string" || !HASH.test(value)) throw new SettlementRequestError(`${name} is invalid`);
  return value.toLowerCase();
}
function same(left, right) { return String(left).toLowerCase() === String(right).toLowerCase(); }
function exactMatch(quote, candidate, adapter) {
  const event = candidate.event || {};
  return quote.quoteVersion === 1
    && String(quote.baseChainId) === adapter.chainId && same(quote.splitter, adapter.splitter)
    && same(event.quoteId, quote.quoteId) && same(event.payer, quote.payer) && same(event.voter, quote.voter)
    && String(event.attentionAmount) === String(quote.attentionAmount)
    && String(event.gavelFeeAmount) === "250000" && String(quote.feeAmount) === "250000"
    && same(event.gavelRecipient, quote.gavelRecipient) && same(event.token, quote.token)
    && same(event.submissionHash, quote.submissionHash)
    && candidate.evidence?.canonical === true && candidate.evidence?.scannerVerified === true
    && candidate.evidence?.oneConfirmation === true
    && candidate.evidence?.confirmations === adapter.confirmationDepth
    && String(candidate.evidence.chainId) === adapter.chainId
    && same(candidate.evidence.splitter, adapter.splitter)
    && new Date(candidate.receiptBlockTimestamp) < new Date(quote.expiresAt);
}
function anomaly(candidate, code) {
  return {
    kind: "anomaly", txHash: candidate.txHash, logIndex: candidate.logIndex,
    blockNumber: candidate.receiptBlock, blockHash: candidate.receiptBlockHash,
    blockTimestamp: candidate.receiptBlockTimestamp, exactMatch: false, details: { code },
  };
}
function exactObservation(candidate) {
  return { kind: "exact_log", quoteId: candidate.quoteId, txHash: candidate.txHash, logIndex: candidate.logIndex,
    blockNumber: candidate.receiptBlock, blockHash: candidate.receiptBlockHash,
    blockTimestamp: candidate.receiptBlockTimestamp, exactMatch: true, details: { settlement: candidate } };
}
function bounded(operation, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("lifecycle read timed out")), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function createSettlementService({ store, adapter, lifecycleReader, lifecycleTimeoutMs = 2_000,
  operatorAlert, clock = () => new Date(), batchSize = 50 } = {}) {
  for (const method of ["recordSettlementHint", "getScannerState", "findSettlementQuote", "recordScannerRange",
    "listUnsettledSettlementObservations", "claimSettlementLifecycle", "recordSettlementLifecycle", "settle",
    "listPendingSettlementHints", "resolveSettlementHint", "claimSettlementMonitors", "advanceSettlementMonitor"]) {
    if (!store || typeof store[method] !== "function") throw new TypeError(`store.${method} is required`);
  }
  for (const method of ["getCanonicalHead", "getSafeHead", "scanRange", "inspectTransaction", "revalidateMonitor"]) {
    if (!adapter || typeof adapter[method] !== "function") throw new TypeError(`adapter.${method} is required`);
  }
  if (adapter.confirmationDepth !== 1) throw new TypeError("adapter.confirmationDepth must be exactly 1 for the MVP");
  if (typeof lifecycleReader !== "function") throw new TypeError("lifecycleReader must be a function");
  if (typeof operatorAlert !== "function") throw new TypeError("operatorAlert must be a function");
  if (!Number.isSafeInteger(lifecycleTimeoutMs) || lifecycleTimeoutMs < 1 || lifecycleTimeoutMs > 10_000) {
    throw new TypeError("lifecycleTimeoutMs must be from 1 to 10000");
  }

  async function submitTxHash({ session, publicId, txHash, chainId } = {}) {
    if (!session || session.role !== "base_sender") throw new SettlementRequestError("authentication required", 401, "UNAUTHORIZED");
    const payer = canonicalAddress(session.wallet, "session wallet");
    if (typeof publicId !== "string" || !PUBLIC_ID.test(publicId)) throw new SettlementRequestError("submission not found", 404, "NOT_FOUND");
    const transactionHash = canonicalHash(txHash, "transaction hash");
    let suppliedChain;
    try { suppliedChain = BigInt(chainId).toString(); } catch { throw new SettlementRequestError("settlement chain is invalid"); }
    if (suppliedChain !== adapter.chainId) throw new SettlementRequestError("settlement chain is invalid");
    let receipt;
    try {
      receipt = await store.recordSettlementHint({ publicId, payer, txHash: transactionHash,
        chainId: suppliedChain, splitter: adapter.splitter });
    } catch (error) {
      if (error instanceof QuoteExpiredError) {
        throw new SettlementRequestError("Quote expired", 410, "EXPIRED", "expired", error.updatedAt);
      }
      throw error;
    }
    if (!receipt) throw new SettlementRequestError("submission not found", 404, "NOT_FOUND", undefined);
    if (receipt.state === "expired") {
      throw new SettlementRequestError("Quote expired", 410, "EXPIRED", "expired", receipt.updatedAt);
    }
    return receipt;
  }

  function unavailableLifecycle(quote) {
    return { issuanceLifecycle: quote.issuanceLifecycle, currentLifecycle: "UNKNOWN", lifecycleChanged: false,
      currentLifecycleUnavailable: true, privateUnavailabilityReason: "current_lifecycle_unavailable" };
  }

  async function lifecycleFor(quote) {
    try {
      const current = await bounded(() => lifecycleReader({ dao: quote.dao, proposalId: quote.proposalId }), lifecycleTimeoutMs);
      if (!KNOWN_LIFECYCLES.has(current)) throw new Error("unknown lifecycle");
      return { issuanceLifecycle: quote.issuanceLifecycle, currentLifecycle: current,
        lifecycleChanged: current !== quote.issuanceLifecycle, currentLifecycleUnavailable: false };
    } catch {
      return unavailableLifecycle(quote);
    }
  }

  async function settleDurableObservations() {
    const observations = await store.listUnsettledSettlementObservations({
      chainId: adapter.chainId, splitter: adapter.splitter, limit: batchSize,
    });
    let accepted = 0;
    for (const { quoteId, settlement } of observations) {
      const quote = await store.findSettlementQuote(quoteId);
      if (!quote || !exactMatch(quote, settlement, adapter)) continue;
      const lifecycleClaim = await store.claimSettlementLifecycle({ quoteId: quote.quoteId,
        staleAfterMs: lifecycleTimeoutMs + 1_000 });
      if (!lifecycleClaim || lifecycleClaim.pending === true) continue;
      let inbox;
      if (lifecycleClaim.attempt === true) {
        inbox = await lifecycleFor(quote);
        await store.recordSettlementLifecycle({ quoteId: quote.quoteId, lifecycle: inbox });
      } else {
        inbox = lifecycleClaim.lifecycle || unavailableLifecycle(quote);
      }
      const ids = settlementIdentity({ chainId: adapter.chainId, splitter: adapter.splitter, quoteId: quote.quoteId });
      const result = await store.settle({ quoteId: quote.quoteId, settlement,
        inbox: { id: ids.inboxId, ...inbox },
        notification: { id: ids.notificationId, channel: "private", destinationRef: quote.destinationRef,
          summary: quote.trustedSummary, status: "pending" },
        monitor: { id: ids.monitorId, nextCheckBlock: (BigInt(settlement.receiptBlock) + 1n).toString() } });
      if (result !== false) accepted += 1;
    }
    return accepted;
  }

  async function scanOnce() {
    let accepted = 0;
    const safeThrough = await adapter.getSafeHead();
    const cursor = await store.getScannerState({ chainId: adapter.chainId, splitter: adapter.splitter });
    if (!cursor) throw new Error("settlement scanner deployment is not configured");
    if (Number(cursor.overlap) !== adapter.overlap) throw new Error("durable scanner overlap does not match adapter overlap");
    const requested = scannerWindow({ deploymentBlock: cursor.deploymentBlock, nextRangeFrom: cursor.nextRangeFrom,
      safeThrough, overlap: cursor.overlap });
    const window = requested && Object.freeze({ fromBlock: requested.fromBlock,
      throughBlock: requested.throughBlock - requested.fromBlock + 1n > BigInt(adapter.maxBlockRange)
        ? requested.fromBlock + BigInt(adapter.maxBlockRange) - 1n : requested.throughBlock });
    if (!window) return { scanned: 0, accepted, anomalies: 0 };
    const scanned = await adapter.scanRange(window);
    const unique = new Map();
    for (const item of scanned.candidates || []) unique.set(`${item.txHash}:${item.logIndex}`, item);
    const observations = [];
    for (const item of unique.values()) {
      const quote = await store.findSettlementQuote(item.quoteId);
      if (!quote) { observations.push(anomaly(item, "UNKNOWN_QUOTE")); continue; }
      if (!exactMatch(quote, item, adapter)) { observations.push(anomaly(item, "MISMATCHED_SETTLEMENT")); continue; }
      observations.push(exactObservation(item));
    }
    for (const item of scanned.anomalies || []) observations.push({ kind: "anomaly", txHash: item.txHash,
      logIndex: item.logIndex, blockNumber: String(item.blockNumber), blockHash: item.blockHash,
      blockTimestamp: item.blockTimestamp, exactMatch: false, details: { code: item.code || "INVALID_SETTLEMENT_EVIDENCE" } });
    const checkpoint = scanned.canonicalBlocks.at(-1);
    const persisted = await store.recordScannerRange({ deploymentId: cursor.deploymentId, generation: (BigInt(cursor.generation) + 1n).toString(),
      fromBlock: window.fromBlock.toString(), throughBlock: window.throughBlock.toString(),
      canonicalBlockHash: checkpoint.blockHash, canonicalBlockTimestamp: checkpoint.blockTimestamp,
      canonicalBlocks: scanned.canonicalBlocks, observations });
    if (Number(persisted?.reorged) > 0) {
      await operatorAlert({ code: "POST_ACCEPTANCE_SETTLEMENT_REORG", source: "scanner_overlap",
        chainId: adapter.chainId, splitter: adapter.splitter });
    }
    accepted += await settleDurableObservations();
    return { scanned: scanned.canonicalBlocks.length, accepted, anomalies: observations.filter((x) => x.kind === "anomaly").length };
  }

  async function reconcileSubmitted() {
    const pending = await store.listPendingSettlementHints({ limit: batchSize });
    let resolved = 0;
    for (const hint of pending) {
      const result = await adapter.inspectTransaction(hint.txHash);
      if (["pending", "unconfirmed"].includes(result.state)) continue;
      if (result.state === "matched") {
        const quote = await store.findSettlementQuote(hint.quoteId);
        if (quote && exactMatch(quote, result.candidate, adapter)) continue;
      }
      const state = new Date(hint.expiresAt) > new Date(clock()) ? "payment_required" : "expired";
      await store.resolveSettlementHint({ publicId: hint.publicId, txHash: hint.txHash, state }); resolved += 1;
    }
    return { checked: pending.length, resolved };
  }

  async function monitorOnce() {
    const head = await adapter.getCanonicalHead();
    const monitors = await store.claimSettlementMonitors({ chainId: adapter.chainId, splitter: adapter.splitter,
      headBlock: head.toString(), limit: 1, leaseMs: 5 * 60_000 });
    let reorged = 0; let completed = 0;
    for (const monitor of monitors) {
      const check = await adapter.revalidateMonitor(monitor);
      const final = head >= BigInt(monitor.receiptBlock) + 63n;
      const wasReorged = check.canonical !== true;
      const done = wasReorged || final;
      const advanced = await store.advanceSettlementMonitor({ id: monitor.id, claimToken: monitor.claimToken,
        progressBlock: head.toString(), nextCheckBlock: done ? null : (head + 1n).toString(), completed: done, reorged: wasReorged });
      if (advanced === false) continue;
      if (wasReorged) await operatorAlert({ code: "POST_ACCEPTANCE_SETTLEMENT_REORG", source: "monitor",
        chainId: adapter.chainId, splitter: adapter.splitter });
      if (wasReorged) reorged += 1;
      if (done) completed += 1;
    }
    return { checked: monitors.length, completed, reorged };
  }

  return Object.freeze({ submitTxHash, scanOnce, reconcileSubmitted, monitorOnce });
}

module.exports = { SettlementRequestError, createSettlementService };
