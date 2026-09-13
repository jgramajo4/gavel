/**
 * Identity roles, as capabilities rather than labels.
 *
 * There is no generic `Wallet` in this layer, because a generic wallet makes
 * capability confusion easy and invisible. Instead there are two distinct types
 * that expose different methods:
 *
 *   ProposalIdentity   can sign a Safe transaction proposal. That is all it
 *                      can do. It has no `signTransaction`, no `broadcast`,
 *                      and no path to either.
 *   ExecutionIdentity  can sign and broadcast a transaction. Strictly more
 *                      authority, and therefore strictly separate.
 *
 * The types are not interchangeable and there is no conversion between them.
 * `assertExecutionIdentity(proposalIdentity)` throws; nothing exported upgrades
 * a proposal identity, so the "proposal identities cannot become autonomous
 * execution identities" invariant holds structurally rather than by review.
 *
 * A Safe proposal identity therefore cannot: hold governance delegation (it is
 * never the delegate the DAO adapter checks), hold funds (it signs a proposal,
 * never a transfer), count toward the Safe threshold (a delegate signature is
 * not a confirmation -- the Safe adapter asserts this), or execute anything
 * (it has no broadcast capability to call).
 */

const { getAddress } = require("ethers");

const { assertSigningIdentity } = require("./signing");

const IdentityRole = Object.freeze({
  PROPOSAL: "proposal",
  EXECUTION: "execution",
});

/**
 * Capabilities, named after what they let you do.
 *
 * A Safe proposal identity holds only PROPOSE_SAFE_TRANSACTION. A WaaP
 * execution identity holds SIGN_TRANSACTION and BROADCAST_TRANSACTION.
 */
const Capability = Object.freeze({
  PROPOSE_SAFE_TRANSACTION: "proposeSafeTransaction",
  SIGN_TRANSACTION: "signTransaction",
  BROADCAST_TRANSACTION: "broadcastTransaction",
});

const PROPOSAL_CAPABILITIES = Object.freeze([Capability.PROPOSE_SAFE_TRANSACTION]);
const EXECUTION_CAPABILITIES = Object.freeze([
  Capability.SIGN_TRANSACTION,
  Capability.BROADCAST_TRANSACTION,
]);

/**
 * An identity whose entire authority is to place a transaction into a Safe's
 * approval queue.
 *
 * Its scope is bound at construction -- one Safe, one chain -- so a credential
 * created for one Safe cannot propose into another. It is independently
 * revocable: revoking the Safe delegate entry, or deleting the credential,
 * removes this identity's authority without touching the Safe's owners or the
 * autonomous execution identity.
 */
class ProposalIdentity {
  #signer;
  #scope;
  #address;

  constructor(signer, scope) {
    this.#signer = assertSigningIdentity(signer, "proposal signing identity");
    // Resolve once at construction. The effective proposal address must not
    // follow a mutable signer backend after authorization or submission.
    this.#address = Promise.resolve(this.#signer.address()).then(getAddress);
    this.#scope = Object.freeze({
      safeAddress: getAddress(scope.safeAddress),
      chainId: Number(scope.chainId),
      label: scope.label || null,
    });
    if (!Number.isInteger(this.#scope.chainId) || this.#scope.chainId <= 0) {
      throw new TypeError("A proposal identity requires a chain id");
    }
    Object.freeze(this);
  }

  static get role() {
    return IdentityRole.PROPOSAL;
  }

  /**
   * Brand check on a private field.
   *
   * Private names are lexically scoped to their class, so this tests for
   * *ProposalIdentity's* `#signer` slot specifically. An ExecutionIdentity
   * declares its own `#signer` and does not pass, and neither does a prototype
   * look-alike -- which is what makes the two roles genuinely non-substitutable
   * rather than conventionally so.
   */
  static isProposalIdentity(value) {
    return (typeof value === "object" || typeof value === "function") && value !== null
      ? #signer in value
      : false;
  }

  get role() {
    return IdentityRole.PROPOSAL;
  }

  get capabilities() {
    return PROPOSAL_CAPABILITIES;
  }

  get scope() {
    return this.#scope;
  }

  get description() {
    return this.#signer.description || "proposal identity";
  }

  can(capability) {
    return PROPOSAL_CAPABILITIES.includes(capability);
  }

  async address() {
    return this.#address;
  }

  /**
   * The only signing this identity performs: an EIP-712 SafeTx payload, so the
   * Safe Transaction Service will accept the proposal from a delegate.
   *
   * Scope-checked. A payload for a different Safe or chain is refused here,
   * before any network call, so a mis-wired adapter cannot borrow this
   * credential for another Safe.
   */
  async proposeSafeTransaction(payload, trustedScope = {}) {
    if (getAddress(payload?.domain?.verifyingContract ?? "") !== this.#scope.safeAddress) {
      throw new Error("Proposal identity is not scoped to this Safe");
    }
    const signedChainId = payload.domain.chainId;
    const trustedChainId = trustedScope.chainId;
    if (
      signedChainId === undefined ||
      Number(signedChainId) !== this.#scope.chainId ||
      (trustedChainId !== undefined && Number(signedChainId) !== Number(trustedChainId))
    ) {
      throw new Error("Proposal identity is not scoped to this chain");
    }
    return this.#signer.signTypedData(payload.domain, payload.types, payload.message);
  }
}

