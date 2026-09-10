const fs = require("node:fs/promises");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { Pool } = require("pg");
const {
  eventKey,
  decodeCursor,
  encodeCursor,
  decodeProposalCursor,
  encodeProposalCursor,
} = require("./memory-store");
const { sanitizeConfig, sanitizeEndpoint, sanitizeProvenance } = require("./provenance");
const { APPLICATION_ROLES, auditRoles, ensureRoles, presentRoles, verifyPermissions } = require("./roles");

const { TrackingState, trackingStateFor } = require("../../core/src/governance/lifecycle");
const { redactErrorMessage } = require("./redaction");

// A WARM proposal (succeeded, queued) can still change, but not on the cadence a
// live vote does. Re-reading it once a quarter hour is enough and keeps a steady
// cycle proportional to open governance rather than to post-vote backlog.
const DEFAULT_WARM_REFRESH_MS = 15 * 60 * 1000;

function proposalCursor(value) {
  if (!value) return null;
  return typeof value === "string" && /^\d+$/.test(value) ? value : decodeProposalCursor(value);
}

function rawRow(record) {
  const raw = record.raw;
  return sanitizeProvenance({
    ...raw,
    proposalId: raw.proposalId || record.proposal?.proposalId || record.vote?.proposalId || null,
    contentHash: raw.contentHash || record.proposal?.contentHash || null,
  });
}

function canonicalMaterial(row) {
  return {
    blockNumber: String(row.blockNumber),
    blockHash: row.blockHash || null,
    recordType: row.recordType,
    proposalId: row.proposalId == null ? null : String(row.proposalId),
    contentHash: row.contentHash || null,
    payload: row.payload,
  };
}

function immutableEventMaterial(row) {
  const material = canonicalMaterial(row);
  delete material.blockNumber;
  delete material.blockHash;
  return material;
}

function endpointOrigin(value) {
  try { return new URL(value).origin; } catch { return "https://source.invalid"; }
}

class PostgresTransaction {
  constructor(client) { this.client = client; }

  async upsertDao(row) {
    const safeRow = sanitizeConfig(row);
    await this.client.query(`
      INSERT INTO daos(id,name,chain_id,governance_type,current_governor,contract_address,from_block,config,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,chain_id=excluded.chain_id,governance_type=excluded.governance_type,
        current_governor=excluded.current_governor,contract_address=excluded.contract_address,
        from_block=excluded.from_block,config=excluded.config,updated_at=now()
    `, [
      safeRow.id, safeRow.name || safeRow.id, safeRow.chainId, safeRow.governanceType || "onchain",
      safeRow.currentGovernor || safeRow.contractAddress || null, safeRow.contractAddress || null,
      safeRow.fromBlock ?? 1, safeRow,
    ]);
  }

  async upsertSource(row) {
    const safeRow = sanitizeProvenance(row);
    await this.client.query(`
      INSERT INTO governance_sources(dao_id,id,kind,endpoint,from_block,config)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(dao_id,id) DO UPDATE SET
        kind=excluded.kind,endpoint=excluded.endpoint,from_block=excluded.from_block,config=excluded.config
    `, [safeRow.daoId, safeRow.id, safeRow.kind, safeRow.endpoint, safeRow.fromBlock, safeRow]);
  }

  async setCheckpoint(row) {
    const lastError = row.lastError == null ? null : redactErrorMessage(row.lastError);
    await this.client.query(`
      INSERT INTO sync_checkpoints(dao_id,source_id,next_block,finalized_head,updated_at,last_full_scan_at,last_error)
      VALUES($1,$2,$3,$4,now(),$5,$6)
      ON CONFLICT(dao_id,source_id) DO UPDATE SET
        next_block=GREATEST(sync_checkpoints.next_block,excluded.next_block),
        finalized_head=GREATEST(sync_checkpoints.finalized_head,excluded.finalized_head),
        updated_at=now(),
        last_full_scan_at=COALESCE(excluded.last_full_scan_at,sync_checkpoints.last_full_scan_at),
        last_error=excluded.last_error
    `, [row.daoId, row.sourceId, row.nextBlock, row.finalizedHead, row.lastFullScanAt || null, lastError]);
  }

