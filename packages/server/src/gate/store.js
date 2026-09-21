const crypto = require("node:crypto");
const { Pool } = require("pg");
const { keccak256 } = require("ethers");
const { NOUNS_CANDIDATE_MAPPING_VERSION, NOUNS_LIFECYCLE_MAPPING_VERSION } = require("@gavel/gate");
const {
  DEFAULT_NOTIFICATION_RETRY_LIMIT,
  normalizeCapacityPolicy,
  publicState,
  publicSubmissionProjection,
  requireCanonicalActions,
  requireCanonicalIssuanceMaterial,
} = require("./semantic-contract");
const {
  assertSignerDeploymentBinding,
  assertStoreOwnedQuoteMaterial,
  buildIssuedQuoteMessage,
  issuedQuotePayload,
  signIssuedQuote,
} = require("./quote-issuance");

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DAO = /^[a-z][a-z0-9-]{0,62}$/;
const UINT78 = /^\d{1,78}$/;
const LIFECYCLES = new Set(["PRE_VOTE", "VOTING", "CLOSED", "UNKNOWN"]);
const CURRENT_LIFECYCLES = new Set(["PRE_VOTE", "VOTING", "CLOSED", "UNKNOWN"]);
const PUBLIC_ID_ATTEMPTS = 5;
const PROFILE_PAGE_LIMIT = 50;
const PROFILE_MAX_OFFSET = 10_000;
const PRODUCTION_BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SETTLEMENT_CHAINS = new Set(["8453", "84532"]);
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
function explicitDeploymentEnvironment(deployment) {
  const environment = deployment?.config?.environment;
  const chainId = String(deployment?.chain_id ?? deployment?.chainId);
  const token = deployment?.token;
  const label = deployment?.config?.testTokenLabel;
  if (environment === "production") {
    return chainId === "8453" && token === PRODUCTION_BASE_USDC
      && !Object.hasOwn(deployment.config, "testTokenLabel");
  }
  return environment === "test" && chainId === "84532"
    && typeof label === "string" && label.trim() !== "";
}
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
      getNonceByHash: (nonceHash) => this.#getNonceByHash(client, nonceHash),
      consumeAuthNonceAndInsertSession: async ({ expectedNonce, tokenHash, consumedAt, sessionExpiry } = {}) => {
        const row = (await client.query(`SELECT ${AUTH_SESSION_COLUMNS}
          FROM gate.consume_auth_nonce_and_insert_session($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
          bytes32(expectedNonce?.nonceHash, "nonceHash"), bytes32(expectedNonce?.payloadHash, "payloadHash"),
          address(expectedNonce?.wallet, "nonce wallet"), expectedNonce?.role,
          positiveBigint(expectedNonce?.chainId, "nonce chainId"), expectedNonce?.audience,
          address(expectedNonce?.verifier, "nonce verifier"), uint78(expectedNonce?.issuedAt, "nonce issuedAt"),
          uint78(expectedNonce?.expiry, "nonce expiry"), uint78(consumedAt, "consumedAt"),
          bytes32(tokenHash, "tokenHash"), uint78(sessionExpiry, "session expiry"),
        ])).rows[0];
        invariant(row, "authentication proof unavailable");
        return clone(row);
      },
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
    const source = lock ? "gate.lock_profile_auth_nonce($1)" : "gate.auth_nonces";
    const where = lock ? "" : " WHERE nonce_hash=$1";
    const row = (await queryable.query(`SELECT ${AUTH_NONCE_COLUMNS} FROM ${source}${where}`,
      [bytes32(nonceHash, "nonceHash")])).rows[0];
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
        && (normalizedPolicy.acceptPreVote || normalizedPolicy.acceptVoting)),
      "Nouns policy must use Ethereum chain 1 with at least one accepted PRE_VOTE or VOTING stage");
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
        getNonceByHash: (nonceHash) => this.#getNonceByHash(client, nonceHash, true),
        consumeNonce: auth.consumeNonce,
        getProfileByWallet: (value) => this.#getProfileByWallet(client, value),
        mutateProfile: (input) => {
          invariant(address(input?.profile?.wallet, "profile wallet") === canonicalWallet,
            "profile transaction wallet mismatch");
          return this.#mutateProfile(input, client);
        },
        setDeliverySetting: async (profileId, ciphertext) => {
          invariant(typeof profileId === "string" && profileId.length > 0, "delivery setting profile is required");
          invariant(typeof ciphertext === "string" && ciphertext.length <= 1024
            && /^gg1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ciphertext),
          "delivery setting must be a canonical encrypted envelope");
          await client.query("SELECT gate.set_delivery_setting($1,$2,$3)", [profileId, canonicalWallet, ciphertext]);
        },
      }));
    });
  }

  async #getProfileByWallet(queryable, wallet) {
    const row = (await queryable.query(`SELECT id,wallet,wallet_kind AS "walletKind",availability,
      profile_version AS "profileVersion",enrolled_at AS "enrolledAt",updated_at AS "updatedAt",
      base_payout_verified_at AS "basePayoutVerifiedAt",base_payout_code_hash AS "basePayoutCodeHash",display_cache AS display
      FROM gate.profiles WHERE wallet=$1`, [address(wallet, "wallet")])).rows[0];
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
    const config = { ...(deployment.config || {}),
      overlap: positiveInteger(Number(deployment.config?.overlap ?? 64), "deployment.config.overlap") };
    invariant(explicitDeploymentEnvironment({ chainId, token, config }),
      "deployment environment is not valid for its chain and token");
    return this.#transaction(async (client) => {
      const row = (await client.query(`INSERT INTO gate.splitter_deployments
        (id,chain_id,splitter,signer,token,gavel_recipient,deployment_block,scanner_cursor,contract_code_hash,config,rpc_access_ciphertext,issuance_active,retired_at,retirement_ready_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)
        ON CONFLICT(id) DO UPDATE SET config=EXCLUDED.config,rpc_access_ciphertext=EXCLUDED.rpc_access_ciphertext,
          issuance_active=EXCLUDED.issuance_active,retired_at=EXCLUDED.retired_at,retirement_ready_at=EXCLUDED.retirement_ready_at
        WHERE (gate.splitter_deployments.chain_id,gate.splitter_deployments.splitter,gate.splitter_deployments.signer,
          gate.splitter_deployments.token,gate.splitter_deployments.gavel_recipient,gate.splitter_deployments.deployment_block,gate.splitter_deployments.contract_code_hash)
          = (EXCLUDED.chain_id,EXCLUDED.splitter,EXCLUDED.signer,EXCLUDED.token,EXCLUDED.gavel_recipient,EXCLUDED.deployment_block,EXCLUDED.contract_code_hash)
          AND gate.splitter_deployments.config->>'environment' IS NOT DISTINCT FROM EXCLUDED.config->>'environment'
          AND gate.splitter_deployments.config->'testTokenLabel' IS NOT DISTINCT FROM EXCLUDED.config->'testTokenLabel'
        RETURNING id,chain_id::text AS "chainId",splitter,signer,token,deployment_block::text AS "deploymentBlock",
          scanner_cursor::text AS "nextBlock",contract_code_hash AS "contractCodeHash",gavel_recipient AS "gavelRecipient",config,rpc_access_ciphertext AS "rpcAccess",
          issuance_active AS "issuanceActive",retired_at AS "retiredAt",retirement_ready_at AS "retirementReadyAt"`,
      [deployment.id, chainId, splitter, signer, token, gavelRecipient, block, block, codeHash, JSON.stringify(config),
        typeof deployment.rpcAccess === "string" ? deployment.rpcAccess : JSON.stringify(deployment.rpcAccess || {}),
        deployment.issuanceActive === true, deployment.retiredAt ?? null, deployment.retirementReadyAt ?? null])).rows[0];
      invariant(row, "immutable deployment identity mismatch");
      await client.query(`INSERT INTO gate.settlement_cursors(deployment_id,chain_id,splitter,deployment_block,next_range_from)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(deployment_id) DO NOTHING`, [deployment.id, chainId, splitter, block, block]);
      return clone(row);
    });
  }

  async getDeployment({ chainId, splitter } = {}) {
    const row = (await this.pool.query(`SELECT id,chain_id::text AS "chainId",splitter,signer,token,
      gavel_recipient AS "gavelRecipient",deployment_block::text AS "deploymentBlock",
      contract_code_hash AS "contractCodeHash",config,issuance_active AS "issuanceActive",
      retired_at AS "retiredAt",retirement_ready_at AS "retirementReadyAt"
      FROM gate.splitter_deployments WHERE chain_id=$1 AND splitter=$2`,
    [positiveBigint(chainId, "chainId"), address(splitter, "splitter")])).rows[0];
    return row ? clone(row) : null;
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
        parentHash: bytes32(block.parentHash, "canonicalBlocks.parentHash"),
        blockTimestamp: exactDate(block.blockTimestamp, "canonicalBlocks.blockTimestamp").toISOString(),
      };
    });
    invariant(BigInt(canonicalBlocks.length) === BigInt(throughBlock) - BigInt(fromBlock) + 1n,
      "canonicalBlocks must cover every block in the scanner range");
    for (let index = 1; index < canonicalBlocks.length; index += 1) {
      invariant(canonicalBlocks[index].parentHash === canonicalBlocks[index - 1].blockHash,
        "canonical block parent ancestry is inconsistent");
    }
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
        details: clone(observation.details || {}),
      };
      if (normalized.kind === "exact_log" && normalized.details?.settlement) {
        normalized.details.settlement.settledAt = exactDate(
          normalized.details.settlement.receiptBlockTimestamp,
          "settlement.receiptBlockTimestamp",
        ).toISOString();
      }
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
      await client.query("SELECT id FROM gate.settlement_cursors WHERE deployment_id=$1 FOR UPDATE", [range.deploymentId]);
      const prereads = (await client.query("SELECT * FROM gate.scanner_range_prereads($1,$2,$3)",
        [range.deploymentId, fromBlock, throughBlock])).rows;
      const priorAnomalies = new Set(prereads.filter((item) => item.readKind === "anomaly")
        .map((item) => `${item.txHash}:${item.logIndex}:${item.code}`));
      const priorExact = new Set(prereads.filter((item) => item.readKind === "current_exact")
        .map((item) => `${item.quoteId}:${item.txHash}:${item.logIndex}`));
      const previouslyReorgedExact = new Set(prereads.filter((item) => item.readKind === "reorged_exact")
        .map((item) => `${item.quoteId}:${item.txHash}:${item.logIndex}`));
      const alreadyReorged = new Set((await client.query(`SELECT id FROM gate.quotes WHERE deployment_id=$1
        AND state='settled' AND settlement_reorged_at IS NOT NULL AND receipt_block BETWEEN $2 AND $3`,
      [range.deploymentId, fromBlock, throughBlock])).rows.map((item) => item.id));
      const row = (await client.query("SELECT gate.record_scanner_range($1,$2,$3,$4,$5,$6::jsonb) AS released",
        [range.deploymentId, fromBlock, throughBlock, canonicalBlockHash, canonicalBlockTimestamp, JSON.stringify(result)])).rows[0];
      const reorgedRows = (await client.query(`SELECT m.quote_id FROM gate.settlement_reorg_monitors m
        JOIN gate.quotes q ON q.id=m.quote_id WHERE q.deployment_id=$2
          AND m.reconciliation_metadata#>>'{trailingOverlapReorg,generation}'=$1`, [generation, range.deploymentId])).rows;
      const anomalyKeys = observations.filter((item) => item.kind === "anomaly")
        .map((item) => `${item.txHash}:${item.logIndex}:${item.details?.code}`);
      const currentExact = new Set(observations.filter((item) => item.kind === "exact_log")
        .map((item) => `${item.quoteId}:${item.txHash}:${item.logIndex}`));
      const reorged = reorgedRows.filter((item) => !alreadyReorged.has(item.quote_id)).length;
      const unknownQuotes = anomalyKeys.filter((key) => key.endsWith(":UNKNOWN_QUOTE") && !priorAnomalies.has(key)).length;
      const mismatches = anomalyKeys.filter((key) => !key.endsWith(":UNKNOWN_QUOTE") && !priorAnomalies.has(key)).length;
      const preAcceptanceReorged = [...priorExact]
        .filter((key) => !currentExact.has(key) && !previouslyReorgedExact.has(key)).length;
      return { released: Number(row?.released || 0), reorged,
        ...(unknownQuotes ? { unknownQuotes } : {}), ...(mismatches ? { mismatches } : {}),
        ...(preAcceptanceReorged ? { preAcceptanceReorged } : {}) };
    });
  }

  #validateIssuance({ context, snapshot, submission, quote, reservation, signer }) {
    invariant(snapshot && submission && quote && reservation, "complete issuance material is required");
    invariant(context?.authPassed === true && context?.parsePassed === true, "authenticated and parsed issuance context is required");
    assertStoreOwnedQuoteMaterial(quote, reservation);
    const candidate = snapshot.kind === "candidate";
    const proposalId = candidate ? null : uint78(snapshot.proposalId, "proposalId");
    const targetId = candidate ? snapshot.targetId : `proposal:${proposalId}`;
    invariant(typeof targetId === "string" && (candidate
      ? /^candidate:0x[0-9a-f]{40}:0x[0-9a-f]{64}$/.test(targetId)
      : /^proposal:(0|[1-9][0-9]*)$/.test(targetId)), "invalid target identity");
    const normalized = {
      context: {
        expectedProfileVersion: positiveBigint(context.expectedProfileVersion, "expectedProfileVersion"),
        walletKind: context.walletKind,
        authenticatedSender: address(context.authenticatedSender, "authenticatedSender"),
        payerIsEoa: context.payerIsEoa === true,
        stage: lifecycle(context.stage, "stage"), deploymentCodeHash: bytes32(context.deploymentCodeHash, "deploymentCodeHash"),
      },
      snapshot: { ...snapshot, dao: daoSlug(snapshot.dao), targetId, kind: candidate ? "candidate" : "proposal",
        ...(candidate ? {} : { proposalId }),
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
      signer,
    };
    invariant(normalized.submission.payer === normalized.submission.signedSender, "payer must equal signed_sender");
    invariant(normalized.submission.payer === normalized.context.authenticatedSender, "payer must equal authenticated signed sender");
    invariant(normalized.context.payerIsEoa, "payer must be an EOA");
    requireCanonicalIssuanceMaterial(normalized.snapshot, normalized.context, normalized.submission);
    requireCanonicalActions(normalized.snapshot.canonicalActions);
    if (!signer || typeof signer.signQuote !== "function") {
      throw new TypeError("an injected quote signer is required for issuance");
    }
    return normalized;
  }

  #validateFreshIssuance(normalized) {
    invariant(normalized.quote.payer === normalized.submission.payer, "quote payer must equal submission payer");
    invariant(normalized.quote.feeAmount === "250000", "feeAmount must equal 250000");
    invariant(normalized.quote.quoteVersion === 1, "quoteVersion must equal 1");
    invariant(SETTLEMENT_CHAINS.has(normalized.quote.baseChainId), "quote settlement chain must be Base 8453 or Base Sepolia 84532");
    const candidate = normalized.snapshot.kind === "candidate";
    const expectedMappingVersion = candidate ? NOUNS_CANDIDATE_MAPPING_VERSION : NOUNS_LIFECYCLE_MAPPING_VERSION;
    invariant(normalized.snapshot.mappingVersion === expectedMappingVersion,
      `mappingVersion must equal ${expectedMappingVersion}`);
    invariant(normalized.snapshot.dao !== "nouns" || (normalized.snapshot.nativeState === "ACTIVE"
      && normalized.context.stage === (candidate ? "PRE_VOTE" : "VOTING")
      && normalized.snapshot.eligibility === normalized.context.stage),
    "Nouns issuance requires canonical ACTIVE to PRE_VOTE/VOTING lifecycle mapping");
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
    const { context, snapshot, submission, quote, reservation, signer } = value;
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
      const locked = (await client.query("SELECT * FROM gate.lock_issuance_profile_policy($1,$2)",
        [submission.profileId, snapshot.dao])).rows[0];
      invariant(locked, "issuance unavailable");
      invariant(locked.wallet === quote.voter, "issuance unavailable");
      invariant(locked.availability === "accepting_now", "issuance unavailable");
      invariant(String(locked.profileVersion) === context.expectedProfileVersion, "issuance context changed");
      invariant(locked.walletKind === context.walletKind, "issuance context changed");
      invariant(locked.enabled === true && String(locked.chainId) === "1", "issuance unavailable");
      invariant(String(locked.attentionAmount) === quote.attentionAmount, "issuance context changed");
      invariant(context.stage === "PRE_VOTE" ? locked.acceptPreVote : context.stage === "VOTING" && locked.acceptVoting,
        "issuance unavailable for selected Nouns stage");
      const deployment = (await client.query("SELECT * FROM gate.splitter_deployments WHERE id=$1 FOR SHARE", [quote.deploymentId])).rows[0];
      invariant(deployment?.issuance_active === true && String(deployment.chain_id) === quote.baseChainId && deployment.splitter === quote.splitter
        && deployment.token === quote.token && deployment.contract_code_hash === context.deploymentCodeHash, "issuance context changed");
      invariant(explicitDeploymentEnvironment(deployment), "deployment environment is not valid for its chain and token");
      if (locked.walletKind === "contract") {
        invariant(typeof this.baseCodeReader === "function", "Base code reader unavailable");
        let timer;
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Base code read timed out")), this.rpcTimeoutMs); });
        let code;
        try { code = await Promise.race([this.baseCodeReader({ wallet: locked.wallet, chainId: quote.baseChainId }), timeout]); }
        finally { clearTimeout(timer); }
        invariant(typeof code === "string" && /^0x[0-9a-fA-F]+$/.test(code) && code !== "0x", "current Base payout code unavailable");
        invariant(locked.basePayoutCodeHash && keccak256(code).toLowerCase() === locked.basePayoutCodeHash, "current Base payout code changed");
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
            AND s2.payer=$2 AND q2.voter=$3 AND ps.target_id=$4 AND ps.dao=$5) AS pair_proposal,
        (SELECT count(*)::int FROM gate.quotes q2 JOIN gate.submissions s2 ON s2.id=q2.submission_id
          WHERE s2.profile_id=$1 AND q2.state='quoted' AND q2.expires_at>clock_timestamp() AND s2.payer=$2 AND q2.voter=$3) AS active_pair`,
      [submission.profileId, submission.payer, quote.voter, snapshot.targetId, snapshot.dao])).rows[0];
      // These two are separate frozen rejection codes, not capacity: the HTTP
      // layer maps them to coarse ACTIVE_QUOTE_EXISTS / SENDER_PROPOSAL_LIMIT.
      invariant(Number(limits.active_pair) === 0, "ACTIVE_QUOTE_EXISTS");
      invariant(Number(limits.pair_proposal) < 2, "SENDER_PROPOSAL_LIMIT");
      invariant(Number(limits.pending_count) < Number(locked.pendingReservationCapacity)
        && Number(limits.settled_count) < Number(locked.settledCapacity), "issuance capacity unavailable");

      await client.query("SAVEPOINT gate_issue_material");
      try {
        await client.query(`INSERT INTO gate.proposal_snapshots
          (id,dao,target_id,kind,proposal_id,content_hash,native_state,normalized_eligibility,mapping_version,source_block,source_block_hash,refreshed_at,canonical_facts,decoded_facts,canonical_actions)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb)`,
        [snapshot.id, snapshot.dao, snapshot.targetId, snapshot.kind, snapshot.proposalId ?? null,
          snapshot.contentHash, snapshot.nativeState, snapshot.eligibility, snapshot.mappingVersion,
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
        // One signing site, inside this transaction, before the quote row
        // exists: a signer failure can never strand a committed reservation.
        assertSignerDeploymentBinding(signer, { chainId: quote.baseChainId, splitter: quote.splitter });
        const signed = await signIssuedQuote(signer, buildIssuedQuoteMessage({
          quoteId: quote.quoteId, payer: quote.payer, voter: quote.voter, attentionAmount: quote.attentionAmount,
          feeAmount: quote.feeAmount, submissionHash: submission.submissionHash, token: quote.token,
          expiresAt: quote.expiresAt,
        }));
        await client.query(`INSERT INTO gate.quotes(id,quote_id,submission_id,payer,voter,attention_amount,fee_amount,token,base_chain_id,splitter,deployment_id,quote_version,expires_at,quote_signature)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [quote.id, quote.quoteId, submission.id, quote.payer, quote.voter,
          quote.attentionAmount, quote.feeAmount, quote.token, quote.baseChainId, quote.splitter, quote.deploymentId, quote.quoteVersion,
          quote.expiresAt, signed.signature]);
        await client.query("INSERT INTO gate.capacity_reservations(id,profile_id,quote_id,amount,expires_at) VALUES($1,$2,$3,$4,$5)",
          [reservation.id, submission.profileId, quote.id, reservation.amount, reservation.expiresAt]);
        await client.query("RELEASE SAVEPOINT gate_issue_material");
        return { resumed: false, publicId, submission: { id: submission.id, publicId, status: "QUOTED" },
          quote: { ...clone({ ...quote, state: "quoted", reservationState: "reserved" }), ...issuedQuotePayload(signed) } };
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

  // Owner-bound global exact-hash lookup, run before every mutable check.
  async getOwnedSubmissionByHash({ submissionHash, payer } = {}) {
    const hash = bytes32(submissionHash, "submissionHash");
    const owner = address(payer, "payer");
    const row = (await this.pool.query(`SELECT public_id AS "publicId",status,payer
      FROM gate.submissions WHERE submission_hash=$1`, [hash])).rows[0];
    if (!row) return null;
    invariant(row.payer === owner, "submission is unavailable");
    return { publicId: row.publicId, state: publicState(row.status) };
  }

  // Private owner-bound resume: a single read that never refreshes a quote,
  // extends an expiry, or touches a reservation.
  async getOwnedResume({ publicId, payer } = {}) {
    const owner = address(payer, "payer");
    const row = (await this.pool.query(`SELECT s.public_id AS "publicId",s.status,s.payer,s.submission_hash AS "submissionHash",
      s.public_state_changed_at AS "updatedAt",i.inbox_created_at AS "inboxCreatedAt",
      q.quote_id AS "quoteId",q.voter,q.attention_amount::text AS "attentionAmount",q.fee_amount::text AS "feeAmount",
      q.token,q.base_chain_id::text AS "baseChainId",q.splitter,q.expires_at AS "expiresAt",
      q.quote_signature AS "signature",q.state AS "quoteState",clock_timestamp() AS now
      FROM gate.submissions s LEFT JOIN gate.quotes q ON q.submission_id=s.id
      LEFT JOIN gate.inbox_items i ON i.submission_id=s.id WHERE s.public_id=$1`, [publicId])).rows[0];
    if (!row || row.payer !== owner) return null;
    const projection = publicSubmissionProjection(
      { publicId: row.publicId, status: row.status, publicStateChangedAt: row.updatedAt },
      row.inboxCreatedAt == null ? null : { inboxCreatedAt: row.inboxCreatedAt },
    );
    if (row.status !== "QUOTED" || !row.signature) return projection;
    const expiresAt = exactDate(row.expiresAt, "quote expiry");
    if (row.quoteState !== "quoted" || expiresAt <= exactDate(row.now, "database clock")) {
      return { publicId: row.publicId, state: "expired", updatedAt: clone(row.updatedAt) };
    }
    return {
      ...projection,
      quote: issuedQuotePayload({
        domain: { chainId: row.baseChainId, verifyingContract: row.splitter },
        message: buildIssuedQuoteMessage({
          quoteId: row.quoteId, payer: row.payer, voter: row.voter, attentionAmount: row.attentionAmount,
          feeAmount: row.feeAmount, submissionHash: row.submissionHash, token: row.token, expiresAt,
        }),
        signature: row.signature,
      }),
    };
  }

  async countLiabilities(profileId) {
    const row = (await this.pool.query("SELECT count(*)::text AS total FROM gate.capacity_reservations WHERE profile_id=$1 AND state IN('active','expiry_pending_reconciliation')", [profileId])).rows[0];
    return BigInt(row.total);
  }

  async getScannerState({ chainId, splitter } = {}) {
    const row = (await this.pool.query(`SELECT c.deployment_id AS "deploymentId",c.deployment_block::text AS "deploymentBlock",
      c.next_range_from::text AS "nextRangeFrom",c.scan_generation::text AS generation,(d.config->>'overlap')::integer AS overlap
      FROM gate.settlement_cursors c JOIN gate.splitter_deployments d ON d.id=c.deployment_id
      WHERE c.chain_id=$1 AND c.splitter=$2`,
    [positiveBigint(chainId, "chainId"), address(splitter, "splitter")])).rows[0];
    return row ? clone(row) : null;
  }

  async claimSettlementLifecycle({ quoteId, staleAfterMs = 15_000 } = {}) {
    const publicQuoteId = bytes32(quoteId, "quoteId");
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1 || staleAfterMs > 60_000) {
      throw new TypeError("staleAfterMs must be from 1 to 60000");
    }
    const row = (await this.pool.query(`WITH claimed AS (
      UPDATE gate.quotes SET lifecycle_recheck_attempted_at=clock_timestamp()
      WHERE quote_id=$1 AND state<>'settled' AND lifecycle_recheck_attempted_at IS NULL
      RETURNING true AS attempt,false AS pending,NULL::jsonb AS lifecycle
    ), existing AS (
      SELECT false AS attempt,
        lifecycle_recheck IS NULL AND lifecycle_recheck_attempted_at>clock_timestamp()-make_interval(secs => $2 / 1000.0) AS pending,
        lifecycle_recheck AS lifecycle FROM gate.quotes
      WHERE quote_id=$1 AND state<>'settled' AND NOT EXISTS(SELECT 1 FROM claimed)
    ) SELECT * FROM claimed UNION ALL SELECT * FROM existing`, [publicQuoteId, staleAfterMs])).rows[0];
    return row ? clone(row) : null;
  }

  async recordSettlementLifecycle({ quoteId, lifecycle } = {}) {
    const publicQuoteId = bytes32(quoteId, "quoteId");
    if (!lifecycle || typeof lifecycle !== "object" || Array.isArray(lifecycle)) throw new TypeError("lifecycle is required");
    const row = await this.pool.query(`UPDATE gate.quotes SET lifecycle_recheck=$2::jsonb
      WHERE quote_id=$1 AND state<>'settled' AND lifecycle_recheck_attempted_at IS NOT NULL AND lifecycle_recheck IS NULL`,
    [publicQuoteId, JSON.stringify(lifecycle)]);
    return row.rowCount === 1;
  }

  async listUnsettledSettlementObservations({ chainId, splitter, limit = 50 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("limit must be from 1 to 1000");
    return clone((await this.pool.query(`SELECT "quoteId",settlement
      FROM gate.unsettled_settlement_observations($1,$2,$3)`,
    [positiveBigint(chainId, "chainId"), address(splitter, "splitter"), limit])).rows);
  }

  async findSettlementQuote(quoteId) {
    const row = (await this.pool.query(`SELECT q.quote_id AS "quoteId",q.payer,q.voter,q.attention_amount::text AS "attentionAmount",
      q.fee_amount::text AS "feeAmount",d.gavel_recipient AS "gavelRecipient",q.token,s.submission_hash AS "submissionHash",
      q.quote_version AS "quoteVersion",q.base_chain_id::text AS "baseChainId",q.splitter,q.expires_at AS "expiresAt",
      ps.normalized_eligibility AS "issuanceLifecycle",ps.dao,
      CASE WHEN ps.kind='candidate' THEN ps.target_id END AS "targetId",
      CASE WHEN ps.kind='candidate' THEN ps.kind END AS kind,
      ps.proposal_id::text AS "proposalId",
      s.profile_id AS "profileId",ds.ciphertext AS "destinationRef",
      CASE WHEN ps.kind='candidate'
        THEN jsonb_build_object('subject','Candidate sponsorship pitch ready','text','Open your private Gate inbox to review the candidate sponsorship request.')
        ELSE jsonb_build_object('subject','Paid pitch ready','text','Open your private Gate inbox.') END AS "trustedSummary"
      FROM gate.quotes q JOIN gate.submissions s ON s.id=q.submission_id
      JOIN gate.proposal_snapshots ps ON ps.id=s.issuance_snapshot_id
      JOIN gate.splitter_deployments d ON d.id=q.deployment_id
      LEFT JOIN gate.delivery_settings ds ON ds.profile_id=s.profile_id WHERE q.quote_id=$1`,
    [bytes32(quoteId, "quoteId")])).rows[0];
    if (!row) return null;
    if (row.targetId == null) delete row.targetId;
    if (row.kind == null) delete row.kind;
    if (row.proposalId == null) delete row.proposalId;
    return clone(row);
  }

  async recordSettlementHint({ publicId, payer, txHash, chainId, splitter } = {}) {
    const owner = address(payer, "payer");
    const transactionHash = bytes32(txHash, "txHash");
    const settlementChain = positiveBigint(chainId, "chainId");
    const settlementSplitter = address(splitter, "splitter");
    return this.#transaction(async (client) => {
      const row = (await client.query(`SELECT s.id,s.public_id AS "publicId",s.status,s.payer,s.public_state_changed_at AS "updatedAt",
        s.pending_settlement_tx_hash AS "pendingTxHash",q.id AS "quoteInternalId",q.state::text AS quote_state,q.expires_at>clock_timestamp() AS unexpired,
        q.base_chain_id::text AS "baseChainId",q.splitter FROM gate.submissions s JOIN gate.quotes q ON q.submission_id=s.id
        WHERE s.public_id=$1 FOR UPDATE OF s,q`, [publicId])).rows[0];
      if (!row || row.payer !== owner) return null;
      if (row.quote_state === "expired" || row.unexpired === false) {
        if (row.quote_state !== "expired") {
          await client.query("UPDATE gate.quotes SET state='expired' WHERE id=$1", [row.quoteInternalId]);
          await client.query(`UPDATE gate.capacity_reservations SET state='expiry_pending_reconciliation',updated_at=clock_timestamp()
            WHERE quote_id=$1 AND state='active'`, [row.quoteInternalId]);
        }
        if (row.status !== "EXPIRED") {
          row.updatedAt = (await client.query(`UPDATE gate.submissions SET status='EXPIRED',public_state_changed_at=clock_timestamp()
            WHERE id=$1 RETURNING public_state_changed_at AS "updatedAt"`, [row.id])).rows[0].updatedAt;
        }
        return { publicId: row.publicId, state: "expired", updatedAt: clone(row.updatedAt) };
      }
      invariant(row.quote_state === "quoted" && row.unexpired === true && row.baseChainId === settlementChain
        && row.splitter === settlementSplitter, "settlement hint can be recorded only for a valid payable quote");
      if (row.pendingTxHash && row.pendingTxHash !== transactionHash) throw new Error("conflicting settlement transaction hash");
      if (row.status === "SETTLEMENT_PENDING") return { publicId: row.publicId, state: "pending_settlement", updatedAt: clone(row.updatedAt) };
      invariant(row.status === "QUOTED", "settlement hint can be recorded only for a valid payable quote");
      const changed = (await client.query(`UPDATE gate.submissions SET status='SETTLEMENT_PENDING',pending_settlement_tx_hash=$2,
        public_state_changed_at=clock_timestamp() WHERE id=$1 RETURNING public_state_changed_at AS "updatedAt"`,
      [row.id, transactionHash])).rows[0];
      const receipt = { publicId: row.publicId, state: "pending_settlement", updatedAt: clone(changed.updatedAt) };
      Object.defineProperty(receipt, "newlyPending", { value: true });
      return receipt;
    });
  }

  async listPendingSettlementHints({ limit = 50 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("limit must be from 1 to 1000");
    return clone((await this.pool.query(`SELECT s.public_id AS "publicId",q.quote_id AS "quoteId",
      s.pending_settlement_tx_hash AS "txHash",q.expires_at AS "expiresAt"
      FROM gate.submissions s JOIN gate.quotes q ON q.submission_id=s.id
      WHERE s.status='SETTLEMENT_PENDING' AND s.pending_settlement_tx_hash IS NOT NULL ORDER BY s.public_state_changed_at LIMIT $1`, [limit])).rows);
  }

  async resolveSettlementHint({ publicId, txHash, state } = {}) {
    const transactionHash = bytes32(txHash, "txHash");
    if (!["payment_required", "expired"].includes(state)) throw new TypeError("invalid settlement hint state");
    return this.#transaction(async (client) => {
      const row = (await client.query(`SELECT s.id,q.id AS quote_id FROM gate.submissions s JOIN gate.quotes q ON q.submission_id=s.id
        WHERE s.public_id=$1 AND s.status='SETTLEMENT_PENDING' AND s.pending_settlement_tx_hash=$2 FOR UPDATE OF s,q`,
      [publicId, transactionHash])).rows[0];
      if (!row) return false;
      if (state === "expired") {
        await client.query("UPDATE gate.quotes SET state='expired' WHERE id=$1 AND state='quoted'", [row.quote_id]);
        await client.query(`UPDATE gate.capacity_reservations SET state='expiry_pending_reconciliation',updated_at=clock_timestamp()
          WHERE quote_id=$1 AND state='active'`, [row.quote_id]);
      }
      const status = state === "expired" ? "EXPIRED" : "QUOTED";
      await client.query(`UPDATE gate.submissions SET status=$2,pending_settlement_tx_hash=NULL,
        public_state_changed_at=clock_timestamp() WHERE id=$1`, [row.id, status]);
      return true;
    });
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
      scannerVerified: evidence.scannerVerified === true, oneConfirmation: evidence.oneConfirmation === true,
      confirmations: Number(positiveBigint(evidence.confirmations, "evidence.confirmations")),
    };
  }

  async settle({ quoteId, settlement, inbox, notification, monitor }) {
    const publicQuoteId = bytes32(quoteId, "quoteId");
    const e = this.#settlementEvidence(settlement);
    invariant(Number.isInteger(e.logIndex) && e.logIndex >= 0 && e.canonical && e.scannerVerified && e.oneConfirmation
        && e.confirmations === 1,
      "canonical one-confirmation scanner evidence is required");
    invariant(e.quoteId === publicQuoteId, "settlement quoteId does not match public quote");

    if (!inbox?.id || typeof inbox.lifecycleChanged !== "boolean" || typeof inbox.currentLifecycleUnavailable !== "boolean") {
      throw new TypeError("inbox lifecycle flags must be boolean");
    }
    lifecycle(inbox.issuanceLifecycle, "issuanceLifecycle"); lifecycle(inbox.currentLifecycle, "currentLifecycle");
    invariant(inbox.issuanceLifecycle === "PRE_VOTE" || inbox.issuanceLifecycle === "VOTING",
      "inbox issuance lifecycle must be PRE_VOTE or VOTING");
    invariant(CURRENT_LIFECYCLES.has(inbox.currentLifecycle),
      "current lifecycle must be PRE_VOTE, VOTING, CLOSED, or UNKNOWN");
    invariant(inbox.currentLifecycle === "CLOSED" || inbox.currentLifecycle === "UNKNOWN"
      || inbox.currentLifecycle === inbox.issuanceLifecycle,
    "current lifecycle must remain in the issuance lane or close");
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
          && sameTimestamp(quote.receipt_block_timestamp, e.receiptBlockTimestamp)
          && quote.settlement_proof_canonical === true && quote.settlement_scanner_verified === true
          && quote.settlement_event_quote_id === e.quoteId;
        invariant(evidenceMatches, "conflicting settlement evidence");
        const related = (await client.query(`SELECT i.id AS inbox_id,n.id AS notification_id,m.id AS monitor_id
          FROM gate.inbox_items i LEFT JOIN gate.notification_attempts n ON n.inbox_id=i.id
          JOIN gate.settlement_reorg_monitors m ON m.quote_id=$2 WHERE i.submission_id=$1`,
        [quote.submission_internal_id, quote.id])).rows[0];
        invariant(related && related.inbox_id === inbox.id
          && (related.notification_id == null || notification == null || related.notification_id === notification.id)
          && related.monitor_id === monitor.id, "conflicting settlement side effects");
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
      await client.query("UPDATE gate.submissions SET status='SETTLED',pending_settlement_tx_hash=NULL,public_state_changed_at=clock_timestamp() WHERE id=$1", [quote.submission_internal_id]);
      const accepted = (await client.query(`INSERT INTO gate.inbox_items
        (id,submission_id,profile_id,issuance_lifecycle,current_lifecycle,lifecycle_changed,current_lifecycle_unavailable,private_unavailability_reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING inbox_created_at AS "inboxCreatedAt"`, [inbox.id, quote.submission_internal_id,
        quote.profile_id, inbox.issuanceLifecycle, inbox.currentLifecycle, inbox.lifecycleChanged === true,
        inbox.currentLifecycleUnavailable === true, inbox.privateUnavailabilityReason ?? null])).rows[0];
      if (notification) {
        await client.query("SAVEPOINT optional_notification");
        try {
          await client.query(`INSERT INTO gate.notification_attempts
            (id,inbox_id,channel,destination_ref_ciphertext,trusted_summary,state,next_attempt_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,clock_timestamp())`,
          [notification.id, inbox.id, notification.channel, notification.destinationRef,
            JSON.stringify(notification.summary ?? { subject: "Paid pitch ready", text: "Open your private Gate inbox." }), notification.status]);
          await client.query("RELEASE SAVEPOINT optional_notification");
        } catch {
          await client.query("ROLLBACK TO SAVEPOINT optional_notification");
          await client.query("RELEASE SAVEPOINT optional_notification");
        }
      }
      await client.query(`INSERT INTO gate.settlement_reorg_monitors(id,chain_id,splitter,quote_id,receipt_block,receipt_block_hash,tx_hash,log_index,next_check_block)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(chain_id,splitter,quote_id) DO NOTHING`,
      [monitor.id, e.sourceChainId, e.splitter, quote.id, e.receiptBlock, e.receiptBlockHash, e.txHash, e.logIndex, nextCheckBlock]);
      return { settled: true, inboxCreatedAt: accepted.inboxCreatedAt };
    });
  }

  async getReservationCapacityStats({ chainId, splitter } = {}) {
    const settlementChain = positiveBigint(chainId, "chainId");
    const settlementSplitter = address(splitter, "splitter");
    const row = (await this.pool.query(`SELECT
      count(*) FILTER (WHERE r.state='active')::int AS active,
      count(*) FILTER (WHERE r.state='expiry_pending_reconciliation')::int AS "expiryPending",
      count(*) FILTER (WHERE r.state='released')::int AS "releasedRows",
      count(*) FILTER (WHERE r.state='consumed')::int AS "consumedRows",
      COALESCE(EXTRACT(epoch FROM (clock_timestamp()-min(r.created_at)
        FILTER (WHERE r.state IN('active','expiry_pending_reconciliation')))),0)::float8 AS "oldestPendingAgeSeconds"
      FROM gate.capacity_reservations r
      JOIN gate.quotes q ON q.id=r.quote_id
      JOIN gate.splitter_deployments d ON d.id=q.deployment_id
      WHERE d.chain_id=$1 AND d.splitter=$2`, [settlementChain, settlementSplitter])).rows[0];
    return {
      active: Number(row?.active || 0),
      expiryPending: Number(row?.expiryPending || 0),
      releasedRows: Number(row?.releasedRows || 0),
      consumedRows: Number(row?.consumedRows || 0),
      oldestPendingAgeSeconds: Number(row?.oldestPendingAgeSeconds || 0),
    };
  }

  async getSettlementMonitorStats({ chainId, splitter, headBlock } = {}) {
    const settlementChain = positiveBigint(chainId, "chainId");
    const settlementSplitter = address(splitter, "splitter");
    const head = uint78(headBlock, "headBlock");
    const row = (await this.pool.query(`SELECT count(*)::int AS "queueDepth",
      COALESCE(EXTRACT(epoch FROM (clock_timestamp()-min(created_at))),0)::float8 AS "oldestAgeSeconds",
      COALESCE(max(GREATEST($3::bigint-COALESCE(progress_block,receipt_block),0)),0)::float8 AS "progressLag"
      FROM gate.settlement_reorg_monitors WHERE chain_id=$1 AND splitter=$2 AND completed_at IS NULL`,
    [settlementChain, settlementSplitter, head])).rows[0];
    return { queueDepth: Number(row?.queueDepth || 0), oldestAgeSeconds: Number(row?.oldestAgeSeconds || 0),
      progressLag: Number(row?.progressLag || 0) };
  }

  async claimSettlementMonitors({ chainId, splitter, headBlock, limit = 50, leaseMs = 5 * 60_000 } = {}) {
    const settlementChain = positiveBigint(chainId, "chainId");
    const settlementSplitter = address(splitter, "splitter");
    const head = uint78(headBlock, "headBlock");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("limit must be from 1 to 1000");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000) throw new TypeError("leaseMs must be from 1 to 3600000");
    const rows = (await this.pool.query(`WITH candidates AS (
        SELECT id,quote_id FROM gate.settlement_reorg_monitors WHERE chain_id=$1 AND splitter=$2 AND completed_at IS NULL
          AND next_check_block<=$3 AND (claimed_until IS NULL OR claimed_until<=clock_timestamp())
          ORDER BY next_check_block,id LIMIT $4 FOR UPDATE SKIP LOCKED)
      UPDATE gate.settlement_reorg_monitors m SET claimed_until=clock_timestamp()+make_interval(secs => $5 / 1000.0),claim_generation=claim_generation+1
      FROM candidates c JOIN gate.quotes q ON q.id=c.quote_id WHERE m.id=c.id RETURNING m.id,q.quote_id AS "quoteId",m.receipt_block::text AS "receiptBlock",
        m.receipt_block_hash AS "receiptBlockHash",m.tx_hash AS "txHash",m.log_index AS "logIndex",
        m.progress_block::text AS "progressBlock",m.reconciliation_metadata AS "reconciliationMetadata",m.claim_generation::text AS "claimToken"`,
    [settlementChain, settlementSplitter, head, limit, leaseMs])).rows;
    return clone(rows);
  }

  async advanceSettlementMonitor({ id, claimToken, progressBlock, nextCheckBlock, completed, reorged } = {}) {
    if (!id || typeof claimToken !== "string" || !/^[1-9][0-9]*$/.test(claimToken)
        || typeof completed !== "boolean" || typeof reorged !== "boolean") throw new TypeError("invalid monitor advancement");
    const progress = uint78(progressBlock, "progressBlock");
    const next = completed ? null : uint78(nextCheckBlock, "nextCheckBlock");
    if (!completed && BigInt(next) <= BigInt(progress)) throw new Error("nextCheckBlock must advance beyond progressBlock");
    return this.#transaction(async (client) => {
      const row = (await client.query(`UPDATE gate.settlement_reorg_monitors SET progress_block=$2,next_check_block=COALESCE($4,next_check_block),claimed_until=NULL,
        completed_at=CASE WHEN $5 THEN COALESCE(completed_at,clock_timestamp()) ELSE completed_at END,
        reconciliation_metadata=CASE WHEN $6 THEN reconciliation_metadata||jsonb_build_object('monitorReorged',true) ELSE reconciliation_metadata END
        WHERE id=$1 AND claim_generation=$3::bigint AND claimed_until>clock_timestamp() RETURNING quote_id`,
      [id, progress, claimToken, next, completed, reorged])).rows[0];
      if (!row) return false;
      if (reorged) await client.query("UPDATE gate.quotes SET settlement_reorged_at=COALESCE(settlement_reorged_at,clock_timestamp()) WHERE id=$1", [row.quote_id]);
      return true;
    });
  }

  async claimNotificationAttempts({ limit = 20, leaseMs = 5 * 60_000 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("limit must be from 1 to 1000");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000) throw new TypeError("leaseMs must be from 1 to 3600000");
    const rows = (await this.pool.query(`SELECT id,"claimToken","retryCount","firstAttemptAt","dedupeDeadline","profileId","destinationRef",summary
      FROM gate.claim_notification_attempts($1,$2,$3)`,
    [limit, this.notificationRetryLimit, leaseMs])).rows;
    return clone(rows);
  }

  async completeNotification({ id, claimToken, providerOpaqueId = null } = {}) {
    if (!id || typeof claimToken !== "string" || !/^[1-9][0-9]*$/.test(claimToken)
        || (providerOpaqueId !== null && (typeof providerOpaqueId !== "string" || providerOpaqueId.length > 256))) {
      throw new TypeError("invalid notification completion");
    }
    const row = (await this.pool.query("SELECT gate.complete_notification_attempt($1,$2,$3) AS completed",
      [id, claimToken, providerOpaqueId])).rows[0];
    return Boolean(row?.completed);
  }

  async failNotification({ id, claimToken, errorCode, nextAttemptAt } = {}) {
    if (!id || typeof claimToken !== "string" || !/^[1-9][0-9]*$/.test(claimToken)
        || typeof errorCode !== "string" || !errorCode) throw new TypeError("notification id, claimToken, and errorCode are required");
    const row = (await this.pool.query("SELECT gate.fail_notification_attempt($1,$2,$3,$4) AS failed",
      [id, claimToken, errorCode, exactDate(nextAttemptAt, "nextAttemptAt")])).rows[0];
    return Boolean(row?.failed);
  }

  async reconcileNotification({ id, claimToken, errorCode } = {}) {
    if (!id || typeof claimToken !== "string" || !/^[1-9][0-9]*$/.test(claimToken)
        || typeof errorCode !== "string" || !errorCode) throw new TypeError("notification id, claimToken, and errorCode are required");
    const row = (await this.pool.query("SELECT gate.reconcile_notification_attempt($1,$2,$3) AS reconciled",
      [id, claimToken, errorCode])).rows[0];
    return Boolean(row?.reconciled);
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

  #inboxSelect() {
    return `SELECT i.id,i.archived_at AS "archivedAt",i.inbox_created_at AS "createdAt",
      i.issuance_lifecycle AS "issuanceLifecycle",i.current_lifecycle AS "currentLifecycle",
      i.lifecycle_changed AS "lifecycleChanged",s.material,
      ps.canonical_facts AS "canonicalFacts",ps.decoded_facts AS "decodedFacts",
      ps.canonical_actions AS "canonicalActions",ps.dao,ps.proposal_id AS "proposalId"
      FROM gate.inbox_items i
      JOIN gate.submissions s ON s.id=i.submission_id
      JOIN gate.proposal_snapshots ps ON ps.id=s.issuance_snapshot_id`;
  }

  async listInboxItems(profileId) {
    if (typeof profileId !== "string" || !profileId) throw new TypeError("profileId is required");
    return clone((await this.pool.query(`${this.#inboxSelect()}
      WHERE i.profile_id=$1 ORDER BY i.inbox_created_at DESC,i.id ASC`, [profileId])).rows);
  }

  async getInboxItem(profileId, id) {
    if (typeof profileId !== "string" || !profileId || typeof id !== "string" || !id) return null;
    const row = (await this.pool.query(`${this.#inboxSelect()} WHERE i.profile_id=$1 AND i.id=$2`,
      [profileId, id])).rows[0];
    return row ? clone(row) : null;
  }

  async archiveInboxItem(profileId, id) {
    if (typeof profileId !== "string" || !profileId || typeof id !== "string" || !id) return null;
    const updated = (await this.pool.query(`UPDATE gate.inbox_items
      SET archived_at=COALESCE(archived_at,clock_timestamp())
      WHERE profile_id=$1 AND id=$2 RETURNING id`, [profileId, id])).rows[0];
    if (!updated) return null;
    return this.getInboxItem(profileId, id);
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
      const row = (await queryable.query(`SELECT id,wallet,"walletKind",availability,ens,message,"enrolledAt","updatedAt"
        FROM gate.public_profile($1)`, [id])).rows[0];
      if (!row) return null;
      row.display = {
        ...(typeof row.ens === "string" ? { ens: row.ens } : {}),
        ...(typeof row.message === "string" ? { message: row.message } : {}),
      };
      delete row.ens; delete row.message;
      return row;
    },
    async getPolicy(profileId, dao) {
      return (await queryable.query(`SELECT "profileId",dao,"chainId",enabled,"acceptPreVote","acceptVoting","attentionAmount",tags
        FROM gate.public_dao_policy($1,$2)`, [profileId, daoSlug(dao)])).rows[0] || null;
    },
    async getSubmission(publicId) {
      const row = (await queryable.query(`SELECT public_id AS "publicId",state,
        updated_at AS "updatedAt",accepted_at AS "acceptedAt"
        FROM gate.public_submission_receipt($1)`, [publicId])).rows[0];
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