/**
 * An identity that can sign and broadcast. Strictly more authority than a
 * proposal identity, and used only by an explicitly configured autonomous
 * executor.
 */
class ExecutionIdentity {
  #signer;
  #broadcaster;
  #scope;

  constructor(signer, scope, broadcaster) {
    this.#signer = assertSigningIdentity(signer, "execution signing identity");
    if (typeof broadcaster?.broadcast !== "function") {
      throw new TypeError("An execution identity requires a broadcaster with broadcast()");
    }
    this.#broadcaster = broadcaster;
    this.#scope = Object.freeze({
      chainId: Number(scope.chainId),
      policyId: scope.policyId || null,
      label: scope.label || null,
    });
    if (!Number.isInteger(this.#scope.chainId) || this.#scope.chainId <= 0) {
      throw new TypeError("An execution identity requires a chain id");
    }
    Object.freeze(this);
  }

  static get role() {
    return IdentityRole.EXECUTION;
  }

  static isExecutionIdentity(value) {
    return (typeof value === "object" || typeof value === "function") && value !== null
      ? #broadcaster in value
      : false;
  }

  get role() {
    return IdentityRole.EXECUTION;
  }

  get capabilities() {
    return EXECUTION_CAPABILITIES;
  }

  get scope() {
    return this.#scope;
  }

  get description() {
    return this.#signer.description || "execution identity";
  }

  can(capability) {
    return EXECUTION_CAPABILITIES.includes(capability);
  }

  async address() {
    return getAddress(await this.#signer.address());
  }

  async signTransaction(payload) {
    if (Number(payload?.domain?.chainId) !== this.#scope.chainId) {
      throw new Error("Execution identity is not scoped to this chain");
    }
    return this.#signer.signTypedData(payload.domain, payload.types, payload.message);
  }

  async broadcast(request) {
    if (Number(request?.chainId) !== this.#scope.chainId) {
      throw new Error("Execution identity is not scoped to this chain");
    }
    return this.#broadcaster.broadcast(request);
  }
}

function assertProposalIdentity(value) {
  if (!ProposalIdentity.isProposalIdentity(value)) {
    throw new TypeError(
      "A ProposalIdentity is required. An execution identity must never be used to " +
        "propose into a Safe, and there is no conversion between the two roles.",
    );
  }
  return value;
}

function assertExecutionIdentity(value) {
  if (!ExecutionIdentity.isExecutionIdentity(value)) {
    throw new TypeError(
      "An ExecutionIdentity is required. A Safe proposal identity cannot become an " +
        "autonomous execution identity, by design.",
    );
  }
  return value;
}

/** The identity a mode is allowed to be given, from the mode registry's role. */
function assertIdentityForRole(role, identity) {
  if (role === IdentityRole.PROPOSAL) return assertProposalIdentity(identity);
  if (role === IdentityRole.EXECUTION) return assertExecutionIdentity(identity);
  throw new TypeError(`Unknown identity role: ${role}`);
}

/**
 * Both identities for one voter profile, with the separation invariant checked.
 *
 * Two identities may coexist for the same Gavel voter -- a Safe proposer for
 * supervised mode, a WaaP wallet for autonomous mode -- but never as the same
 * key. Constructing this asserts the addresses differ, which is the check the
 * type system cannot make on its own because both are ultimately addresses.
 */
class ExecutionIdentitySet {
  constructor(identities = {}) {
    this.proposal = identities.proposal ? assertProposalIdentity(identities.proposal) : null;
    this.execution = identities.execution ? assertExecutionIdentity(identities.execution) : null;
    Object.freeze(this);
  }

  /** Async because an address may have to be fetched from its backend. */
  async assertSeparation() {
    if (!this.proposal || !this.execution) return true;
    const [proposal, execution] = await Promise.all([this.proposal.address(), this.execution.address()]);
    if (getAddress(proposal) === getAddress(execution)) {
      throw new Error(
        `Identity separation violated: ${getAddress(proposal)} is configured as both the Safe ` +
          "proposal identity and the autonomous execution identity. These must be distinct keys, " +
          "because the autonomous identity has materially more authority.",
      );
    }
    return true;
  }
}

function createProposalIdentity(options) {
  return new ProposalIdentity(options.signer, {
    safeAddress: options.safeAddress,
    chainId: options.chainId,
    label: options.label,
  });
}

function createExecutionIdentity(options) {
  return new ExecutionIdentity(
    options.signer,
    { chainId: options.chainId, policyId: options.policyId, label: options.label },
    options.broadcaster,
  );
}

module.exports = {
  Capability,
  EXECUTION_CAPABILITIES,
  ExecutionIdentity,
  ExecutionIdentitySet,
  IdentityRole,
  PROPOSAL_CAPABILITIES,
  ProposalIdentity,
  assertExecutionIdentity,
  assertIdentityForRole,
  assertProposalIdentity,
  createExecutionIdentity,
  createProposalIdentity,
};