  async upsertProposal(row) {
    const normalized = row.normalized;
    // `proposal_status` stays the raw upstream value. `effective_status` is what
    // Gavel derived, and `tracking_state` is what the refresh planner reads --
    // never the raw value, which upstream may leave stale forever.
    const effectiveStatus = normalized?.effectiveStatus || normalized?.outcome || "UNKNOWN";
    const trackingState = normalized?.trackingState || trackingStateFor(effectiveStatus);
    await this.client.query(`
      INSERT INTO proposals(
        dao_id,proposal_id,content_hash,title,description,proposer,proposal_status,outcome,
        created_block,start_block,end_block,quorum_votes,for_votes,against_votes,abstain_votes,
        normalized,first_seen_block,effective_status,tracking_state,lifecycle_reason,last_observed_block
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$9,$17,$18,$19,$20)
      ON CONFLICT(dao_id,proposal_id) DO UPDATE SET
        content_hash=excluded.content_hash,title=excluded.title,description=excluded.description,
        proposer=excluded.proposer,proposal_status=excluded.proposal_status,outcome=excluded.outcome,
        created_block=excluded.created_block,start_block=excluded.start_block,end_block=excluded.end_block,
        quorum_votes=excluded.quorum_votes,for_votes=excluded.for_votes,
        against_votes=excluded.against_votes,abstain_votes=excluded.abstain_votes,
        normalized=excluded.normalized,
        effective_status=excluded.effective_status,tracking_state=excluded.tracking_state,
        lifecycle_reason=excluded.lifecycle_reason,
        last_observed_block=GREATEST(COALESCE(proposals.last_observed_block,0),COALESCE(excluded.last_observed_block,0)),
        first_seen_block=LEAST(proposals.first_seen_block,excluded.first_seen_block),updated_at=now()
    `, [
      row.daoId, row.proposalId, row.contentHash, normalized?.title || "",
      normalized?.description || "", normalized?.proposer || null,
      normalized?.state || "UNKNOWN", normalized?.outcome || "UNKNOWN",
      normalized?.createdBlock ?? null, normalized?.startBlock ?? null, normalized?.endBlock ?? null,
      normalized?.quorumVotes ?? null, normalized?.forVotes ?? null,
      normalized?.againstVotes ?? null, normalized?.abstainVotes ?? null, normalized,
      effectiveStatus, trackingState, normalized?.lifecycleReason || null, row.lastObservedBlock ?? null,
    ]);
    if (row.actions !== undefined) {
      await this.client.query("DELETE FROM proposal_actions WHERE dao_id=$1 AND proposal_id=$2", [row.daoId, row.proposalId]);
      for (const action of row.actions) {
        await this.client.query(`
          INSERT INTO proposal_actions(dao_id,proposal_id,action_index,target,value_wei,signature,calldata)
          VALUES($1,$2,$3,$4,$5,$6,$7)
        `, [row.daoId, row.proposalId, action.index, action.target, action.valueWei, action.signature, action.calldata]);
      }
    }
  }

  async insertVote(row) {
    const safeRow = sanitizeProvenance(row);
    const result = await this.client.query(`
      INSERT INTO vote_events(
        dao_id,source_id,source_record_key,chain_id,contract_address,proposal_id,voter,support,reason,vote_weight,
        block_number,block_time,transaction_hash,log_index,source_kind,source_endpoint,source_public_endpoint,observed_head,normalized
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT(chain_id,contract_address,transaction_hash,log_index) DO UPDATE SET
        normalized=COALESCE(excluded.normalized,vote_events.normalized),
        observed_head=GREATEST(vote_events.observed_head,excluded.observed_head)
    `, [
      safeRow.daoId, safeRow.sourceId || null, safeRow.sourceRecordKey || null, safeRow.chainId, safeRow.contractAddress,
      safeRow.proposalId, safeRow.voter, safeRow.support, safeRow.reason, safeRow.voteWeight, safeRow.blockNumber, safeRow.timestamp,
      safeRow.transactionHash, safeRow.logIndex, safeRow.sourceKind, safeRow.sourceEndpoint,
      safeRow.sourceEndpoint, safeRow.observedHead, safeRow.normalized || null,
    ]);
    return result.rowCount > 0;
  }

