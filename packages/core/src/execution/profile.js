/**
 * Execution profiles: how a voter executes, kept separate from who they are.
 *
 *   VoterProfile      governance preferences, history, the voter model.
 *                     Built by `profile/build.js`. Unchanged by this work.
 *   ExecutionProfile  which backend authorizes and submits. This file.
 *
 * A voter is never permanently tied to one execution provider. Switching from
 * supervised to autonomous mode replaces the execution profile and nothing
 * else -- the governance profile, history and voter model are untouched, which
 * is the point of keeping them apart.
 *
 * Selecting a mode is explicit. There is no "use whatever is configured"
 * fallback: a profile names its mode and the backend for that mode, and an
 * incomplete profile is an error rather than a default.
 */

const { z } = require("zod");
const { getAddress } = require("ethers");

const { addressSchema, chainIdSchema } = require("../schema/intent");
const { ExecutionMode } = require("../schema/execution");
const { getExecutionMode } = require("./modes");

/**
 * A credential reference, not a credential.
 *
 * `local:<label>` an encrypted keystore under GAVEL_DATA_DIR (the BYOH default)
 * `keychain:<label>` the OS keychain or system secret store
 * `remote:<id>` a KMS, HSM, or managed signer resolved by the runtime
 *
 * A profile never contains key material. `env:<VAR>` is accepted so
 * development setups can be described, and is rejected by
 * `assertProductionReady()`.
 */
const identityReferenceSchema = z
  .string()
  .regex(/^(local|keychain|remote|env):[A-Za-z0-9._-]+$/, "expected local:, keychain:, remote:, or env: reference");

const safeExecutionConfigSchema = z.object({
  address: addressSchema,
  chainId: chainIdSchema,
  /** The Safe *proposal* identity. Never an owner key, never a broadcaster. */
  proposalIdentity: identityReferenceSchema,
  /** Optional Safe Transaction Service base URL; the runtime supplies a client. */
  transactionServiceUrl: z.string().url().optional(),
});

const waapExecutionConfigSchema = z.object({
  wallet: z.string().min(1),
  chainId: chainIdSchema,
  /** The autonomous execution identity. Must not be the Safe proposer. */
  executionIdentity: identityReferenceSchema,
  /** Named policy the adapter's policy hook resolves. Required: no default-allow. */
  policy: z.string().min(1),
});

const executionProfileSchema = z
  .object({
    version: z.literal(1),
    mode: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    safe: safeExecutionConfigSchema.optional(),
    waap: waapExecutionConfigSchema.optional(),
    /** Offline mode's actor: the address the unsigned calldata is built for. */
    unsigned: z.object({ executionAddress: addressSchema, chainId: chainIdSchema }).optional(),
  })
  .superRefine((profile, context) => {
    const definition = (() => {
      try {
        return getExecutionMode(profile.mode);
      } catch (error) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["mode"], message: error.message });
        return null;
      }
    })();
    if (!definition) return;
    if (!definition.implemented) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mode"],
        message: `${profile.mode} is a declared but unimplemented execution mode`,
      });
    }
    const section = { [ExecutionMode.SAFE_SUPERVISED]: "safe", [ExecutionMode.WAAP_AUTONOMOUS]: "waap", [ExecutionMode.UNSIGNED]: "unsigned" }[
      profile.mode
    ];
    if (section && !profile[section]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [section],
        message: `mode ${profile.mode} requires a '${section}' configuration block`,
      });
    }
    // The identity invariant, at the configuration layer: one reference cannot
    // serve both roles. Address-level separation is checked again at runtime by
    // ExecutionIdentitySet, because two references can still resolve to one key.
    if (profile.safe && profile.waap && profile.safe.proposalIdentity === profile.waap.executionIdentity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["waap", "executionIdentity"],
        message:
          "the Safe proposal identity and the autonomous execution identity must be different credentials",
      });
    }
  });

function parseExecutionProfile(input) {
  return executionProfileSchema.parse(input);
}

/**
 * The configured actor for a profile: the address a vote is cast from.
 *
 * For Safe mode this is the Safe, not the proposer -- the proposer never
 * appears as an actor anywhere, because it holds no voting power and never
 * originates the call.
 */
function profileActor(profile) {
  const parsed = parseExecutionProfile(profile);
  if (parsed.mode === ExecutionMode.SAFE_SUPERVISED) return getAddress(parsed.safe.address);
  if (parsed.mode === ExecutionMode.UNSIGNED) return getAddress(parsed.unsigned.executionAddress);
  if (parsed.mode === ExecutionMode.WAAP_AUTONOMOUS) return null; // resolved from the identity backend
  return null;
}

function profileChainId(profile) {
  const parsed = parseExecutionProfile(profile);
  return (parsed.safe || parsed.waap || parsed.unsigned).chainId;
}

/** Every identity reference a profile uses, for auditing what is configured. */
function profileIdentityReferences(profile) {
  const parsed = parseExecutionProfile(profile);
  return [
    ...(parsed.safe ? [{ role: "proposal", reference: parsed.safe.proposalIdentity }] : []),
    ...(parsed.waap ? [{ role: "execution", reference: parsed.waap.executionIdentity }] : []),
  ];
}

/**
 * Refuse a profile that is fine for development but should not run in
 * production. Today that means one thing: a plaintext environment-variable key.
 */
function assertProductionReady(profile) {
  const parsed = parseExecutionProfile(profile);
  const development = profileIdentityReferences(parsed).filter((entry) => entry.reference.startsWith("env:"));
  if (development.length > 0) {
    throw new Error(
      `Refusing a production execution profile using plaintext environment keys: ` +
        `${development.map((entry) => entry.reference).join(", ")}. ` +
        "Create a keystore-backed identity (gavel identity create) or use a remote signer.",
    );
  }
  return parsed;
}

module.exports = {
  assertProductionReady,
  executionProfileSchema,
  identityReferenceSchema,
  parseExecutionProfile,
  profileActor,
  profileChainId,
  profileIdentityReferences,
  safeExecutionConfigSchema,
  waapExecutionConfigSchema,
};
