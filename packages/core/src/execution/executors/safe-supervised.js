/**
 * Safe supervised execution: Gavel proposes, humans authorize.
 *
 *   ValidatedExecutionIntent
 *       -> construct the Safe transaction (nonce, SafeTx payload)
 *       -> sign it with the Safe *proposal* identity
 *       -> Safe Transaction Service
 *       -> SUBMITTED / AWAITING_AUTHORIZATION
 *       -> human Safe owners reach threshold
 *       -> EXECUTED
 *
 * Every Safe-specific concern lives here and nowhere else: the Safe address,
 * the nonce, the SafeTx hash, the Transaction Service, the proposer identity,
 * the proposal metadata, and the status lookup. No DAO adapter knows any of it,
 * and this adapter knows no DAO -- it never reads a governor ABI or a proposal.
 *
 * Two invariants are enforced here rather than documented:
 *
 * 1. Gavel is never a Safe owner. The adapter takes a ProposalIdentity, which
 *    has no broadcast capability, and it refuses a Safe whose owner set
 *    includes that identity. It also refuses a proposal the service reports as
 *    *confirmed* by the proposal identity -- a delegate signature is not a
 *    confirmation, and if the service says otherwise then the key is an owner
 *    and this is not supervised mode.
 *
 * 2. Provider metadata is not the authority. The SafeTx hash is computed
 *    locally from the EIP-712 payload and compared with the one the service
 *    returns, so a compromised or buggy Transaction Service cannot swap the
 *    transaction behind the proposal.
 */

const { TypedDataEncoder, getAddress } = require("ethers");

const { ExecutionMode } = require("../../schema/execution");
const { ExecutionEvent } = require("../events");
const { ExecutionState } = require("../lifecycle");
const { assertPreparable, assertSubmittable, executionPreparation } = require("../adapter");
const { assertProposalIdentity } = require("../identity/roles");

/**
 * Safe's EIP-712 SafeTx type (Safe >= 1.3.0, where the domain carries both
 * chainId and verifyingContract).
 */
const SAFE_TX_TYPES = Object.freeze({
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
});

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const OPERATION_CALL = 0;

/**
 * Map Safe Transaction Service vocabulary onto the canonical lifecycle.
 *
 * The service does not report a single status field, so this reads the shape of
 * the response. `isExecuted` is decisive; otherwise the confirmation count
 * against the threshold decides whether a human still has to act.
 */
function safeStateFrom(transaction) {
  if (transaction?.isSuccessful === false && transaction?.isExecuted) return ExecutionState.FAILED;
  if (transaction?.isExecuted) return ExecutionState.EXECUTED;
  if (transaction?.rejected === true) return ExecutionState.CANCELLED;
  const confirmations = Array.isArray(transaction?.confirmations) ? transaction.confirmations.length : 0;
  const threshold = Number(transaction?.confirmationsRequired ?? 0);
  if (threshold > 0 && confirmations >= threshold) return ExecutionState.AUTHORIZED;
  return ExecutionState.AWAITING_AUTHORIZATION;
}

function assertTransactionService(service) {
  if (!service || typeof service !== "object") throw new TypeError("A Safe Transaction Service client is required");
  for (const method of ["getNextNonce", "proposeTransaction", "getTransaction"]) {
    if (typeof service[method] !== "function") {
      throw new TypeError(`The Safe Transaction Service client is missing ${method}()`);
    }
  }
  return service;
}

class SafeSupervisedExecutionAdapter {
  /**
   * @param {object} options
   * @param {string} options.safeAddress            the operator's existing Safe
   * @param {number} options.chainId
   * @param {object} options.proposalIdentity        a ProposalIdentity, never an execution identity
   * @param {object} options.transactionService      getNextNonce / proposeTransaction / getTransaction
   * @param {object} [options.safeInfo]             optional getOwners()/getThreshold() for the owner check
   */
  constructor(options) {
    this.mode = ExecutionMode.SAFE_SUPERVISED;
    this.safeAddress = getAddress(options?.safeAddress);
    this.chainId = Number(options?.chainId);
    if (!Number.isInteger(this.chainId) || this.chainId <= 0) {
      throw new TypeError("Safe supervised mode requires a chain id");
    }
    // The type gate. An ExecutionIdentity cannot be passed here, so a key with
    // broadcast authority cannot end up driving the supervised path.
    this.proposalIdentity = assertProposalIdentity(options?.proposalIdentity);
    if (this.proposalIdentity.scope.safeAddress !== this.safeAddress) {
      throw new Error("The proposal identity is scoped to a different Safe");
    }
    if (this.proposalIdentity.scope.chainId !== this.chainId) {
      throw new Error("The proposal identity is scoped to a different chain");
    }
    this.transactionService = assertTransactionService(options?.transactionService);
    this.safeInfo = options?.safeInfo || null;
  }