  async insertDelegation(row) {
    const safeRow = sanitizeProvenance(row);
    const result = await this.client.query(`
      INSERT INTO delegation_events(
        dao_id,chain_id,contract_address,delegator,delegatee,block_number,block_time,
        transaction_hash,log_index,source_kind,source_endpoint,normalized
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT(chain_id,contract_address,transaction_hash,log_index) DO NOTHING
    `, [
      safeRow.daoId, safeRow.chainId, safeRow.contractAddress, safeRow.delegator, safeRow.delegatee,
      safeRow.blockNumber, safeRow.timestamp, safeRow.transactionHash, safeRow.logIndex,
      safeRow.sourceKind, safeRow.sourceEndpoint, safeRow.normalized || null,
    ]);
    return result.rowCount > 0;
  }

  async ingest(record) {
    const raw = rawRow(record);
    const result = await this.client.query(`
      INSERT INTO raw_governance_records(
        dao_id,source_id,source_record_key,external_id,chain_id,contract_address,transaction_hash,log_index,
        block_number,block_hash,record_type,proposal_id,content_hash,payload,source_kind,
        source_endpoint,observed_head
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT DO NOTHING
    `, [
      raw.daoId, raw.sourceId, raw.sourceRecordKey || null, raw.externalId || null, raw.chainId, raw.contractAddress,
      raw.transactionHash, raw.logIndex, raw.blockNumber, raw.blockHash, raw.recordType,
      raw.proposalId, raw.contentHash, raw.payload, raw.sourceKind, raw.sourceEndpoint, raw.observedHead,
    ]);
    // Normalized rows are reconciled even when the immutable raw source record
    // was already indexed, so a vote dropped by an earlier partial write is
    // repaired by re-running the sync instead of being lost permanently.
    if (record.proposal) await this.upsertProposal(record.proposal);
    if (record.vote) await this.insertVote(record.vote);
    if (record.delegation) await this.insertDelegation(record.delegation);
    return result.rowCount > 0;
  }

