/**
 * The Gavel configuration model.
 *
 * Eight independent concerns, each in its own branch, none of them DAO-shaped:
 *
 *   runtime        where private state lives, which index answers reads
 *   identity       who the user is in governance terms
 *   wallet         how they control a key, if at all
 *   execution      what Gavel is allowed to do with that key
 *   followedDaos   which governance systems they care about
 *   inference      where recommendations are computed
 *   privacy        how Gavel reaches the network
 *   notifications  what it tells them about
 *
 * `followedDaos` being a flat list of ids -- and *not* a per-DAO settings tree
 * -- is the point. Adding a DAO is appending a string. Everything DAO-specific
 * is answered by the adapter and the catalog, so onboarding does not have to be
 * redesigned when a fourth adapter lands.
 *
 * No branch holds a secret. `wallet.local.variable` names an environment
 * variable; `execution.safe.proposerIdentity` names a keystore label. The
 * values behind those names are read at the point of use and never stored,
 * logged or rendered -- see `config/secrets.js`.
 */

const { z } = require("zod");

const { ExecutionMode } = require("../schema/execution");
const { listDaoIds } = require("../dao/catalog");
const { WalletConnectionType } = require("../wallet/provider");

const CONFIG_SCHEMA_VERSION = "2.0.0";

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed address");
const daoIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

/** Where recommendations are computed. All three are real paths today. */
const InferenceMode = Object.freeze({
  /** Gavel's own precedent engine, in this process. No network, no provider. */
  LOCAL: "local",
  /** A configured remote scoring endpoint. */
  REMOTE: "remote",
  /** The host harness supplies inference (Claude Code, Hermes, Bankr, ...). */
  RUNTIME: "runtime",
});

/**
 * How Gavel reaches the network.
 *
 * Only `direct` is implemented. The others are declared so privacy is a
 * first-class configuration branch rather than something bolted onto DAO
 * settings later -- and rejected at validation until a transport exists, so
 * nothing silently claims to be anonymized when it is not.
 */
const NetworkMode = Object.freeze({
  DIRECT: "direct",
  TOR: "tor",
  NYM: "nym",
});

const IMPLEMENTED_NETWORK_MODES = Object.freeze([NetworkMode.DIRECT]);

const runtimeSchema = z.object({
  /** null means "resolve GAVEL_DATA_DIR at runtime", which is the default. */
  dataDir: z.string().min(1).nullable().default(null),
  /** Empty string is the explicit opt-out back to a per-DAO public source. */
  indexApiUrl: z.string().nullable().default(null),
});

const identitySchema = z.object({
  /** The address whose governance state Gavel reads. Not necessarily a signer. */
  address: addressSchema.nullable().default(null),
  label: z.string().max(120).nullable().default(null),
});

const walletSchema = z.object({
  type: z.enum(Object.values(WalletConnectionType)).default(WalletConnectionType.READ_ONLY),
  local: z
    .object({
      /** Preference order: an encrypted keystore, then a host-provided variable. */
      signer: z.enum(["keystore", "environment"]).default("keystore"),
      keystoreLabel: z.string().max(120).nullable().default(null),
      variable: z.string().regex(/^[A-Z][A-Z0-9_]*$/).nullable().default(null),
    })
    .nullable()
    .default(null),
  walletconnect: z
    .object({
      /** Only the reference. The project id itself stays in the environment. */
      projectIdVariable: z.string().regex(/^[A-Z][A-Z0-9_]*$/).nullable().default(null),
      /** Topic, account, chain, expiry. Never a relay or pairing key. */
      session: z
        .object({
          topic: z.string().min(1).nullable().default(null),
          account: addressSchema.nullable().default(null),
          chainId: z.number().int().positive().nullable().default(null),
          expiresAt: z.string().nullable().default(null),
        })
        .nullable()
        .default(null),
    })
    .nullable()
    .default(null),
});

/**
 * Execution roles, kept apart on purpose.
 *
 * A Safe address, a Safe proposer credential, an autonomous execution wallet
 * and a payout address are four different authorities. The old single `wallet`
 * field could mean any of them, which is exactly the confusion this branch
 * exists to end.
 */
const executionSchema = z.object({
  mode: z.enum(Object.values(ExecutionMode)).default(ExecutionMode.UNSIGNED),
  safe: z
    .object({
      address: addressSchema,
      chainId: z.number().int().positive().default(1),
      /** A keystore label, never a key. */
      proposerIdentity: z.string().max(120).nullable().default(null),
    })
    .nullable()
    .default(null),
  autonomous: z
    .object({
      executionAddress: addressSchema,
      policyId: z.string().max(120).nullable().default(null),
      /**
       * Autonomous execution is never on because a credential happens to
       * exist. This timestamp is the user's explicit, recorded consent, and
       * validation refuses the mode without it.
       */
      acknowledgedAt: z.string().datetime().nullable().default(null),
    })
    .nullable()
    .default(null),
  /** Where governance rewards or reimbursements should land. Not a signer. */
  payoutAddress: addressSchema.nullable().default(null),
});

const inferenceSchema = z.object({
  mode: z.enum(Object.values(InferenceMode)).default(InferenceMode.LOCAL),
  /** The environment variable naming a remote endpoint. Never the endpoint's credentials. */
  endpointVariable: z.string().regex(/^[A-Z][A-Z0-9_]*$/).nullable().default(null),
});

