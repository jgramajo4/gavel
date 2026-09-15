const crypto = require("node:crypto");
const { Pool } = require("pg");
const { keccak256 } = require("ethers");
const { NOUNS_LIFECYCLE_MAPPING_VERSION } = require("@gavel/gate");
const {
  DEFAULT_NOTIFICATION_RETRY_LIMIT,
  normalizeCapacityPolicy,
  publicState,
  publicSubmissionProjection,
} = require("./semantic-contract");

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DAO = /^[a-z][a-z0-9-]{0,62}$/;
const UINT78 = /^\d{1,78}$/;
const LIFECYCLES = new Set(["PRE_VOTE", "VOTING", "CLOSED", "UNKNOWN"]);
const CURRENT_LIFECYCLES = new Set(["VOTING", "CLOSED", "UNKNOWN"]);
const PUBLIC_ID_ATTEMPTS = 5;
const PROFILE_PAGE_LIMIT = 50;
const PROFILE_MAX_OFFSET = 10_000;
const SETTLEMENT_EVENT_FIELDS = Object.freeze([
  "attentionAmount", "gavelFeeAmount", "gavelRecipient", "payer", "quoteId", "submissionHash", "token", "voter",
]);

function address(value, name) {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new TypeError(`${name} must be 0x plus exactly 40 hexadecimal characters`);
  return value.toLowerCase();
}
function bytes32(value, name) {
  if (typeof value !== "string" || !BYTES32.test(value)) throw new TypeError(`${name} must be a bytes32 (0x plus exactly 64 hexadecimal characters)`);
  return value.toLowerCase();
}
function daoSlug(value) {
  if (typeof value !== "string" || !DAO.test(value)) throw new TypeError("dao must be a canonical lowercase slug");
  return value;
}
function uint78(value, name, minimum = 0n) {
  const normalized = String(value);
  if (!UINT78.test(normalized) || BigInt(normalized) < minimum) throw new TypeError(`${name} must be numeric(78,0) and at least ${minimum}`);
  return normalized;
}
function positiveBigint(value, name) { return uint78(value, name, 1n); }
function positiveInteger(value, name, defaultValue) {
  const candidate = value ?? defaultValue;
  if (!Number.isSafeInteger(candidate) || candidate < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return candidate;
}
function nonnegativeInteger(value, name, defaultValue) {
  const candidate = value ?? defaultValue;
  if (!Number.isSafeInteger(candidate) || candidate < 0) throw new TypeError(`${name} must be a nonnegative safe integer`);
  return candidate;
}
function exactDate(value, name) {
  const date = value instanceof Date ? value : new Date(value);
  if (!value || Number.isNaN(date.valueOf())) throw new TypeError(`${name} must be a valid timestamp`);
  return date;
}
function lifecycle(value, name) {
  if (!LIFECYCLES.has(value)) throw new TypeError(`${name} must be a supported lifecycle`);
  return value;
}
function clone(value) { return value == null ? value : structuredClone(value); }
function publicIdFrom(value) {
  if (!Buffer.isBuffer(value) || value.length !== 16) throw new TypeError("randomBytes must return exactly 16 bytes");
  return value.toString("base64url");
}
function sameTimestamp(a, b) { return new Date(a).valueOf() === new Date(b).valueOf(); }
function invariant(condition, message) { if (!condition) throw new Error(message); }
function resume(row) { return { resumed: true, publicId: row.publicId, state: publicState(row.status) }; }
function publicDisplay(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("display must be an object");
  const fields = Object.keys(value);
  if (fields.some((field) => !["ens", "message"].includes(field))) throw new TypeError("display contains a non-public field");
  for (const field of fields) {
    if (typeof value[field] !== "string" && value[field] !== null) throw new TypeError(`display.${field} must be a string or null`);
  }
  return value;
}
const AUTH_NONCE_COLUMNS = `proof_type::text AS "proofType",signed_purpose::text AS purpose,role::text,wallet,audience,
  chain_id::text AS "chainId",verifier,nonce_hash AS "nonceHash",payload_hash AS "payloadHash",
  extract(epoch from issued_at)::bigint::text AS "issuedAt",extract(epoch from expires_at)::bigint::text AS expiry,
  CASE WHEN consumed_at IS NULL THEN NULL ELSE extract(epoch from consumed_at)::bigint::text END AS "consumedAt"`;
const AUTH_SESSION_COLUMNS = `token_hash AS "tokenHash",wallet,role::text,chain_id::text AS "chainId",audience,
  extract(epoch from issued_at)::bigint::text AS "issuedAt",extract(epoch from expires_at)::bigint::text AS expiry,
  CASE WHEN revoked_at IS NULL THEN NULL ELSE extract(epoch from revoked_at)::bigint::text END AS "revokedAt"`;

class PostgresGateStore {
  constructor(options = {}) {
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.baseCodeReader = options.baseCodeReader;
    this.quoteSigner = options.quoteSigner;
    this.rpcTimeoutMs = positiveInteger(options.rpcTimeoutMs, "rpcTimeoutMs", 5_000);
    this.notificationRetryLimit = nonnegativeInteger(options.notificationRetryLimit, "notificationRetryLimit", DEFAULT_NOTIFICATION_RETRY_LIMIT);
    if (options.pool) this.pool = options.pool;
    else {
      const poolOptions = {};
      const connectionString = options.connectionString || process.env.GAVEL_GATE_DATABASE_URL;
      if (connectionString) poolOptions.connectionString = connectionString;
      if (options.ssl !== undefined) poolOptions.ssl = options.ssl;
      if (options.maxConnections !== undefined) poolOptions.max = options.maxConnections;
      this.pool = new Pool(poolOptions);
    }
  }

  async close() { await this.pool.end(); }

  async #transaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async #profileLock(client, profileId) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`gate:profile:${profileId}`]);
  }

  #authTransaction(client) {
    return Object.freeze({
      getNonceByHash: (nonceHash) => this.#getNonceByHash(client, nonceHash, true),
      consumeNonce: async (nonceHash, consumedAt) => {
        await client.query("SELECT gate.consume_auth_nonce($1,$2)", [bytes32(nonceHash, "nonceHash"), uint78(consumedAt, "consumedAt")]);
      },
      insertSession: async (row) => {
        await client.query("SELECT gate.insert_auth_session($1,$2,$3,$4,$5,$6,$7)", [
          bytes32(row?.tokenHash, "tokenHash"), address(row?.wallet, "session wallet"), row?.role,
          positiveBigint(row?.chainId, "session chainId"), row?.audience,
          uint78(row?.issuedAt, "session issuedAt"), uint78(row?.expiry, "session expiry"),
        ]);
      },
    });
  }

  async #getNonceByHash(queryable, nonceHash, lock = false) {
    const row = (await queryable.query(`SELECT ${AUTH_NONCE_COLUMNS} FROM gate.auth_nonces
      WHERE nonce_hash=$1${lock ? " FOR UPDATE" : ""}`, [bytes32(nonceHash, "nonceHash")])).rows[0];
    return row ? clone(row) : null;
  }

  async insertNonce(row) {
    await this.pool.query("SELECT gate.insert_auth_nonce($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [
      row?.proofType, row?.purpose, row?.role ?? null, address(row?.wallet, "nonce wallet"), row?.audience ?? null,
      positiveBigint(row?.chainId, "nonce chainId"), address(row?.verifier, "nonce verifier"),
      bytes32(row?.nonceHash, "nonceHash"), bytes32(row?.payloadHash, "payloadHash"),
      uint78(row?.issuedAt, "nonce issuedAt"), uint78(row?.expiry, "nonce expiry"),
    ]);
  }

  async getNonceByHash(nonceHash) { return this.#getNonceByHash(this.pool, nonceHash); }

  async getSessionByTokenHash(tokenHash) {
    const row = (await this.pool.query(`SELECT ${AUTH_SESSION_COLUMNS} FROM gate.auth_sessions WHERE token_hash=$1`,
      [bytes32(tokenHash, "tokenHash")])).rows[0];
    return row ? clone(row) : null;
  }

  async transaction(callback) {
    if (typeof callback !== "function") throw new TypeError("transaction callback is required");
    return this.#transaction((client) => callback(this.#authTransaction(client)));
  }

  async allocatePublicId(client = this.pool) {
    for (let attempt = 0; attempt < PUBLIC_ID_ATTEMPTS; attempt += 1) {
      const candidate = publicIdFrom(this.randomBytes(16));
      const exists = await client.query("SELECT 1 FROM gate.submissions WHERE public_id=$1", [candidate]);
      if (!exists.rows.length) return candidate;
    }
    throw new Error("public id allocation unavailable");
  }

  async #mutateProfile({ profile, policy }, transactionClient = null) {
    invariant(profile?.id && profile.wallet, "profile id and wallet are required");
    const wallet = address(profile.wallet, "wallet");
    const walletKind = profile.walletKind ?? null;
    if (walletKind !== null && !new Set(["eoa", "contract"]).has(walletKind)) throw new TypeError("invalid wallet kind");
    if (profile.walletKindAuthoritative !== undefined && typeof profile.walletKindAuthoritative !== "boolean") {
      throw new TypeError("walletKindAuthoritative must be boolean");
    }
    if (profile.availability !== undefined && !["accepting_now", "paused", "closed"].includes(profile.availability)) throw new TypeError("invalid availability");
    const codeHash = profile.basePayoutCodeHash == null ? null : bytes32(profile.basePayoutCodeHash, "basePayoutCodeHash");
    if (profile.display !== undefined) publicDisplay(profile.display);
    let normalizedPolicy = null;
    if (policy) {
      if (typeof policy.enabled !== "boolean") throw new TypeError("policy enabled must be boolean");
      if (typeof policy.acceptPreVote !== "boolean" || typeof policy.acceptVoting !== "boolean") {
        throw new TypeError("policy lifecycle flags must be boolean");
      }
      const capacity = normalizeCapacityPolicy(policy);
      normalizedPolicy = {
        dao: daoSlug(policy.dao), chainId: positiveBigint(policy.chainId, "chainId"), enabled: policy.enabled,
        acceptPreVote: policy.acceptPreVote, acceptVoting: policy.acceptVoting,
        attentionAmount: uint78(policy.attentionAmount, "attentionAmount", 1000000n),
        ...capacity,
        tags: policy.tags || [],
      };
      if (!Array.isArray(normalizedPolicy.tags)) throw new TypeError("tags must be an array");
      invariant(normalizedPolicy.dao !== "nouns" || (normalizedPolicy.chainId === "1"
        && normalizedPolicy.acceptPreVote === false && normalizedPolicy.acceptVoting === true),
      "Nouns policy must use Ethereum chain 1 with PRE_VOTE disabled and VOTING enabled");
    }
    const execute = async (client) => {
      if (!transactionClient) await this.#profileLock(client, profile.id);
      const row = (await client.query(`SELECT id,wallet,wallet_kind AS "walletKind",availability,
        profile_version AS "profileVersion",enrolled_at AS "enrolledAt",updated_at AS "updatedAt",
        base_payout_verified_at AS "basePayoutVerifiedAt",base_payout_code_hash AS "basePayoutCodeHash",display_cache AS display
        FROM gate.mutate_profile($1,$2,$3,$4::gate.availability,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
      [profile.id, wallet, walletKind, profile.availability ?? null,
        profile.display === undefined ? null : JSON.stringify(profile.display), profile.display !== undefined,
        profile.basePayoutVerifiedAt ?? null, profile.basePayoutVerifiedAt !== undefined, codeHash,
        profile.basePayoutCodeHash !== undefined, normalizedPolicy == null ? null : JSON.stringify(normalizedPolicy),
        profile.walletKindAuthoritative === true])).rows[0];
      return clone(row);
    };
    return transactionClient ? execute(transactionClient) : this.#transaction(execute);
  }

  async mutateProfile(input) { return this.#mutateProfile(input); }

  async withProfileTransaction(wallet, callback) {
    const canonicalWallet = address(wallet, "wallet");
    if (typeof callback !== "function") throw new TypeError("profile transaction callback is required");
    return this.#transaction(async (client) => {
      const existing = await this.#getProfileByWallet(client, canonicalWallet);
      await this.#profileLock(client, existing?.id ?? canonicalWallet);
      const auth = this.#authTransaction(client);
      return callback(Object.freeze({
        getNonceByHash: auth.getNonceByHash,
        consumeNonce: auth.consumeNonce,
        getProfileByWallet: (value) => this.#getProfileByWallet(client, value, true),
        mutateProfile: (input) => {
          invariant(address(input?.profile?.wallet, "profile wallet") === canonicalWallet,
            "profile transaction wallet mismatch");
          return this.#mutateProfile(input, client);
        },
      }));
    });
  }

  async #getProfileByWallet(queryable, wallet, lock = false) {
    const row = (await queryable.query(`SELECT id,wallet,wallet_kind AS "walletKind",availability,
      profile_version AS "profileVersion",enrolled_at AS "enrolledAt",updated_at AS "updatedAt",
      base_payout_verified_at AS "basePayoutVerifiedAt",base_payout_code_hash AS "basePayoutCodeHash",display_cache AS display
      FROM gate.profiles WHERE wallet=$1${lock ? " FOR UPDATE" : ""}`, [address(wallet, "wallet")])).rows[0];
    return row ? clone(row) : null;
  }

  async getProfileByWallet(wallet) { return this.#getProfileByWallet(this.pool, wallet); }

  async listProfiles({ dao, availability, limit = PROFILE_PAGE_LIMIT, offset = 0 } = {}) {
    const normalizedDao = dao === undefined ? null : daoSlug(dao);
    if (availability !== undefined && !["accepting_now", "paused", "closed"].includes(availability)) throw new TypeError("invalid availability");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PROFILE_PAGE_LIMIT) throw new TypeError("profile limit must be an integer from 1 to 50");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > PROFILE_MAX_OFFSET) throw new TypeError("profile offset must be an integer from 0 to 10000");
    const rows = (await this.pool.query(`SELECT DISTINCT p.id,p.wallet,p.wallet_kind AS "walletKind",p.availability,
      p.profile_version AS "profileVersion",p.enrolled_at AS "enrolledAt",p.updated_at AS "updatedAt",
      p.base_payout_verified_at AS "basePayoutVerifiedAt",p.base_payout_code_hash AS "basePayoutCodeHash",p.display_cache AS display
      FROM gate.profiles p LEFT JOIN gate.dao_policies d ON d.profile_id=p.id
      WHERE ($1::text IS NULL OR d.dao=$1) AND ($2::gate.availability IS NULL OR p.availability=$2)
      ORDER BY p.updated_at DESC,p.id ASC LIMIT $3 OFFSET $4`, [normalizedDao, availability ?? null, limit, offset])).rows;
    return clone(rows);
  }

  async getProfile(id) {
    const row = (await this.pool.query(`SELECT id,wallet,wallet_kind AS "walletKind",availability,profile_version AS "profileVersion",
      enrolled_at AS "enrolledAt",updated_at AS "updatedAt",base_payout_verified_at AS "basePayoutVerifiedAt",
      base_payout_code_hash AS "basePayoutCodeHash",display_cache AS display FROM gate.profiles WHERE id=$1`, [id])).rows[0];
    return row ? clone(row) : null;
  }

  async getPolicy(profileId, dao) {
    const row = (await this.pool.query(`SELECT profile_id AS "profileId",dao,chain_id::text AS "chainId",enabled,
      accept_pre_vote AS "acceptPreVote",accept_voting AS "acceptVoting",attention_amount::text AS "attentionAmount",
      pending_reservation_capacity AS "pendingReservationCapacity",settled_capacity AS "settledCapacity",public_tags AS tags
      FROM gate.dao_policies WHERE profile_id=$1 AND dao=$2`, [profileId, daoSlug(dao)])).rows[0];
    return row ? clone(row) : null;
  }

  async isProfileAccepting(profileId, dao) {
    const row = (await this.pool.query(`SELECT EXISTS (
      SELECT 1 FROM gate.dao_policies d WHERE d.profile_id=$1 AND d.dao=$2
        AND (SELECT count(*) FROM gate.capacity_reservations r
          WHERE r.profile_id=d.profile_id AND r.state IN('active','expiry_pending_reconciliation')) < d.pending_reservation_capacity
        AND (SELECT count(*) FROM gate.capacity_reservations r
          WHERE r.profile_id=d.profile_id AND r.state='consumed'
            AND r.consumed_at>clock_timestamp()-interval '24 hours') < d.settled_capacity
      ) AS available`, [profileId, daoSlug(dao)])).rows[0];
    return row?.available === true;
  }

  async configureDeployment(deployment) {
    const chainId = positiveBigint(deployment.chainId, "chainId");
    const splitter = address(deployment.splitter, "splitter");
    const signer = address(deployment.signer, "signer");
    const token = address(deployment.token, "token");
    const gavelRecipient = address(deployment.gavelRecipient, "gavelRecipient");
    const block = uint78(deployment.deploymentBlock, "deploymentBlock");
    const codeHash = bytes32(deployment.contractCodeHash, "contractCodeHash");
    return this.#transaction(async (client) => {
      const row = (await client.query(`INSERT INTO gate.splitter_deployments
        (id,chain_id,splitter,signer,token,gavel_recipient,deployment_block,scanner_cursor,contract_code_hash,config,rpc_access_ciphertext,issuance_active,retired_at,retirement_ready_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)
        ON CONFLICT(id) DO UPDATE SET config=EXCLUDED.config,rpc_access_ciphertext=EXCLUDED.rpc_access_ciphertext,
          issuance_active=EXCLUDED.issuance_active,retired_at=EXCLUDED.retired_at,retirement_ready_at=EXCLUDED.retirement_ready_at
        WHERE (gate.splitter_deployments.chain_id,gate.splitter_deployments.splitter,gate.splitter_deployments.signer,
          gate.splitter_deployments.token,gate.splitter_deployments.gavel_recipient,gate.splitter_deployments.deployment_block,gate.splitter_deployments.contract_code_hash)
          = (EXCLUDED.chain_id,EXCLUDED.splitter,EXCLUDED.signer,EXCLUDED.token,EXCLUDED.gavel_recipient,EXCLUDED.deployment_block,EXCLUDED.contract_code_hash)
        RETURNING id,chain_id::text AS "chainId",splitter,signer,token,deployment_block::text AS "deploymentBlock",
          scanner_cursor::text AS "nextBlock",contract_code_hash AS "contractCodeHash",gavel_recipient AS "gavelRecipient",config,rpc_access_ciphertext AS "rpcAccess",
          issuance_active AS "issuanceActive",retired_at AS "retiredAt",retirement_ready_at AS "retirementReadyAt"`,
      [deployment.id, chainId, splitter, signer, token, gavelRecipient, block, block, codeHash, JSON.stringify(deployment.config || {}),
        typeof deployment.rpcAccess === "string" ? deployment.rpcAccess : JSON.stringify(deployment.rpcAccess || {}),
        deployment.issuanceActive === true, deployment.retiredAt ?? null, deployment.retirementReadyAt ?? null])).rows[0];
      invariant(row, "immutable deployment identity mismatch");
      await client.query(`INSERT INTO gate.settlement_cursors(deployment_id,chain_id,splitter,deployment_block,next_range_from)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(deployment_id) DO NOTHING`, [deployment.id, chainId, splitter, block, block]);
      return clone(row);
    });
  }

  async recordScannerRange(range) {
    if (!range || typeof range.deploymentId !== "string" || !range.deploymentId) throw new TypeError("deploymentId is required");
    const fromBlock = uint78(range.fromBlock, "fromBlock");
    const throughBlock = uint78(range.throughBlock, "throughBlock");
    const generation = positiveBigint(range.generation, "generation");
    invariant(BigInt(throughBlock) >= BigInt(fromBlock), "throughBlock precedes fromBlock");
    const canonicalBlockHash = bytes32(range.canonicalBlockHash, "canonicalBlockHash");
    const canonicalBlockTimestamp = exactDate(range.canonicalBlockTimestamp, "canonicalBlockTimestamp");
    if (!Array.isArray(range.canonicalBlocks)) throw new TypeError("canonicalBlocks must cover every block in the scanner range");
    const canonicalBlocks = range.canonicalBlocks.map((block, offset) => {
      const blockNumber = uint78(block?.blockNumber, "canonicalBlocks.blockNumber");
      invariant(BigInt(blockNumber) === BigInt(fromBlock) + BigInt(offset), "canonicalBlocks must cover every block in order");
      return {
        blockNumber,
        blockHash: bytes32(block.blockHash, "canonicalBlocks.blockHash"),
        blockTimestamp: exactDate(block.blockTimestamp, "canonicalBlocks.blockTimestamp").toISOString(),
      };
    });
    invariant(BigInt(canonicalBlocks.length) === BigInt(throughBlock) - BigInt(fromBlock) + 1n,
      "canonicalBlocks must cover every block in the scanner range");
    const checkpoint = canonicalBlocks.at(-1);
    invariant(checkpoint.blockHash === canonicalBlockHash
      && sameTimestamp(checkpoint.blockTimestamp, canonicalBlockTimestamp),
    "canonical checkpoint must match the final canonical block");
    if (!Array.isArray(range.observations)) throw new TypeError("observations must be a complete array");
    const observations = range.observations.map((observation) => {
      if (!observation || !["exact_log", "anomaly"].includes(observation.kind)) throw new TypeError("invalid scanner observation kind");
      const exactMatch = observation.exactMatch === true;
      if (observation.kind === "exact_log" && !exactMatch) throw new TypeError("exact_log observation must be an exact match");
      if (observation.kind === "anomaly" && exactMatch) throw new TypeError("anomaly observation cannot be an exact match");
      const normalized = {
        kind: observation.kind,
        quoteId: observation.quoteId == null ? null : bytes32(observation.quoteId, "observation.quoteId"),
        txHash: bytes32(observation.txHash, "observation.txHash"),
        logIndex: positiveInteger(Number(observation.logIndex) + 1, "observation.logIndex") - 1,
        blockNumber: uint78(observation.blockNumber, "observation.blockNumber"),
        blockHash: bytes32(observation.blockHash, "observation.blockHash"),
        blockTimestamp: exactDate(observation.blockTimestamp, "observation.blockTimestamp").toISOString(),
        exactMatch,
        details: observation.details || {},
      };
      const canonicalBlock = canonicalBlocks[Number(BigInt(normalized.blockNumber) - BigInt(fromBlock))];
      invariant(canonicalBlock && canonicalBlock.blockHash === normalized.blockHash
        && sameTimestamp(canonicalBlock.blockTimestamp, normalized.blockTimestamp),
      "scanner observation must match its canonical block evidence");
      return normalized;
    });
    const result = {
      generation,
      kind: observations.length === 0 ? "no_match" : "observations",
      canonicalBlocks,
      observations,
      metadata: range.metadata || {},
    };
    return this.#transaction(async (client) => {
      const row = (await client.query("SELECT gate.record_scanner_range($1,$2,$3,$4,$5,$6::jsonb) AS released",
        [range.deploymentId, fromBlock, throughBlock, canonicalBlockHash, canonicalBlockTimestamp, JSON.stringify(result)])).rows[0];
      return { released: Number(row?.released || 0) };
    });
  }

  #validateIssuance({ context, snapshot, submission, quote, reservation }) {
    invariant(snapshot && submission && quote && reservation, "complete issuance material is required");
    invariant(context?.authPassed === true && context?.parsePassed === true, "authenticated and parsed issuance context is required");
    const normalized = {
      context: {
        expectedProfileVersion: positiveBigint(context.expectedProfileVersion, "expectedProfileVersion"),
        walletKind: context.walletKind,
        authenticatedSender: address(context.authenticatedSender, "authenticatedSender"),
        payerIsEoa: context.payerIsEoa === true,
        stage: lifecycle(context.stage, "stage"), deploymentCodeHash: bytes32(context.deploymentCodeHash, "deploymentCodeHash"),
      },
      snapshot: { ...snapshot, dao: daoSlug(snapshot.dao), proposalId: uint78(snapshot.proposalId, "proposalId"),
        contentHash: bytes32(snapshot.contentHash, "contentHash"), sourceBlock: uint78(snapshot.sourceBlock, "sourceBlock"),
        sourceBlockHash: bytes32(snapshot.sourceBlockHash, "sourceBlockHash"), mappingVersion: snapshot.mappingVersion,
        canonicalActions: snapshot.canonicalActions },
      submission: { ...submission, submissionHash: bytes32(submission.submissionHash, "submissionHash"),
        payer: address(submission.payer, "payer"), signedSender: address(submission.signedSender, "signed_sender") },
      quote: { ...quote, quoteId: bytes32(quote.quoteId, "quoteId"), payer: address(quote.payer, "quote payer"),
        voter: address(quote.voter, "voter"), attentionAmount: uint78(quote.attentionAmount, "attentionAmount", 1000000n),
        feeAmount: uint78(quote.feeAmount, "feeAmount"), token: address(quote.token, "token"),
        baseChainId: positiveBigint(quote.baseChainId, "baseChainId"), splitter: address(quote.splitter, "splitter"),
        quoteVersion: Number(quote.quoteVersion), expiresAt: null },
      reservation: { ...reservation, amount: uint78(reservation.amount, "reservation amount", 1000000n), expiresAt: null },
    };
    invariant(normalized.submission.payer === normalized.submission.signedSender, "payer must equal signed_sender");
    invariant(normalized.submission.payer === normalized.context.authenticatedSender, "payer must equal authenticated signed sender");
    invariant(normalized.context.payerIsEoa, "payer must be an EOA");
    invariant(Array.isArray(normalized.snapshot.canonicalActions), "canonicalActions must be an array");
    return normalized;
  }

  #validateFreshIssuance(normalized) {
    invariant(normalized.quote.payer === normalized.submission.payer, "quote payer must equal submission payer");
    invariant(normalized.quote.feeAmount === "250000", "feeAmount must equal 250000");
    invariant(normalized.quote.quoteVersion === 1, "quoteVersion must equal 1");
    invariant(normalized.quote.baseChainId === "8453", "quote settlement chain must be Base 8453");
    invariant(normalized.snapshot.mappingVersion === NOUNS_LIFECYCLE_MAPPING_VERSION,
      `mappingVersion must equal ${NOUNS_LIFECYCLE_MAPPING_VERSION}`);
    invariant(normalized.snapshot.dao !== "nouns" || (normalized.context.stage === "VOTING"
      && normalized.snapshot.nativeState === "ACTIVE" && normalized.snapshot.eligibility === "VOTING"),
    "Nouns issuance requires canonical ACTIVE to VOTING lifecycle mapping");
    invariant(normalized.reservation.profileId === normalized.submission.profileId, "reservation profile must equal submission profile");
    invariant(normalized.reservation.amount === normalized.quote.attentionAmount, "reservation amount must equal attention amount");
    return normalized;
  }

  #resumeOwnedDuplicate(row, submission) {
    if (!row) return null;
    if (row.payer === submission.payer && row.profileId === submission.profileId) return resume(row);
    throw new Error("submission is unavailable");
  }

  async issue(input) {
    const value = this.#validateIssuance(input);
    const { context, snapshot, submission, quote, reservation } = value;
    return this.#transaction(async (client) => {
      const duplicate = (await client.query(`SELECT public_id AS "publicId",status,payer,profile_id AS "profileId"
        FROM gate.submissions WHERE submission_hash=$1`, [submission.submissionHash])).rows[0];
      const duplicateResume = this.#resumeOwnedDuplicate(duplicate, submission);
      if (duplicateResume) return duplicateResume;
      this.#validateFreshIssuance(value);
      await this.#profileLock(client, submission.profileId);
      const lockedDuplicate = (await client.query(`SELECT public_id AS "publicId",status,payer,profile_id AS "profileId"
        FROM gate.submissions WHERE submission_hash=$1`, [submission.submissionHash])).rows[0];
      const lockedDuplicateResume = this.#resumeOwnedDuplicate(lockedDuplicate, submission);
      if (lockedDuplicateResume) return lockedDuplicateResume;
      const profile = (await client.query("SELECT * FROM gate.profiles WHERE id=$1 FOR UPDATE", [submission.profileId])).rows[0];
      invariant(profile, "issuance unavailable");
      invariant(profile.wallet === quote.voter, "issuance unavailable");
      invariant(profile.availability === "accepting_now", "issuance unavailable");
      invariant(String(profile.profile_version) === context.expectedProfileVersion, "issuance context changed");
      invariant(profile.wallet_kind === context.walletKind, "issuance context changed");
      const policy = (await client.query("SELECT * FROM gate.dao_policies WHERE profile_id=$1 AND dao=$2 FOR UPDATE", [submission.profileId, snapshot.dao])).rows[0];
      invariant(policy?.enabled === true && String(policy.chain_id) === "1", "issuance unavailable");
      invariant(String(policy.attention_amount) === quote.attentionAmount, "issuance context changed");
      invariant(context.stage === "VOTING" && policy.accept_voting, "issuance unavailable: Nouns permits only VOTING");
      const deployment = (await client.query("SELECT * FROM gate.splitter_deployments WHERE id=$1 FOR SHARE", [quote.deploymentId])).rows[0];
      invariant(deployment?.issuance_active === true && String(deployment.chain_id) === quote.baseChainId && deployment.splitter === quote.splitter
        && deployment.token === quote.token && deployment.contract_code_hash === context.deploymentCodeHash, "issuance context changed");
      if (profile.wallet_kind === "contract") {
        invariant(typeof this.baseCodeReader === "function", "Base code reader unavailable");
        let timer;
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Base code read timed out")), this.rpcTimeoutMs); });
        let code;
        try { code = await Promise.race([this.baseCodeReader({ wallet: profile.wallet, chainId: quote.baseChainId }), timeout]); }
        finally { clearTimeout(timer); }
        invariant(typeof code === "string" && /^0x[0-9a-fA-F]+$/.test(code) && code !== "0x", "current Base payout code unavailable");
        invariant(profile.base_payout_code_hash && keccak256(code).toLowerCase() === profile.base_payout_code_hash, "current Base payout code changed");
      }
      const lifetime = (await client.query(`SELECT issued_at AS now,issued_at+interval '600 seconds' AS "expiresAt"
        FROM (SELECT date_trunc('second',clock_timestamp()) AS issued_at) trusted_clock`)).rows[0];
      const issuedAt = exactDate(lifetime?.now, "database clock");
      const expiresAt = exactDate(lifetime?.expiresAt, "database quote expiry");
      invariant(expiresAt.valueOf() - issuedAt.valueOf() === 600_000, "database quote lifetime must be exactly 600 seconds");
      quote.expiresAt = expiresAt;
      reservation.expiresAt = expiresAt;
      const limits = (await client.query(`SELECT
        (SELECT count(*)::int FROM gate.capacity_reservations r WHERE r.profile_id=$1 AND r.state IN('active','expiry_pending_reconciliation')) AS pending_count,
        (SELECT count(*)::int FROM gate.capacity_reservations r2 JOIN gate.quotes q2 ON q2.id=r2.quote_id JOIN gate.submissions s2 ON s2.id=q2.submission_id
          WHERE s2.profile_id=$1 AND r2.state='consumed' AND r2.consumed_at>clock_timestamp()-interval '24 hours') AS settled_count,
        (SELECT count(*)::int FROM gate.capacity_reservations r2 JOIN gate.quotes q2 ON q2.id=r2.quote_id
          JOIN gate.submissions s2 ON s2.id=q2.submission_id JOIN gate.proposal_snapshots ps ON ps.id=s2.issuance_snapshot_id
          WHERE s2.profile_id=$1 AND r2.state='consumed' AND r2.consumed_at>clock_timestamp()-interval '24 hours'
            AND s2.payer=$2 AND q2.voter=$3 AND ps.proposal_id=$4 AND ps.dao=$5) AS pair_proposal,
        (SELECT count(*)::int FROM gate.quotes q2 JOIN gate.submissions s2 ON s2.id=q2.submission_id
          WHERE s2.profile_id=$1 AND q2.state='quoted' AND q2.expires_at>clock_timestamp() AND s2.payer=$2 AND q2.voter=$3) AS active_pair`,
      [submission.profileId, submission.payer, quote.voter, snapshot.proposalId, snapshot.dao])).rows[0];
      // These two are separate frozen rejection codes, not capacity: the HTTP
      // layer maps them to coarse ACTIVE_QUOTE_EXISTS / SENDER_PROPOSAL_LIMIT.
      invariant(Number(limits.active_pair) === 0, "ACTIVE_QUOTE_EXISTS");
      invariant(Number(limits.pair_proposal) < 2, "SENDER_PROPOSAL_LIMIT");
      invariant(Number(limits.pending_count) < Number(policy.pending_reservation_capacity)
        && Number(limits.settled_count) < Number(policy.settled_capacity), "issuance capacity unavailable");

      await client.query("SAVEPOINT gate_issue_material");
      try {
        await client.query(`INSERT INTO gate.proposal_snapshots
          (id,dao,proposal_id,content_hash,native_state,normalized_eligibility,mapping_version,source_block,source_block_hash,refreshed_at,canonical_facts,decoded_facts,canonical_actions)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb)`,
        [snapshot.id, snapshot.dao, snapshot.proposalId, snapshot.contentHash, snapshot.nativeState, snapshot.eligibility, snapshot.mappingVersion,
          snapshot.sourceBlock, snapshot.sourceBlockHash, snapshot.refreshedAt, JSON.stringify(snapshot.canonicalFacts),
          JSON.stringify(snapshot.decodedFacts), JSON.stringify(snapshot.canonicalActions)]);
        let publicId;
        for (let attempt = 0; attempt < PUBLIC_ID_ATTEMPTS; attempt += 1) {
          publicId = publicIdFrom(this.randomBytes(16));
          await client.query("SAVEPOINT gate_public_id");
          try {
            await client.query(`INSERT INTO gate.submissions(id,public_id,submission_hash,profile_id,issuance_snapshot_id,payer,signed_sender,material)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [submission.id, publicId, submission.submissionHash, submission.profileId,
              snapshot.id, submission.payer, submission.signedSender, JSON.stringify(submission.material)]);
            await client.query("RELEASE SAVEPOINT gate_public_id");
            break;
          } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT gate_public_id"); await client.query("RELEASE SAVEPOINT gate_public_id");
            if (error.code === "23505" && error.constraint === "submissions_submission_hash_key") throw error;
            if (error.code !== "23505" || error.constraint !== "submissions_public_id_key") throw new Error("issuance unavailable");
            publicId = null;
          }
        }
        invariant(publicId, "public id allocation unavailable");
        await client.query(`INSERT INTO gate.quotes(id,quote_id,submission_id,payer,voter,attention_amount,fee_amount,token,base_chain_id,splitter,deployment_id,quote_version,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [quote.id, quote.quoteId, submission.id, quote.payer, quote.voter,
          quote.attentionAmount, quote.feeAmount, quote.token, quote.baseChainId, quote.splitter, quote.deploymentId, quote.quoteVersion, quote.expiresAt]);
        await client.query("INSERT INTO gate.capacity_reservations(id,profile_id,quote_id,amount,expires_at) VALUES($1,$2,$3,$4,$5)",
          [reservation.id, submission.profileId, quote.id, reservation.amount, reservation.expiresAt]);
        const unsignedQuote = Object.freeze({ quoteId: quote.quoteId, payer: quote.payer, voter: quote.voter,
          attentionAmount: quote.attentionAmount, gavelFeeAmount: quote.feeAmount, submissionHash: submission.submissionHash,
          token: quote.token, expiry: Math.floor(quote.expiresAt.valueOf() / 1000), quoteVersion: quote.quoteVersion });
        invariant(typeof this.quoteSigner === "function", "quote signer unavailable");
        const signature = await this.quoteSigner(unsignedQuote);
        invariant(typeof signature === "string" && signature.length > 0, "quote signer unavailable");
        const signed = await client.query("UPDATE gate.quotes SET quote_signature=$2 WHERE id=$1 AND quote_signature IS NULL", [quote.id, signature]);
        invariant(signed.rowCount === 1, "quote signature could not be persisted");
        await client.query("RELEASE SAVEPOINT gate_issue_material");
        return { resumed: false, publicId, submission: { id: submission.id, publicId, status: "QUOTED" }, quote: clone({ ...quote, signature, state: "quoted", reservationState: "reserved" }) };
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT gate_issue_material"); await client.query("RELEASE SAVEPOINT gate_issue_material");
        if (error.code === "23505" && error.constraint === "submissions_submission_hash_key") {
          const winner = (await client.query(`SELECT public_id AS "publicId",status,payer,profile_id AS "profileId"
            FROM gate.submissions WHERE submission_hash=$1`, [submission.submissionHash])).rows[0];
          const winnerResume = this.#resumeOwnedDuplicate(winner, submission);
          invariant(winnerResume, "submission is unavailable");
          return winnerResume;
        }
        throw error;
      }
    });
  }

  async countLiabilities(profileId) {
    const row = (await this.pool.query("SELECT count(*)::text AS total FROM gate.capacity_reservations WHERE profile_id=$1 AND state IN('active','expiry_pending_reconciliation')", [profileId])).rows[0];
    return BigInt(row.total);
  }

  async markSettlementPending(publicId, pending = true) {
    if (typeof pending !== "boolean") throw new TypeError("pending settlement marker must be boolean");
    const expectedStatus = pending ? "QUOTED" : "SETTLEMENT_PENDING";
    const targetStatus = pending ? "SETTLEMENT_PENDING" : "QUOTED";
    return this.#transaction(async (client) => {
      const row = (await client.query(`SELECT s.id,s.status,q.state::text AS quote_state,
        q.expires_at>clock_timestamp() AS unexpired FROM gate.submissions s
        JOIN gate.quotes q ON q.submission_id=s.id WHERE s.public_id=$1 FOR UPDATE OF s,q`, [publicId])).rows[0];
      invariant(row, "submission not found");
      invariant(row.quote_state === "quoted" && row.unexpired === true, "settlement hint can change only while quote is valid");
      if (row.status === targetStatus) return false;
      invariant(row.status === expectedStatus, "settlement hint can change only while quote is valid");
      const changed = await client.query(`UPDATE gate.submissions SET status=$2,
        public_state_changed_at=clock_timestamp() WHERE id=$1 AND status=$3`, [row.id, targetStatus, expectedStatus]);
      invariant(changed.rowCount === 1, "settlement hint can change only while quote is valid");
      return true;
    });
  }

  async markExpired() {
    return this.#transaction(async (client) => {
      const result = await client.query(`WITH expired AS (UPDATE gate.quotes SET state='expired' WHERE state='quoted' AND expires_at<=clock_timestamp() RETURNING id,submission_id),
        reservations AS (UPDATE gate.capacity_reservations r SET state='expiry_pending_reconciliation',updated_at=clock_timestamp() FROM expired e WHERE r.quote_id=e.id AND r.state='active' RETURNING r.id)
        UPDATE gate.submissions s SET status='EXPIRED',public_state_changed_at=clock_timestamp() FROM expired e WHERE s.id=e.submission_id RETURNING s.id`);
      return result.rowCount;
    });
  }

  async releaseReservation(quoteId, evidence) {
    const publicQuoteId = bytes32(quoteId, "quoteId");
    if (!evidence || typeof evidence.deploymentId !== "string" || !evidence.deploymentId) throw new TypeError("deploymentId is required");
    return this.#transaction(async (client) => {
      const row = (await client.query("SELECT gate.release_expired_reservation($1,$2) AS released", [publicQuoteId, evidence.deploymentId])).rows[0];
      return row?.released === true;
    });
  }

  #settlementEvidence(settlement) {
    if (!settlement?.event || !settlement.evidence) {
      throw new TypeError("exact settlement event and scanner evidence are required");
    }
    const event = settlement.event;
    const evidence = settlement.evidence;
    if (Object.keys(event).sort().join("\u0000") !== SETTLEMENT_EVENT_FIELDS.join("\u0000")) {
      throw new TypeError("QuoteSettled event must contain exactly the frozen eight fields");
    }
    return {
      txHash: bytes32(settlement.txHash, "txHash"), logIndex: Number(settlement.logIndex), receiptBlock: uint78(settlement.receiptBlock, "receiptBlock"),
      receiptBlockHash: bytes32(settlement.receiptBlockHash, "receiptBlockHash"), receiptBlockTimestamp: exactDate(settlement.receiptBlockTimestamp, "receiptBlockTimestamp"),
      settledAt: exactDate(settlement.settledAt, "settledAt"),
      quoteId: bytes32(event.quoteId, "event.quoteId"), payer: address(event.payer, "event.payer"), voter: address(event.voter, "event.voter"),
      attentionAmount: uint78(event.attentionAmount, "event.attentionAmount", 1000000n), feeAmount: uint78(event.gavelFeeAmount, "event.gavelFeeAmount"),
      gavelRecipient: address(event.gavelRecipient, "event.gavelRecipient"),
      token: address(event.token, "event.token"), submissionHash: bytes32(event.submissionHash, "event.submissionHash"),
      sourceChainId: positiveBigint(evidence.chainId, "evidence.chainId"),
      splitter: address(evidence.splitter, "evidence.splitter"), canonical: evidence.canonical === true,
      scannerVerified: evidence.scannerVerified === true, oneConfirmation: evidence.oneConfirmation === true, confirmations: 1,
    };
  }

  async settle({ quoteId, settlement, inbox, notification, monitor }) {
    const publicQuoteId = bytes32(quoteId, "quoteId");
    const e = this.#settlementEvidence(settlement);
    invariant(Number.isInteger(e.logIndex) && e.logIndex >= 0 && e.canonical && e.scannerVerified && e.oneConfirmation,
      "canonical one-confirmation scanner evidence is required");
    invariant(e.quoteId === publicQuoteId, "settlement quoteId does not match public quote");
    if (!notification?.id || notification.status !== "pending") throw new TypeError("notification must start pending");
    if (!inbox?.id || typeof inbox.lifecycleChanged !== "boolean" || typeof inbox.currentLifecycleUnavailable !== "boolean") {
      throw new TypeError("inbox lifecycle flags must be boolean");
    }
    lifecycle(inbox.issuanceLifecycle, "issuanceLifecycle"); lifecycle(inbox.currentLifecycle, "currentLifecycle");
    invariant(inbox.issuanceLifecycle === "VOTING", "inbox issuance lifecycle must be VOTING");
    invariant(CURRENT_LIFECYCLES.has(inbox.currentLifecycle), "current lifecycle must be VOTING, CLOSED, or UNKNOWN");
    if (inbox.currentLifecycleUnavailable) {
      invariant(inbox.currentLifecycle === "UNKNOWN" && inbox.lifecycleChanged === false,
        "unavailable lifecycle requires UNKNOWN without a change claim");
    } else {
      invariant(inbox.currentLifecycle !== "UNKNOWN", "UNKNOWN lifecycle must be marked unavailable");
      invariant(inbox.lifecycleChanged === (inbox.currentLifecycle !== inbox.issuanceLifecycle),
        "lifecycle change flag does not match lifecycle values");
    }
    invariant(inbox.currentLifecycleUnavailable || inbox.privateUnavailabilityReason == null,
      "private unavailability reason requires unavailable lifecycle");
    invariant(monitor?.id, "monitor id is required");
    const nextCheckBlock = uint78(monitor.nextCheckBlock, "nextCheckBlock");
    invariant(BigInt(nextCheckBlock) >= BigInt(e.receiptBlock), "nextCheckBlock must cover receipt block");
    return this.#transaction(async (client) => {
      const owner = (await client.query("SELECT s.profile_id FROM gate.quotes q JOIN gate.submissions s ON s.id=q.submission_id WHERE q.quote_id=$1", [publicQuoteId])).rows[0];
      invariant(owner, "quote not found");
      await this.#profileLock(client, owner.profile_id);
      const quote = (await client.query(`SELECT q.*,s.id AS submission_internal_id,s.profile_id,s.submission_hash,
        ps.normalized_eligibility AS issuance_lifecycle,d.gavel_recipient
        FROM gate.quotes q JOIN gate.submissions s ON s.id=q.submission_id
        JOIN gate.proposal_snapshots ps ON ps.id=s.issuance_snapshot_id JOIN gate.splitter_deployments d ON d.id=q.deployment_id
        WHERE q.quote_id=$1 FOR UPDATE OF q`, [publicQuoteId])).rows[0];
      invariant(quote && quote.profile_id === owner.profile_id, "quote not found");
      invariant(quote.issuance_lifecycle === inbox.issuanceLifecycle, "inbox issuance lifecycle does not match frozen snapshot");
      const exact = quote.quote_id === e.quoteId && quote.payer === e.payer && quote.voter === e.voter && String(quote.attention_amount) === e.attentionAmount
        && String(quote.fee_amount) === e.feeAmount && quote.gavel_recipient === e.gavelRecipient && quote.token === e.token
        && quote.submission_hash === e.submissionHash && Number(quote.quote_version) === 1
        && String(quote.base_chain_id) === e.sourceChainId && quote.splitter === e.splitter;
      invariant(exact && e.receiptBlockTimestamp < new Date(quote.expires_at), "settlement evidence does not match quote");
      if (quote.state === "settled") {
        const evidenceMatches = quote.settled_tx_hash === e.txHash && Number(quote.settled_log_index) === e.logIndex
          && String(quote.receipt_block) === e.receiptBlock && quote.receipt_block_hash === e.receiptBlockHash
          && sameTimestamp(quote.receipt_block_timestamp, e.receiptBlockTimestamp) && sameTimestamp(quote.settled_at, e.settledAt)
          && quote.settlement_proof_canonical === true && quote.settlement_scanner_verified === true
          && quote.settlement_event_quote_id === e.quoteId && Number(quote.settlement_confirmations) === e.confirmations;
        invariant(evidenceMatches, "conflicting settlement evidence");
        const related = (await client.query(`SELECT i.id AS inbox_id,i.issuance_lifecycle,i.current_lifecycle,i.lifecycle_changed,
          i.current_lifecycle_unavailable,i.private_unavailability_reason,n.id AS notification_id,n.channel,
          n.destination_ref_ciphertext,m.id AS monitor_id
          FROM gate.inbox_items i JOIN gate.notification_attempts n ON n.inbox_id=i.id
          JOIN gate.settlement_reorg_monitors m ON m.quote_id=$2 WHERE i.submission_id=$1`,
        [quote.submission_internal_id, quote.id])).rows[0];
        invariant(related && related.inbox_id === inbox.id && related.issuance_lifecycle === inbox.issuanceLifecycle
          && related.current_lifecycle === inbox.currentLifecycle && related.lifecycle_changed === inbox.lifecycleChanged
          && related.current_lifecycle_unavailable === inbox.currentLifecycleUnavailable
          && related.private_unavailability_reason === (inbox.privateUnavailabilityReason ?? null)
          && related.notification_id === notification.id && related.channel === notification.channel
          && related.destination_ref_ciphertext === notification.destinationRef && related.monitor_id === monitor.id,
        "conflicting settlement side effects");
        return false;
      }
      invariant(["quoted", "expired"].includes(quote.state), "quote cannot be settled");
      await client.query(`UPDATE gate.quotes SET state='settled',reservation_state='consumed',settled_tx_hash=$2,settled_log_index=$3,settled_at=$4,
        receipt_block=$5,receipt_block_hash=$6,receipt_block_timestamp=$7,settlement_proof_canonical=$8,settlement_confirmations=$9,
        settlement_payer=$10,settlement_voter=$11,settlement_attention_amount=$12,settlement_fee_amount=$13,settlement_token=$14,
        settlement_submission_hash=$15,settlement_quote_version=$16,settlement_source_chain_id=$17,settlement_splitter=$18,
        settlement_scanner_verified=$19,settlement_event_quote_id=$20,settlement_gavel_recipient=$21 WHERE id=$1`,
      [quote.id, e.txHash, e.logIndex, e.settledAt, e.receiptBlock, e.receiptBlockHash, e.receiptBlockTimestamp, e.canonical, e.confirmations,
        e.payer, e.voter, e.attentionAmount, e.feeAmount, e.token, e.submissionHash, quote.quote_version, e.sourceChainId, e.splitter,
        e.scannerVerified, e.quoteId, e.gavelRecipient]);
      const consumed = await client.query(`UPDATE gate.capacity_reservations SET state='consumed',consumed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE quote_id=$1 AND state IN('active','expiry_pending_reconciliation','released') RETURNING id`, [quote.id]);
      invariant(consumed.rowCount === 1, "reservation cannot be consumed");
      await client.query("UPDATE gate.submissions SET status='SETTLED',public_state_changed_at=clock_timestamp() WHERE id=$1", [quote.submission_internal_id]);
      const accepted = (await client.query(`INSERT INTO gate.inbox_items
        (id,submission_id,profile_id,issuance_lifecycle,current_lifecycle,lifecycle_changed,current_lifecycle_unavailable,private_unavailability_reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING inbox_created_at AS "inboxCreatedAt"`, [inbox.id, quote.submission_internal_id,
        quote.profile_id, inbox.issuanceLifecycle, inbox.currentLifecycle, inbox.lifecycleChanged === true,
        inbox.currentLifecycleUnavailable === true, inbox.privateUnavailabilityReason ?? null])).rows[0];
      await client.query("INSERT INTO gate.notification_attempts(id,inbox_id,channel,destination_ref_ciphertext,state) VALUES($1,$2,$3,$4,$5)",
        [notification.id, inbox.id, notification.channel, notification.destinationRef, notification.status]);
      await client.query(`INSERT INTO gate.settlement_reorg_monitors(id,chain_id,splitter,quote_id,receipt_block,receipt_block_hash,tx_hash,log_index,next_check_block)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(chain_id,splitter,quote_id) DO NOTHING`,
      [monitor.id, e.sourceChainId, e.splitter, quote.id, e.receiptBlock, e.receiptBlockHash, e.txHash, e.logIndex, nextCheckBlock]);
      return { settled: true, inboxCreatedAt: accepted.inboxCreatedAt };
    });
  }

  async updateNotification(id, patch = {}) {
    const allowed = new Set(["status", "providerOpaqueId", "errorCode"]);
    if (Object.keys(patch).some((field) => !allowed.has(field))) throw new TypeError("notification patch contains an immutable field");
    if (patch.status !== undefined && !["pending", "sent", "failed"].includes(patch.status)) throw new TypeError("invalid notification status");
    const row = (await this.pool.query(`SELECT id,"inboxId",channel,status,"providerOpaqueId","errorCode","retryCount","createdAt","updatedAt"
      FROM gate.transition_notification($1,$2,$3,$4,$5,$6,$7)`,
    [id, patch.status ?? null, patch.providerOpaqueId ?? null, Object.hasOwn(patch, "providerOpaqueId"),
      patch.errorCode ?? null, Object.hasOwn(patch, "errorCode"), this.notificationRetryLimit])).rows[0];
    invariant(row, "notification not found"); return clone(row);
  }

  async counts() {
    return clone((await this.pool.query(`SELECT (SELECT count(*)::int FROM gate.proposal_snapshots) AS snapshots,
      (SELECT count(*)::int FROM gate.submissions) AS submissions,(SELECT count(*)::int FROM gate.quotes) AS quotes,
      (SELECT count(*)::int FROM gate.capacity_reservations) AS reservations,(SELECT count(*)::int FROM gate.inbox_items) AS "inboxItems",
      (SELECT count(*)::int FROM gate.notification_attempts) AS notifications,(SELECT count(*)::int FROM gate.settlement_reorg_monitors) AS monitors`)).rows[0]);
  }
}

function createPublicGateReader(queryable) {
  if (!queryable || typeof queryable.query !== "function") throw new TypeError("queryable.query is required");
  return Object.freeze({
    async getProfile(id) {
      const row = (await queryable.query(`SELECT id,wallet,wallet_kind AS "walletKind",availability,ens,message,
        enrolled_at AS "enrolledAt",updated_at AS "updatedAt" FROM gate_public.profiles WHERE id=$1`, [id])).rows[0];
      if (!row) return null;
      row.display = {
        ...(typeof row.ens === "string" ? { ens: row.ens } : {}),
        ...(typeof row.message === "string" ? { message: row.message } : {}),
      };
      delete row.ens; delete row.message;
      return row;
    },
    async getPolicy(profileId, dao) {
      return (await queryable.query(`SELECT profile_id AS "profileId",dao,chain_id::text AS "chainId",enabled,
        accept_pre_vote AS "acceptPreVote",accept_voting AS "acceptVoting",attention_amount::text AS "attentionAmount",public_tags AS tags
        FROM gate_public.dao_policies WHERE profile_id=$1 AND dao=$2`, [profileId, daoSlug(dao)])).rows[0] || null;
    },
    async getSubmission(publicId) {
      const row = (await queryable.query(`SELECT public_id AS "publicId",state,
        updated_at AS "updatedAt",accepted_at AS "acceptedAt"
        FROM gate_public.submission_receipts WHERE public_id=$1`, [publicId])).rows[0];
      if (!row) return null;
      const status = ({ payment_required: "QUOTED", pending_settlement: "SETTLEMENT_PENDING", accepted: "SETTLED", expired: "EXPIRED" })[row.state];
      return publicSubmissionProjection(
        { publicId: row.publicId, status, publicStateChangedAt: row.updatedAt },
        row.acceptedAt == null ? null : { inboxCreatedAt: row.acceptedAt },
      );
    },
  });
}

module.exports = { PostgresGateStore, createPublicGateReader };