  async reconcileRange({ daoId, sourceId, fromBlock, toBlock, records }) {
    const incoming = new Map(records.map((record) => {
      const row = rawRow(record);
      return [eventKey(row), row];
    }));
    const selected = await this.client.query(`
      SELECT dao_id AS "daoId",source_id AS "sourceId",source_record_key AS "sourceRecordKey",
        chain_id AS "chainId",contract_address AS "contractAddress",
        transaction_hash AS "transactionHash",log_index AS "logIndex",
        block_number AS "blockNumber",block_hash AS "blockHash",record_type AS "recordType",
        proposal_id::text AS "proposalId",content_hash AS "contentHash",payload
      FROM raw_governance_records
      WHERE dao_id=$1 AND source_id=$2 AND block_number BETWEEN $3 AND $4
        AND NOT (record_type='proposal' AND source_record_key IS NOT NULL)
    `, [daoId, sourceId, fromBlock, toBlock]);
    const existingByKey = new Map(selected.rows.map((row) => [eventKey(row), row]));

    const chainRows = [...incoming.values()].filter((row) => !row.sourceRecordKey);
    if (chainRows.length) {
      const values = [];
      const tuples = [];
      for (const row of chainRows) {
        const offset = values.length + 1;
        values.push(row.chainId, String(row.contractAddress).toLowerCase(), String(row.transactionHash).toLowerCase(), row.logIndex);
        tuples.push(`($${offset},$${offset + 1},$${offset + 2},$${offset + 3})`);
      }
      const identities = await this.client.query(`
        SELECT dao_id AS "daoId",source_id AS "sourceId",source_record_key AS "sourceRecordKey",
          chain_id AS "chainId",contract_address AS "contractAddress",
          transaction_hash AS "transactionHash",log_index AS "logIndex",
          block_number AS "blockNumber",block_hash AS "blockHash",record_type AS "recordType",
          proposal_id::text AS "proposalId",content_hash AS "contentHash",payload
        FROM raw_governance_records
        WHERE (chain_id,lower(contract_address),lower(transaction_hash),log_index) IN (${tuples.join(",")})
      `, values);
      for (const row of identities.rows) existingByKey.set(eventKey(row), row);
    }
    const sourceRows = [...incoming.values()].filter((row) => row.sourceRecordKey);
    if (sourceRows.length) {
      const values = [];
      const tuples = [];
      for (const row of sourceRows) {
        const offset = values.length + 1;
        values.push(row.daoId, row.sourceId, row.sourceRecordKey);
        tuples.push(`($${offset},$${offset + 1},$${offset + 2})`);
      }
      const identities = await this.client.query(`
        SELECT dao_id AS "daoId",source_id AS "sourceId",source_record_key AS "sourceRecordKey",
          chain_id AS "chainId",contract_address AS "contractAddress",
          transaction_hash AS "transactionHash",log_index AS "logIndex",
          block_number AS "blockNumber",block_hash AS "blockHash",record_type AS "recordType",
          proposal_id::text AS "proposalId",content_hash AS "contentHash",payload
        FROM raw_governance_records
        WHERE (dao_id,source_id,source_record_key) IN (${tuples.join(",")})
      `, values);
      for (const row of identities.rows) existingByKey.set(eventKey(row), row);
    }

    for (const [key, next] of incoming) {
      const existing = existingByKey.get(key);
      if (existing && !isDeepStrictEqual(immutableEventMaterial(existing), immutableEventMaterial(next))) {
        throw new Error(`canonical event drift for ${key}`);
      }
    }

    const removals = new Map(selected.rows.filter((row) => !incoming.has(eventKey(row))).map((row) => [eventKey(row), row]));
    for (const [key, next] of incoming) {
      const existing = existingByKey.get(key);
      if (existing && (String(existing.blockNumber) !== String(next.blockNumber) || (existing.blockHash || null) !== (next.blockHash || null))) removals.set(key, existing);
    }
    const removedProposalIds = new Set();
    for (const row of removals.values()) {
      if (row.sourceRecordKey) {
        const identity = [row.daoId, row.sourceId, row.sourceRecordKey];
        await this.client.query("DELETE FROM vote_events WHERE dao_id=$1 AND source_id=$2 AND source_record_key=$3", identity);
        await this.client.query("DELETE FROM raw_governance_records WHERE dao_id=$1 AND source_id=$2 AND source_record_key=$3", identity);
      } else {
        const identity = [row.chainId, row.contractAddress, row.transactionHash, row.logIndex];
        await this.client.query(`
          DELETE FROM vote_events
          WHERE chain_id=$1 AND contract_address=$2 AND transaction_hash=$3 AND log_index=$4
        `, identity);
        await this.client.query(`
          DELETE FROM delegation_events
          WHERE chain_id=$1 AND contract_address=$2 AND transaction_hash=$3 AND log_index=$4
        `, identity);
        await this.client.query(`
          DELETE FROM raw_governance_records
          WHERE chain_id=$1 AND contract_address=$2 AND transaction_hash=$3 AND log_index=$4
        `, identity);
      }
      if (row.recordType === "proposal" && row.proposalId) removedProposalIds.add(String(row.proposalId));
    }
    for (const proposalId of removedProposalIds) {
      await this.client.query(`
        DELETE FROM proposals p
        WHERE p.dao_id=$1 AND p.proposal_id=$2
          AND NOT EXISTS (
            SELECT 1 FROM raw_governance_records r
            WHERE r.dao_id=p.dao_id AND r.record_type='proposal' AND r.proposal_id=p.proposal_id
          )
      `, [daoId, proposalId]);
    }
  }