const privacySchema = z.object({
  network: z.enum(Object.values(NetworkMode)).default(NetworkMode.DIRECT),
});

const notificationsSchema = z.object({
  proposalAlerts: z.boolean().default(true),
  dailyBriefing: z.boolean().default(false),
  executionAlerts: z.boolean().default(true),
  /** Offered only when a followed DAO declares the calendar capability. */
  calendarReminders: z.boolean().default(false),
});

const onboardingSchema = z.object({
  completed: z.boolean().default(false),
  completedAt: z.string().datetime().nullable().default(null),
  /** Where a half-finished wizard should resume. */
  lastStep: z.string().max(60).nullable().default(null),
});

const gavelConfigSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION).default(CONFIG_SCHEMA_VERSION),
  runtime: runtimeSchema.default({}),
  identity: identitySchema.default({}),
  wallet: walletSchema.default({}),
  execution: executionSchema.default({}),
  followedDaos: z.array(daoIdSchema).default([]),
  inference: inferenceSchema.default({}),
  privacy: privacySchema.default({}),
  notifications: notificationsSchema.default({}),
  onboarding: onboardingSchema.default({}),
  /** Append-only record of what migration did. Never contains a secret value. */
  migrationNotes: z
    .array(z.object({ at: z.string(), code: z.string(), message: z.string() }))
    .default([]),
});

function defaultGavelConfig(overrides = {}) {
  return gavelConfigSchema.parse({ schemaVersion: CONFIG_SCHEMA_VERSION, ...overrides });
}

function parseGavelConfig(document) {
  return gavelConfigSchema.parse(document);
}

/**
 * Cross-branch rules a per-field schema cannot express.
 *
 * Returned as issues rather than thrown, because a config that is merely
 * *incomplete* must still load: a user who has not finished onboarding should
 * see what is missing, not a crash.
 */
function validateGavelConfig(configInput) {
  const config = parseGavelConfig(configInput);
  const issues = [];
  const issue = (code, message, path) => issues.push({ code, message, path });

  const known = new Set(listDaoIds());
  for (const dao of config.followedDaos) {
    if (!known.has(dao)) issue("UNKNOWN_DAO", `Unknown DAO in followedDaos: ${dao}`, "followedDaos");
  }
  if (new Set(config.followedDaos).size !== config.followedDaos.length) {
    issue("DUPLICATE_DAO", "followedDaos contains duplicates", "followedDaos");
  }

  if (config.wallet.type === WalletConnectionType.LOCAL && !config.wallet.local) {
    issue("WALLET_LOCAL_UNCONFIGURED", "A local wallet needs a keystore label or a variable name", "wallet.local");
  }
  if (config.wallet.type === WalletConnectionType.LOCAL && config.wallet.local) {
    const { signer, keystoreLabel, variable } = config.wallet.local;
    if (signer === "keystore" && !keystoreLabel) {
      issue("WALLET_KEYSTORE_UNNAMED", "A keystore signer needs a keystore label", "wallet.local.keystoreLabel");
    }
    if (signer === "environment" && !variable) {
      issue("WALLET_VARIABLE_UNNAMED", "An environment signer needs a variable name", "wallet.local.variable");
    }
  }

  const mode = config.execution.mode;
  if (mode === ExecutionMode.SAFE_SUPERVISED && !config.execution.safe) {
    issue("SAFE_UNCONFIGURED", "Safe-supervised execution needs a Safe address", "execution.safe");
  }
  if (mode === ExecutionMode.WAAP_AUTONOMOUS) {
    if (!config.execution.autonomous) {
      issue("AUTONOMOUS_UNCONFIGURED", "Autonomous execution needs a scoped execution wallet", "execution.autonomous");
    } else if (!config.execution.autonomous.acknowledgedAt) {
      // The invariant: credentials existing is never consent.
      issue(
        "AUTONOMOUS_NOT_ACKNOWLEDGED",
        "Autonomous execution must be explicitly acknowledged before it is enabled",
        "execution.autonomous.acknowledgedAt",
      );
    }
  }
  if (mode === ExecutionMode.EOA_SUPERVISED && config.wallet.type === WalletConnectionType.READ_ONLY) {
    issue(
      "EXECUTION_NEEDS_WALLET",
      "Interactive approval needs a connected wallet; read-only cannot sign",
      "execution.mode",
    );
  }

  if (!IMPLEMENTED_NETWORK_MODES.includes(config.privacy.network)) {
    issue(
      "NETWORK_MODE_UNIMPLEMENTED",
      `Network mode ${config.privacy.network} is declared but not implemented in this build`,
      "privacy.network",
    );
  }

  if (config.inference.mode === InferenceMode.REMOTE && !config.inference.endpointVariable) {
    issue("INFERENCE_ENDPOINT_UNNAMED", "Remote inference needs an endpoint variable name", "inference.endpointVariable");
  }

  return { config, issues, valid: issues.length === 0 };
}

module.exports = {
  CONFIG_SCHEMA_VERSION,
  IMPLEMENTED_NETWORK_MODES,
  InferenceMode,
  NetworkMode,
  defaultGavelConfig,
  gavelConfigSchema,
  parseGavelConfig,
  validateGavelConfig,
};
