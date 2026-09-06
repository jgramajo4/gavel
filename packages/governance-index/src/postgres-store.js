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
const { redactErrorMessage } = require("./redaction");

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
      INSERT INTO sync_checkpoints(dao_id,source_id,next_block,finalized_head,updated_at,last_error)
      VALUES($1,$2,$3,$4,now(),$5)
      ON CONFLICT(dao_id,source_id) DO UPDATE SET
        next_block=GREATEST(sync_checkpoints.next_block,excluded.next_block),
        finalized_head=GREATEST(sync_checkpoints.finalized_head,excluded.finalized_head),
        updated_at=now(),last_error=excluded.last_error
    `, [row.daoId, row.sourceId, row.nextBlock, row.finalizedHead, lastError]);
  }

  async upsertProposal(row) {
    const normalized = row.normalized;
    await this.client.query(`
      INSERT INTO proposals(
        dao_id,proposal_id,content_hash,title,description,proposer,proposal_status,outcome,
        created_block,start_block,end_block,quorum_votes,for_votes,against_votes,abstain_votes,
        normalized,first_seen_block
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$9)
      ON CONFLICT(dao_id,proposal_id) DO UPDATE SET
        content_hash=excluded.content_hash,title=excluded.title,description=excluded.description,
        proposer=excluded.proposer,proposal_status=excluded.proposal_status,outcome=excluded.outcome,
        created_block=excluded.created_block,start_block=excluded.start_block,end_block=excluded.end_block,
        quorum_votes=excluded.quorum_votes,for_votes=excluded.for_votes,
        against_votes=excluded.against_votes,abstain_votes=excluded.abstain_votes,
        normalized=excluded.normalized,
        first_seen_block=LEAST(proposals.first_seen_block,excluded.first_seen_block),updated_at=now()
    `, [
      row.daoId, row.proposalId, row.contentHash, normalized?.title || "",
      normalized?.description || "", normalized?.proposer || null,
      normalized?.state || "UNKNOWN", normalized?.outcome || "UNKNOWN",
      normalized?.createdBlock ?? null, normalized?.startBlock ?? null, normalized?.endBlock ?? null,
      normalized?.quorumVotes ?? null, normalized?.forVotes ?? null,
      normalized?.againstVotes ?? null, normalized?.abstainVotes ?? null, normalized,
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
      ON CONFLICT DO NOTHING
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
    // Refresh mutable normalized proposal state even when the immutable raw
    // source record was already indexed.
    if (record.proposal) await this.upsertProposal(record.proposal);
    if (!result.rowCount) return false;
    if (record.vote) await this.insertVote(record.vote);
    if (record.delegation) await this.insertDelegation(record.delegation);
    return true;
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

  async migrate() {
    const sql = await fs.readFile(path.join(__dirname, "..", "migrations", "001_initial.sql"), "utf8");
    await this.pool.query(sql);
    return { ok: true, version: "001_initial" };
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
        finalized_head::text AS "finalizedHead",updated_at AS "updatedAt",last_error AS "lastError"
      FROM sync_checkpoints WHERE dao_id=$1 AND source_id=$2
    `, [daoId, sourceId]);
    return result.rows[0] || null;
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
        finalized_head::text AS "finalizedHead",updated_at AS "updatedAt",last_error AS "lastError"
      FROM sync_checkpoints ORDER BY dao_id,source_id
    `);
    return { ...counts.rows[0], checkpoints: checkpoints.rows };
  }

  async syncStatus(daoId) {
    return (await this.pool.query(`
      SELECT dao_id AS "daoId",source_id AS "sourceId",next_block::text AS "nextBlock",
        finalized_head::text AS "finalizedHead",updated_at AS "updatedAt",last_error AS "lastError"
      FROM sync_checkpoints WHERE dao_id=$1 ORDER BY source_id
    `, [daoId])).rows;
  }
}

module.exports = { PostgresGovernanceStore, PostgresTransaction };