  async reconcileProposals({ daoId, sourceId, records }) {
    const incoming = new Map(records.map((record) => { const row = rawRow(record); return [eventKey(row), row]; }));
    const selected = await this.client.query(`
      SELECT dao_id AS "daoId",source_id AS "sourceId",source_record_key AS "sourceRecordKey",
        chain_id AS "chainId",contract_address AS "contractAddress",transaction_hash AS "transactionHash",
        log_index AS "logIndex",block_number AS "blockNumber",block_hash AS "blockHash",
        record_type AS "recordType",proposal_id::text AS "proposalId",content_hash AS "contentHash",payload
      FROM raw_governance_records
      WHERE dao_id=$1 AND source_id=$2 AND record_type='proposal' AND source_record_key IS NOT NULL
    `, [daoId, sourceId]);
    for (const row of selected.rows) {
      const next = incoming.get(eventKey(row));
      if (next && !isDeepStrictEqual(canonicalMaterial(row), canonicalMaterial(next))) throw new Error(`canonical event drift for ${eventKey(row)}`);
    }
    for (const row of selected.rows.filter((candidate) => !incoming.has(eventKey(candidate)))) {
      await this.client.query("DELETE FROM raw_governance_records WHERE dao_id=$1 AND source_id=$2 AND source_record_key=$3", [daoId, sourceId, row.sourceRecordKey]);
      await this.client.query(`
        DELETE FROM proposals p WHERE p.dao_id=$1 AND p.proposal_id=$2
          AND NOT EXISTS (SELECT 1 FROM raw_governance_records r WHERE r.dao_id=p.dao_id AND r.record_type='proposal' AND r.proposal_id=p.proposal_id)
      `, [daoId, row.proposalId]);
    }
  }
}

