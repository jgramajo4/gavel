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
 * Three invariants are enforced here rather than documented:
 *
 * 1. Gavel is never a Safe owner. The adapter takes a ProposalIdentity, which
 *    has no broadcast capability, and it requires an onchain owner reader --
 *    not optionally -- refusing to run if the proposal identity is in the
 *    Safe's owner set. The check runs on every prepare and every submit, since
 *    an address can be added to a Safe at any time. It also refuses a proposal
 *    the service reports as *confirmed* by the proposal identity: a delegate
 *    signature is not a confirmation, and if the service says otherwise then
 *    the key is an owner and this is not supervised mode.
 *
 * 2. The onchain call comes from `validated.intent`, never from the
 *    preparation payload. The SafeTx body and hash are rebuilt at submit and
 *    the signature is produced over the rebuilt body, so a preparation altered
 *    between prepare() and submit() cannot be proposed.
 *
 * 3. Provider metadata is not the authority, and an absent field is not a
 *    pass. Verification is a read-back: the real Safe API answers a successful
 *    propose with an empty body, so the response cannot be the check. Every
 *    execution-critical field must be present and must match, on submit and on
 *    every poll.
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
   * @param {object} options.safeInfo               required getOwners(safeAddress) owner reader
   * @param {string} [options.safeVersion]          Safe contract version, default "1.3.0"
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

    // The owner reader is required, not optional.
    //
    // Skipping the owner check when it was absent made the "Gavel is never a
    // Safe owner" invariant opt-in -- and since no Safe client is bundled, the
    // default wiring was the unchecked one. An operator who cannot supply an
    // owner reader cannot run supervised mode, because nothing else establishes
    // that Gavel's signature does not count toward the threshold.
    if (typeof options?.safeInfo?.getOwners !== "function") {
      throw new TypeError(
        "Safe supervised mode requires safeInfo.getOwners(safeAddress): an onchain owner reader. " +
          "Without it Gavel cannot establish that its proposal identity is not a Safe owner.",
      );
    }
    this.safeInfo = options.safeInfo;
    // Safe <1.3.0 domains carry only verifyingContract; 1.3.0+ adds chainId.
    // Using the wrong shape produces a valid-looking but wrong safeTxHash.
    this.safeVersion = options.safeVersion || "1.3.0";
  }

  /** The address the vote is cast from: the Safe itself, never the proposer. */
  async getExecutionAddress() {
    return this.safeAddress;
  }

  /**
   * The Safe invariant, checked against the Safe's own owner set.
   *
   * If the proposal identity is an owner, supervised mode is a fiction: Gavel's
   * signature would count toward the threshold. Checked on every prepare and
   * every submit rather than once at construction, because an address can be
   * added to a Safe's owners at any time and a cached snapshot would miss it.
   */
  async #assertNotAnOwner() {
    const [owners, proposer] = await Promise.all([
      this.safeInfo.getOwners(this.safeAddress),
      this.proposalIdentity.address(),
    ]);
    if (!Array.isArray(owners) || owners.length === 0) {
      throw new Error("The Safe owner reader returned no owners; refusing to proceed without an owner set");
    }
    const normalized = owners.map((owner) => getAddress(owner));
    if (normalized.includes(getAddress(proposer))) {
      throw new Error(
        `Refusing supervised mode: the proposal identity ${getAddress(proposer)} is a Safe owner. ` +
          "Gavel must not be a Safe owner -- authorization stays with the human threshold.",
      );
    }
    return normalized;
  }

  /**
   * The canonical SafeTx body for a validated intent.
   *
   * Derived from `validated.intent` every time it is needed -- at prepare, and
   * again at submit -- so there is no stored copy for a caller to edit between
   * the two phases. The nonce is the only provider input, which is why it is
   * passed rather than read from a payload.
   */
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
    const domain =
      this.safeVersion === "1.3.0" || Number(this.safeVersion.split(".")[1]) >= 3
        ? { chainId: this.chainId, verifyingContract: this.safeAddress }
        : { verifyingContract: this.safeAddress };
    return { domain, types: SAFE_TX_TYPES, message };
  }

  /**
   * Every field the Transaction Service must return, compared against the
   * validated intent.
   *
   * Fail-closed. The previous checks were all `if (field && mismatch)`, so a
   * service that simply omitted `to`, `data` or `safeTxHash` passed every one
   * of them -- `{ isExecuted: true }` alone read as a successful execution of
   * whatever Gavel thought it had proposed. An absent field is now an error.
   */
  #assertServiceDescribesIntent(transaction, { intent, safeTxHash, nonce }) {
    // `chainId` is required alongside the rest. The Safe Transaction Service
    // is per-chain by endpoint and does not always carry it in the body, but
    // the client is Gavel-side code and can always report which chain it
    // queried -- and a field that is sometimes absent is a field an attacker
    // can omit. Making the client surface it is a smaller cost than leaving a
    // conditional check.
    const required = ["safeTxHash", "safe", "to", "data", "value", "operation", "nonce", "chainId"];
    const missing = required.filter((field) => transaction[field] === undefined || transaction[field] === null);
    if (missing.length > 0) {
      throw new Error(
        `The Safe Transaction Service did not return ${missing.join(", ")} for ${safeTxHash}; ` +
          "refusing to infer the state of a transaction it will not fully describe",
      );
    }

    const mismatches = [];
    const sameHex = (left, right) => String(left).toLowerCase() === String(right).toLowerCase();
    if (!sameHex(transaction.safeTxHash, safeTxHash)) mismatches.push("safeTxHash");
    if (getAddress(transaction.safe) !== this.safeAddress) mismatches.push("safe");
    if (getAddress(transaction.to) !== getAddress(intent.target)) mismatches.push("to");
    if (!sameHex(transaction.data, intent.data)) mismatches.push("data");
    if (BigInt(transaction.value) !== BigInt(intent.value)) mismatches.push("value");
    if (Number(transaction.operation) !== OPERATION_CALL) mismatches.push("operation");
    if (String(transaction.nonce) !== String(nonce)) mismatches.push("nonce");
    if (Number(transaction.chainId) !== this.chainId) mismatches.push("chainId");
    if (mismatches.length > 0) {
      throw new Error(
        `The Safe proposal ${safeTxHash} no longer matches the validated intent (${mismatches.join(", ")}); ` +
          "the Transaction Service is describing a different transaction",
      );
    }
    return transaction;
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

  /**
   * Submit to the Safe Transaction Service, then verify by reading back.
   *
   * The body and hash are recomputed here from `validated.intent` rather than
   * taken from the payload, so a look-alike preparation carrying a mutated
   * `safeTransaction` proposes the validated transaction, not the mutated one.
   *
   * Verification is a read-back rather than a check of the propose response.
   * The real Safe API answers a successful propose with 201 and an empty body,
   * so the response cannot be the verification -- and a proposal that cannot be
   * read back and matched against the intent is not treated as submitted.
   */
  async submit(preparation) {
    const { payload, validated } = assertSubmittable(this, preparation);
    const intent = validated.intent;
    if (getAddress(intent.actor) !== this.safeAddress) {
      throw new Error(`The validated intent is actored by ${getAddress(intent.actor)}, not ${this.safeAddress}`);
    }
    if (intent.chainId !== this.chainId) {
      throw new Error(`The validated intent is for chain ${intent.chainId}, not ${this.chainId}`);
    }
    await this.#assertNotAnOwner();

    // Rebuilt from the intent. The nonce is the one provider value, and it is
    // covered by the recomputed hash below.
    const nonce = String(payload.safeTransaction?.nonce ?? "");
    if (!/^\d+$/.test(nonce)) throw new Error("This preparation carries no usable Safe nonce");
    const rebuilt = this.#safeTxPayload(intent, nonce);
    const safeTxHash = TypedDataEncoder.hash(rebuilt.domain, rebuilt.types, rebuilt.message);
    if (safeTxHash.toLowerCase() !== String(payload.safeTxHash).toLowerCase()) {
      throw new Error(
        "The Safe transaction recomputed from the validated intent does not match the prepared " +
          "safeTxHash; the preparation was altered between prepare() and submit()",
      );
    }
    // Re-signed over the recomputed payload, so the signature can never belong
    // to a body other than the one being sent.
    const signature = await this.proposalIdentity.proposeSafeTransaction(rebuilt);
    const sender = getAddress(await this.proposalIdentity.address());

    const response = await this.transactionService.proposeTransaction({
      safeAddress: this.safeAddress,
      chainId: this.chainId,
      safeTransactionData: rebuilt.message,
      safeTxHash,
      senderAddress: sender,
      // Named to say what it is. A delegate/proposer signature places the
      // transaction in the queue; it is not an owner confirmation.
      senderSignature: signature,
      origin: JSON.stringify(payload.metadata),
    });
    if (response?.safeTxHash && String(response.safeTxHash).toLowerCase() !== safeTxHash.toLowerCase()) {
      throw new Error(
        "The Safe Transaction Service returned a different safeTxHash than Gavel computed; " +
          "refusing to treat the proposal as ours",
      );
    }

    let readBack;
    try {
      readBack = await this.transactionService.getTransaction(safeTxHash);
    } catch (error) {
      throw new Error(`The Safe proposal could not be read back for verification: ${error.message}`);
    }
    if (!readBack) {
      throw new Error(
        `The Safe Transaction Service does not know ${safeTxHash} immediately after proposing it; ` +
          "the proposal could not be read back and verified",
      );
    }
    this.#assertServiceDescribesIntent(readBack, { intent, safeTxHash, nonce });
    this.#assertProposerIsNotAConfirmer(readBack, sender);

    return {
      state: safeStateFrom(readBack) === ExecutionState.EXECUTED ? ExecutionState.EXECUTED : ExecutionState.SUBMITTED,
      providerData: {
        safeAddress: this.safeAddress,
        safeTxHash,
        safeNonce: nonce,
        providerRequestId: response?.requestId ? String(response.requestId) : undefined,
      },
      events: [
        {
          name: ExecutionEvent.SAFE_PROPOSED,
          detail: {
            safeTxHash,
            safeAddress: this.safeAddress,
            safeNonce: nonce,
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

  /**
   * Poll the proposal. Human authorization progress is read, never assumed.
   *
   * The full field set is re-verified on every poll against the record's own
   * account of the validated intent, so a service that starts describing a
   * different transaction for a known hash -- by substitution or by omission --
   * surfaces here rather than being reported as progress.
   */
  async status(record) {
    const safeTxHash = record?.providerData?.safeTxHash;
    if (!safeTxHash) throw new Error("This execution record has no safeTxHash to look up");
    const nonce = record?.providerData?.safeNonce;
    if (!nonce) throw new Error("This execution record has no Safe nonce to verify against");
    const transaction = await this.transactionService.getTransaction(safeTxHash);
    if (!transaction) throw new Error(`The Safe Transaction Service does not know ${safeTxHash}`);

    this.#assertServiceDescribesIntent(transaction, {
      // The record carries the execution-critical fields of the intent it was
      // created from, which is what makes this checkable after a restart.
      intent: { target: record.target, data: record.audit.calldata, value: record.audit.value ?? "0" },
      safeTxHash,
      nonce,
    });
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