  /** The address the vote is cast from: the Safe itself, never the proposer. */
  async getExecutionAddress() {
    return this.safeAddress;
  }

  /**
   * The Safe invariant, checked against the Safe's own owner set when the
   * operator supplies a reader for it.
   *
   * If the proposal identity is an owner, supervised mode is a fiction: Gavel's
   * signature would count toward the threshold. Fail closed rather than quietly
   * operate with more authority than the model claims.
   */
  async #assertNotAnOwner() {
    if (typeof this.safeInfo?.getOwners !== "function") return null;
    const [owners, proposer] = await Promise.all([
      this.safeInfo.getOwners(this.safeAddress),
      this.proposalIdentity.address(),
    ]);
    const normalized = (owners || []).map((owner) => getAddress(owner));
    if (normalized.includes(getAddress(proposer))) {
      throw new Error(
        `Refusing supervised mode: the proposal identity ${getAddress(proposer)} is a Safe owner. ` +
          "Gavel must not be a Safe owner -- authorization stays with the human threshold.",
      );
    }
    return normalized;
  }

  #safeTxPayload(intent, nonce) {
    const message = {
      to: getAddress(intent.target),
      value: intent.value,
      data: intent.data,
      operation: OPERATION_CALL,
      safeTxGas: "0",
      baseGas: "0",
      gasPrice: "0",
      gasToken: ZERO_ADDRESS,
      refundReceiver: ZERO_ADDRESS,
      nonce: String(nonce),
    };
    return {
      domain: { chainId: this.chainId, verifyingContract: this.safeAddress },
      types: SAFE_TX_TYPES,
      message,
    };
  }

  /**
   * Build and sign the Safe transaction. Reads the Safe's next nonce; writes
   * nothing.
   *
   * The nonce is read here rather than hashed into the intent precisely because
   * it is provider state: two attempts on the same governance action get
   * different nonces and the same intent hash.
   */
  async prepare(validated) {
    const intent = assertPreparable(this, validated).intent;
    if (getAddress(intent.actor) !== this.safeAddress) {
      throw new Error(
        `The validated intent is actored by ${getAddress(intent.actor)}, not the configured Safe ${this.safeAddress}`,
      );
    }
    if (intent.chainId !== this.chainId) {
      throw new Error(`The validated intent is for chain ${intent.chainId}, not ${this.chainId}`);
    }
    if (intent.operation !== "CALL") throw new Error("Safe supervised mode proposes CALL operations only");

    await this.#assertNotAnOwner();
    const nonce = String(await this.transactionService.getNextNonce(this.safeAddress));
    if (!/^\d+$/.test(nonce)) throw new Error("The Safe Transaction Service returned an unusable nonce");

    const payload = this.#safeTxPayload(intent, nonce);
    // Computed locally. This, not the service's echo, is the authority.
    const safeTxHash = TypedDataEncoder.hash(payload.domain, payload.types, payload.message);
    const signature = await this.proposalIdentity.proposeSafeTransaction(payload);
    const sender = await this.proposalIdentity.address();

    return executionPreparation(
      this,
      validated,
      {
        safeAddress: this.safeAddress,
        chainId: this.chainId,
        safeTransaction: payload.message,
        safeTxHash,
        sender: getAddress(sender),
        signature,
        // Metadata travels beside the transaction, never inside its calldata.
        metadata: {
          origin: "gavel",
          intentHash: validated.intentHash,
          voteIntentHash: intent.source.voteIntentHash,
          dao: intent.source.dao,
          proposalId: intent.source.proposalId,
          support: intent.source.support,
          reason: intent.source.reason,
          adapterVersion: validated.validation.adapterVersion,
        },
      },
      { providerData: { safeAddress: this.safeAddress, safeNonce: nonce, safeTxHash } },
    );
  }

  /** Submit to the Safe Transaction Service. */
  async submit(preparation) {
    const { payload, validated } = assertSubmittable(this, preparation);
    const response = await this.transactionService.proposeTransaction({
      safeAddress: payload.safeAddress,
      chainId: payload.chainId,
      safeTransactionData: payload.safeTransaction,
      safeTxHash: payload.safeTxHash,
      senderAddress: payload.sender,
      // Named to say what it is. A delegate/proposer signature places the
      // transaction in the queue; it is not an owner confirmation.
      senderSignature: payload.signature,
      origin: JSON.stringify(payload.metadata),
    });

    // Independent verification: the service does not get to decide which
    // transaction the proposal is for.
    const returnedHash = response?.safeTxHash;
    if (returnedHash && String(returnedHash).toLowerCase() !== payload.safeTxHash.toLowerCase()) {
      throw new Error(
        "The Safe Transaction Service returned a different safeTxHash than Gavel computed; " +
          "refusing to treat the proposal as ours",
      );
    }
    if (response?.confirmations) this.#assertProposerIsNotAConfirmer(response, payload.sender);

    return {
      state: safeStateFrom(response) === ExecutionState.EXECUTED ? ExecutionState.EXECUTED : ExecutionState.SUBMITTED,
      providerData: {
        safeAddress: payload.safeAddress,
        safeTxHash: payload.safeTxHash,
        safeNonce: String(payload.safeTransaction.nonce),
        providerRequestId: response?.requestId ? String(response.requestId) : undefined,
      },
      events: [
        {
          name: ExecutionEvent.SAFE_PROPOSED,
          detail: {
            safeTxHash: payload.safeTxHash,
            safeAddress: payload.safeAddress,
            safeNonce: String(payload.safeTransaction.nonce),
            adapterVersion: validated.validation.adapterVersion,
          },
        },
      ],
    };
  }

  /**
   * The authorization invariant. If the service reports Gavel's proposer as a
   * confirmer, its signature is counting toward the threshold, which means the
   * key is an owner. That is a configuration Gavel must not operate in.
   */
  #assertProposerIsNotAConfirmer(transaction, proposer) {
    const confirmers = (transaction.confirmations || [])
      .map((confirmation) => confirmation?.owner)
      .filter(Boolean)
      .map((owner) => getAddress(owner));
    if (confirmers.includes(getAddress(proposer))) {
      throw new Error(
        `The Safe Transaction Service counts the proposal identity ${getAddress(proposer)} as a ` +
          "confirming owner. Supervised mode requires that Gavel's signature never count toward " +
          "the Safe threshold.",
      );
    }
  }

  /** Poll the proposal. Human authorization progress is read, never assumed. */
  async status(record) {
    const safeTxHash = record?.providerData?.safeTxHash;
    if (!safeTxHash) throw new Error("This execution record has no safeTxHash to look up");
    const transaction = await this.transactionService.getTransaction(safeTxHash);
    if (!transaction) throw new Error(`The Safe Transaction Service does not know ${safeTxHash}`);

    // Re-verify on every poll, not only at submission: a service that starts
    // returning different transaction data for a known hash is the provider
    // compromise case, and it should surface here.
    if (String(transaction.safeTxHash || safeTxHash).toLowerCase() !== String(safeTxHash).toLowerCase()) {
      throw new Error("The Safe Transaction Service returned a different safeTxHash for this proposal");
    }
    if (transaction.to && getAddress(transaction.to) !== getAddress(record.target)) {
      throw new Error("The Safe proposal now names a different target than the validated intent");
    }
    if (transaction.data && String(transaction.data).toLowerCase() !== record.audit.calldata.toLowerCase()) {
      throw new Error("The Safe proposal now carries different calldata than the validated intent");
    }
    this.#assertProposerIsNotAConfirmer(transaction, await this.proposalIdentity.address());

    const state = safeStateFrom(transaction);
    return {
      state,
      providerData: {
        safeTxHash: String(safeTxHash),
        transactionHash: transaction.transactionHash || undefined,
        providerStatus: transaction.isExecuted ? "executed" : "pending",
      },
      detail: `confirmations ${(transaction.confirmations || []).length}/${transaction.confirmationsRequired ?? "?"}`,
    };
  }
}

module.exports = {
  OPERATION_CALL,
  SAFE_TX_TYPES,
  SafeSupervisedExecutionAdapter,
  safeStateFrom,
};