class PostgresGovernanceStore {
  constructor(options = {}) {
    if (options.pool) {
      this.pool = options.pool;
      return;
    }
    const maxConnections = Number(options.maxConnections || 10);
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 2) throw new RangeError("maxConnections must be an integer of at least 2 for advisory source locking");
    const poolOptions = {
      max: maxConnections,
      ssl: options.ssl,
    };
    const connectionString = options.connectionString || process.env.DATABASE_URL;
    if (connectionString) poolOptions.connectionString = connectionString;
    this.pool = new Pool(poolOptions);
  }

  async close() { await this.pool.end(); }

  // Applies the schema, reconciles the application roles, and reports the
  // role/grant state it actually observed. `roles: "granted"` is only ever
  // returned after the grants have been verified against the live database.
  async migrate(options = {}) {
    const dir = path.join(__dirname, "..", "migrations");
    await this.pool.query(await fs.readFile(path.join(dir, "001_initial.sql"), "utf8"));
    await this.pool.query(await fs.readFile(path.join(dir, "003_proposal_lifecycle.sql"), "utf8"));
    const versions = ["001_initial", "003_proposal_lifecycle"];

    // Role creation is idempotent and privilege-aware: on a fresh volume the
    // entrypoint script has already made the roles, on a reused volume this is
    // what creates them without destroying data.
    const ensured = options.ensureRoles === false
      ? { state: "present", created: [], missing: [] }
      : await ensureRoles(this.pool, options);
    const roles = await presentRoles(this.pool);
    const missingRoles = APPLICATION_ROLES.filter((role) => !roles.includes(role));

    if (missingRoles.length) {
      // Never fail silently: an ungranted API role is a deployment fault, not a
      // detail. `verify-permissions` is the gate that must pass before serving.
      return {
        ok: true,
        version: versions.at(-1),
        versions,
        roles: "skipped",
        rolesCreated: ensured.created,
        missingRoles,
        reason: ensured.reason || "the roles do not exist",
        warning: `Role grants were skipped because ${missingRoles.join(" and ")} do not exist. Create them (\`gavel-indexer ensure-roles\`, or docker/init-db.sh on a fresh volume) and re-run migrate, then run \`gavel-indexer verify-permissions --role gavel_api\`.`,
      };
    }

    await this.pool.query(await fs.readFile(path.join(dir, "002_roles.sql"), "utf8"));
    versions.push("002_roles");

    // The grants ran without error, which is not the same as the roles now
    // being correct. Prove it by exercising them.
    const audit = await auditRoles(this.pool);
    if (!audit.ok) {
      return {
        ok: false,
        version: versions.at(-1),
        versions,
        roles: "invalid",
        rolesCreated: ensured.created,
        verified: audit.summary,
        violations: audit.violations,
        warning: "Role grants were applied but the resulting privileges are wrong. Do not serve traffic until `gavel-indexer verify-permissions --role gavel_api` passes.",
      };
    }
    const unproven = Object.entries(audit.summary).filter(([, row]) => row.method !== "effective").map(([role]) => role);
    return {
      ok: true,
      version: versions.at(-1),
      versions,
      roles: "granted",
      rolesCreated: ensured.created,
      verified: audit.summary,
      ...(unproven.length ? {
        warning: `Grants for ${unproven.join(" and ")} were confirmed from the privilege catalog only, because this connection may not SET ROLE. Run \`gavel-indexer verify-permissions --role gavel_api\` from a connection that can, before serving traffic.`,
      } : {}),
    };
  }

  // Creates any missing application role without touching indexed data, so a
  // redeploy onto an existing PostgreSQL volume does not require wiping it.
  async ensureRoles(options = {}) {
    return ensureRoles(this.pool, options);
  }

  // Which application roles the database currently has.
  async rolesStatus() {
    const present = await presentRoles(this.pool);
    return { present, missing: APPLICATION_ROLES.filter((role) => !present.includes(role)) };
  }

  // Proves what the role can and cannot do by acting as it, rather than by
  // trusting the role's name or reading its GRANT statements back.
  async verifyPermissions(role = "gavel_api", options = {}) {
    return verifyPermissions(this.pool, role, options);
  }

  async transaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(new PostgresTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async withSourceLock(daoId, sourceId, callback) {
    const client = await this.pool.connect();
    const key = `${daoId}:${sourceId}`;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]);
      return await callback();
    } finally {
      try { await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]); }
      finally { client.release(); }
    }
  }

  async getCheckpoint(daoId, sourceId) {
    const result = await this.pool.query(`
      SELECT dao_id AS "daoId",source_id AS "sourceId",next_block::text AS "nextBlock",
        finalized_head::text AS "finalizedHead",updated_at AS "updatedAt",
        last_full_scan_at AS "lastFullScanAt",last_error AS "lastError"
      FROM sync_checkpoints WHERE dao_id=$1 AND source_id=$2
    `, [daoId, sourceId]);
    return result.rows[0] || null;
  }

  // Feeds incremental proposal enumeration: the highest indexed proposal id and
  // the proposals whose state can still change.
  async getProposalSyncContext(daoId, options = {}) {
    const max = (await this.pool.query(
      "SELECT max(proposal_id)::text AS \"maxProposalId\" FROM proposals WHERE dao_id=$1", [daoId],
    )).rows[0]?.maxProposalId ?? null;
    const warmAfterMs = Number(options.warmRefreshIntervalMs ?? DEFAULT_WARM_REFRESH_MS);
    // Everything still worth observing: every HOT proposal, plus WARM ones that
    // have gone unrefreshed long enough. FINAL rows are not selected at all, so
    // steady-state cost tracks open governance instead of DAO history.
    const refreshProposals = (await this.pool.query(`
      SELECT proposal_id::text AS "proposalId",content_hash AS "contentHash",normalized,
        tracking_state AS "trackingState",effective_status AS "effectiveStatus",
        last_observed_block::text AS "lastObservedBlock",updated_at AS "updatedAt"
      FROM proposals
      WHERE dao_id=$1 AND tracking_state <> $2
        AND (tracking_state = $3 OR updated_at <= now() - make_interval(secs => $4))
      ORDER BY proposal_id
    `, [daoId, TrackingState.FINAL, TrackingState.HOT, Math.max(0, warmAfterMs) / 1000])).rows;
    return { maxProposalId: max, refreshProposals };
  }

  // Lifecycle census for `gavel-indexer status`: how much of the index is still
  // being observed, and how much has been proven done.
  async trackingCounts() {
    return (await this.pool.query(`
      SELECT dao_id AS "daoId",tracking_state AS "trackingState",count(*)::int AS count
      FROM proposals GROUP BY dao_id,tracking_state ORDER BY dao_id,tracking_state
    `)).rows;
  }

  async listDaos() {
    return (await this.pool.query(`
      SELECT id,name,chain_id::text AS "chainId",governance_type AS "governanceType",
        current_governor AS "currentGovernor",contract_address AS "contractAddress",
        from_block::text AS "fromBlock",updated_at AS "updatedAt"
      FROM daos ORDER BY id
    `)).rows;
  }

  async getDao(id) {
    return (await this.pool.query(`
      SELECT id,name,chain_id::text AS "chainId",governance_type AS "governanceType",
        current_governor AS "currentGovernor",contract_address AS "contractAddress",
        from_block::text AS "fromBlock",updated_at AS "updatedAt"
      FROM daos WHERE id=$1
    `, [id])).rows[0] || null;
  }

  async getProposal(daoId, id) {
    return (await this.pool.query(
      "SELECT normalized FROM proposals WHERE dao_id=$1 AND proposal_id=$2",
      [daoId, id],
    )).rows[0]?.normalized || null;
  }

  async listProposals({ daoId, limit, cursor }) {
    const decoded = proposalCursor(cursor);
    const params = [daoId, limit + 1];
    let where = "dao_id=$1";
    if (decoded) {
      params.push(decoded);
      where += " AND proposal_id < $3";
    }
    const rows = (await this.pool.query(`
      SELECT proposal_id::text AS "proposalId",normalized
      FROM proposals WHERE ${where} ORDER BY proposal_id DESC LIMIT $2
    `, params)).rows;
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => row.normalized);
    return { items, nextCursor: more ? encodeProposalCursor(rows[limit - 1].proposalId) : null };
  }

  async listVotes({ daoId, voter, limit, cursor }) {
    const decoded = typeof cursor === "string" ? decodeCursor(cursor) : cursor;
    const params = [daoId, limit + 1];
    let where = "dao_id=$1";
    if (voter) {
      params.push(voter.toLowerCase());
      where += ` AND lower(voter)=$${params.length}`;
    }
    if (decoded) {
      const offset = params.length + 1;
      params.push(decoded.blockNumber, String(decoded.transactionHash).toLowerCase(), decoded.logIndex);
      where += ` AND (block_number,lower(transaction_hash),log_index)>($${offset},$${offset + 1},$${offset + 2})`;
    }
    const rows = (await this.pool.query(`
      SELECT normalized,dao_id AS "daoId",chain_id::text AS "chainId",
        proposal_id::text AS "proposalId",voter,support,reason,vote_weight::text AS "voteWeight",
        block_number::text AS "blockNumber",block_time AS timestamp,
        transaction_hash AS "transactionHash",log_index AS "logIndex",source_kind AS "sourceKind",
        source_endpoint AS "sourceEndpoint",source_public_endpoint AS "sourcePublicEndpoint",
        observed_head::text AS "observedHead"
      FROM vote_events WHERE ${where}
      ORDER BY block_number,lower(transaction_hash),log_index LIMIT $2
    `, params)).rows;
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    return { items, nextCursor: more ? encodeCursor(items.at(-1)) : null };
  }

  async status() {
    const counts = await this.pool.query(`
      SELECT (SELECT count(*)::int FROM daos) daos,
        (SELECT count(*)::int FROM proposals) proposals,
        (SELECT count(*)::int FROM vote_events) votes,
        (SELECT count(*)::int FROM delegation_events) delegations
    `);
    const checkpoints = await this.pool.query(`
      SELECT dao_id AS "daoId",source_id AS "sourceId",next_block::text AS "nextBlock",
        finalized_head::text AS "finalizedHead",updated_at AS "updatedAt",
        last_full_scan_at AS "lastFullScanAt",last_error AS "lastError"
      FROM sync_checkpoints ORDER BY dao_id,source_id
    `);
    return { ...counts.rows[0], tracking: await this.trackingCounts(), checkpoints: checkpoints.rows };
  }

  async syncStatus(daoId) {
    return (await this.pool.query(`
      SELECT dao_id AS "daoId",source_id AS "sourceId",next_block::text AS "nextBlock",
        finalized_head::text AS "finalizedHead",updated_at AS "updatedAt",
        last_full_scan_at AS "lastFullScanAt",last_error AS "lastError"
      FROM sync_checkpoints WHERE dao_id=$1 ORDER BY source_id
    `, [daoId])).rows;
  }
}

module.exports = { PostgresGovernanceStore, PostgresTransaction };
