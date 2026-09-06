const { DAO_CONFIGS } = require("./config");
const { redactErrorMessage } = require("./redaction");

class GovernanceSyncWorker {
  constructor({ store, sources, batchSize = 20_000, concurrency = 4, retries = 3, fullScanIntervalMs = 6 * 60 * 60 * 1000, logger = null }) { this.store = store; this.sources = sources; this.batchSize = batchSize; this.concurrency = concurrency; this.retries = retries; this.fullScanIntervalMs = Number(fullScanIntervalMs); this.logger = logger || { info() {}, warn() {}, error() {} }; if (!store) throw new TypeError("store is required"); if (!Number.isFinite(this.fullScanIntervalMs) || this.fullScanIntervalMs < 0) throw new RangeError("fullScanIntervalMs must be a non-negative number"); }
  async syncDao(daoId, options = {}) {
    const source = this.sources[daoId]; if (!source) throw new Error(`No source configured for ${daoId}`);
    const run = () => this._syncDao(daoId, source, options);
    return this.store.withSourceLock ? this.store.withSourceLock(daoId, source.id, run) : run();
  }
  _shouldFullScan(checkpoint, options) {
    if (options.fullProposalScan != null) return Boolean(options.fullProposalScan);
    if (!checkpoint || options.fromBlock != null) return true;
    if (!checkpoint.lastFullScanAt) return true;
    const age = Date.now() - new Date(checkpoint.lastFullScanAt).getTime();
    return !Number.isFinite(age) || age >= this.fullScanIntervalMs;
  }

  async _proposalContext(daoId, full) {
    if (full || typeof this.store.getProposalSyncContext !== "function") return { refreshProposals: [], maxProposalId: null };
    return this.store.getProposalSyncContext(daoId);
  }

  async _syncDao(daoId, source, options) {
    await this.store.transaction(async (tx) => {
      const config = DAO_CONFIGS[daoId];
      await tx.upsertDao({ ...config, fromBlock: source.fromBlock, updatedAt: new Date().toISOString() });
      await tx.upsertSource({ daoId, id: source.id, kind: source.config.source.kind, endpoint: source.rpcUrl || source.config.source.endpoint, publicEndpoint: source.publicEndpoint, fromBlock: source.fromBlock });
    });
    const checkpoint = await this.store.getCheckpoint(daoId, source.id);
    const start = options.fromBlock == null ? (checkpoint ? Math.max(source.fromBlock, Number(checkpoint.nextBlock) - source.replayBlocks - 1) : source.fromBlock) : Math.max(source.fromBlock, Number(options.fromBlock));
    const finalHead = options.toBlock == null ? await source.head() : Number(options.toBlock);
    let batches = 0; let records = 0;
    const enumeratesProposals = typeof source.fetchProposals === "function";
    // A full enumeration is the only pass that may conclude a proposal has
    // disappeared, so it is also the only pass allowed to reconcile deletions.
    const full = this._shouldFullScan(checkpoint, options);
    const proposalContext = { full, ...(await this._proposalContext(daoId, full)) };
    let fetchedProposals = [];
    try {
      fetchedProposals = enumeratesProposals ? await source.fetchProposals(start, finalHead, finalHead, proposalContext) : [];
    } catch (error) {
      const safeError = redactErrorMessage(error);
      this.logger.error({ event: "proposal_sync_failed", dao: daoId, source: source.id, error: safeError });
      try { await this.store.transaction(async (tx) => tx.setCheckpoint({ daoId, sourceId: source.id, nextBlock: checkpoint?.nextBlock || start, finalizedHead: checkpoint?.finalizedHead || finalHead, updatedAt: new Date().toISOString(), lastError: safeError })); } catch (checkpointError) { this.logger.error({ event: "checkpoint_error_failed", dao: daoId, error: redactErrorMessage(checkpointError) }); }
      throw error;
    }
    const proposalRecords = fetchedProposals.filter((row) => row?.raw);
    const materializedProposals = fetchedProposals.filter((row) => !row?.raw);
    for (let from = start; from <= finalHead; from += this.batchSize) {
      const to = Math.min(finalHead, from + this.batchSize - 1);
      try {
        let logs; let attempt = 0;
        while (true) { try { logs = await source.fetchRange(from, to, finalHead); break; } catch (error) { if (++attempt >= this.retries) throw error; this.logger.warn({ event: "sync_retry", dao: daoId, source: source.id, fromBlock: from, toBlock: to, attempt, error: redactErrorMessage(error) }); await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1))); } }
        const normalized = [];
        for (let index = 0; index < logs.length; index += this.concurrency) normalized.push(...await Promise.all(logs.slice(index, index + this.concurrency).map((entry) => source.normalizeLog(entry, finalHead))));
        const canonicalRecords = normalized;
        await this.store.transaction(async (tx) => {
          if (tx.reconcileRange) await tx.reconcileRange({ daoId, sourceId: source.id, fromBlock: from, toBlock: to, records: canonicalRecords });
          for (const row of canonicalRecords) if (await tx.ingest(row)) records += 1;
          await tx.setCheckpoint({ daoId, sourceId: source.id, nextBlock: to + 1, finalizedHead: finalHead, updatedAt: new Date().toISOString(), lastError: null });
        });
        batches += 1; this.logger.info({ event: "sync_batch", dao: daoId, source: source.id, fromBlock: from, toBlock: to, head: finalHead, fetched: logs.length, ingested: records, durationMs: 0 });
      } catch (error) {
        const safeError = redactErrorMessage(error);
        this.logger.error({ event: "sync_failed", dao: daoId, fromBlock: from, toBlock: to, error: safeError });
        try { await this.store.transaction(async (tx) => tx.setCheckpoint({ daoId, sourceId: source.id, nextBlock: checkpoint?.nextBlock || from, finalizedHead: checkpoint?.finalizedHead || finalHead, updatedAt: new Date().toISOString(), lastError: safeError })); } catch (checkpointError) { this.logger.error({ event: "checkpoint_error_failed", dao: daoId, error: redactErrorMessage(checkpointError) }); }
        throw error;
      }
    }
    // Replay canonical event placement first. Proposal enumeration is then the
    // authoritative finalized-head refresh for mutable state and tallies.
    if (enumeratesProposals) await this.store.transaction(async (tx) => {
      for (const proposal of materializedProposals) await tx.upsertProposal(proposal.proposal || proposal);
      // Only a full enumeration is authoritative about which proposals exist.
      if (full && tx.reconcileProposals) await tx.reconcileProposals({ daoId, sourceId: source.id, records: proposalRecords });
      for (const row of proposalRecords) if (await tx.ingest(row)) records += 1;
      if (full) await tx.setCheckpoint({ daoId, sourceId: source.id, nextBlock: Math.max(finalHead + 1, Number(checkpoint?.nextBlock || 0)), finalizedHead: finalHead, updatedAt: new Date().toISOString(), lastFullScanAt: new Date().toISOString(), lastError: null });
    });
    return { ok: true, dao: daoId, fromBlock: start, toBlock: finalHead, batches, records, fullProposalScan: full };
  }
  async syncAll(options = {}) { const results = []; for (const daoId of Object.keys(this.sources)) results.push(await this.syncDao(daoId, options)); return results; }
}
module.exports = { GovernanceSyncWorker };
