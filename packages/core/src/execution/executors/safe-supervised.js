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

const { getAddress } = require("ethers");

const { ExecutionMode } = require("../../schema/execution");
const { ExecutionEvent } = require("../events");
const { ExecutionState } = require("../lifecycle");
const { assertPreparable, assertSubmittable, executionPreparation } = require("../adapter");
const { assertProposalIdentity } = require("../identity/roles");
const { SafeProposalProvider } = require("../providers/safe-proposal");

const OPERATION_CALL = 0;

/**
 * Map Safe Transaction Service vocabulary onto the canonical lifecycle.
 *
 * The service does not report a single status field, so this reads the shape of
 * the response. `isExecuted` is decisive; otherwise the confirmation count
 * against the threshold decides whether a human still has to act.
 */
function safeStateFrom(transaction) {
  if (transaction?.onchainExecutionStatus === "failed") return ExecutionState.FAILED;
  if (transaction?.onchainExecutionStatus === "success") return ExecutionState.EXECUTED;
  if (transaction?.nonceConsumed === true) return ExecutionState.CANCELLED;
  const confirmations = Number(transaction?.authoritativeConfirmations ?? 0);
  const threshold = Number(transaction?.onchainThreshold ?? 0);
  if (threshold > 0 && confirmations >= threshold) return ExecutionState.AUTHORIZED;
  return ExecutionState.AWAITING_AUTHORIZATION;
}

class SafeSupervisedExecutionAdapter {
  #proposalIdentity;
  #proposalProvider;

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
    this.#proposalIdentity = assertProposalIdentity(options?.proposalIdentity);
    if (this.#proposalIdentity.scope.safeAddress !== this.safeAddress) {
      throw new Error("The proposal identity is scoped to a different Safe");
    }
    if (this.#proposalIdentity.scope.chainId !== this.chainId) {
      throw new Error("The proposal identity is scoped to a different chain");
    }

    if (options?.transactionService || options?.safeInfo || options?.safeVersion) {
      throw new TypeError(
        "The legacy hand-rolled Safe transactionService path is unsupported; inject proposalProvider or an RPC provider",
      );
    }
    this.#proposalProvider = options?.proposalProvider || new SafeProposalProvider({
      safeAddress: this.safeAddress,
      chainId: this.chainId,
      proposalIdentity: this.#proposalIdentity,
      provider: options?.provider,
      txServiceUrl: options?.txServiceUrl,
      apiKey: options?.apiKey,
    });
    if (this.#proposalProvider.proposalIdentity !== this.#proposalIdentity) {
      throw new Error("The Safe proposal provider must use the same identity as the adapter");
    }
    for (const method of ["prepare", "submit", "getTransaction"]) {
      if (typeof this.#proposalProvider[method] !== "function") {
        throw new TypeError(`The Safe proposal provider is missing ${method}()`);
      }
    }
  }

  get proposalIdentity() {
    return this.#proposalIdentity;
  }

  getProposalIdentity() {
    return this.#proposalProvider.proposalIdentity;
  }

  get proposalProvider() {
    return this.#proposalProvider;
  }

  /** Serialize Transaction Service nonce allocation across cooperating local processes. */
  lockKeys() {
    return [`safe-nonce:${this.chainId}:${this.safeAddress.toLowerCase()}`];
  }

  /** The address the vote is cast from: the Safe itself, never the proposer. */
  async getExecutionAddress() {
    return this.safeAddress;
  }

  #origin(validated) {
    return {
      source: "gavel",
      dao: validated.intent.source.dao,
      proposalId: validated.intent.source.proposalId,
      support: validated.intent.source.support,
      intentHash: validated.intentHash,
      mode: this.mode,
    };
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
    const required = [
      "safeTxHash", "safe", "to", "data", "value", "operation", "nonce", "chainId",
      "confirmations", "confirmationsRequired", "isExecuted",
    ];
    const missing = required.filter((field) => transaction[field] === undefined || transaction[field] === null);
    if (missing.length > 0) {
      throw new Error(
        `The Safe Transaction Service did not return ${missing.join(", ")} for ${safeTxHash}; ` +
          "refusing to infer the state of a transaction it will not fully describe",
      );
    }
    if (!Array.isArray(transaction.confirmations)) {
      throw new Error("The Safe Transaction Service returned malformed confirmations");
    }
    if (
      transaction.isExecuted &&
      (typeof transaction.isSuccessful !== "boolean" ||
        !/^0x[0-9a-fA-F]{64}$/.test(String(transaction.transactionHash)))
    ) {
      throw new Error("The Safe Transaction Service returned an executed transaction without a definitive outcome");
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
  async prepare(validated, options = {}) {
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

    const existing = options.existingProviderData || {};
    const proposal = await this.proposalProvider.prepare(validated, {
      safeNonce: existing.safeNonce,
    });
    if (
      existing.safeTxHash &&
      String(existing.safeTxHash).toLowerCase() !== proposal.safeTxHash.toLowerCase()
    ) {
      throw new Error("Rebuilding the persisted Safe nonce produced a different safeTxHash");
    }
    return executionPreparation(
      this,
      validated,
      {
        safeAddress: this.safeAddress,
        chainId: this.chainId,
        safeTransaction: proposal.safeTransactionData,
        safeTxHash: proposal.safeTxHash,
        sender: proposal.senderAddress,
        signature: proposal.senderSignature,
        metadata: this.#origin(validated),
      },
      {
        providerData: {
          safeAddress: this.safeAddress,
          safeNonce: proposal.safeNonce,
          safeTxHash: proposal.safeTxHash,
        },
      },
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
  async submit(preparation, options = {}) {
    const { payload, validated } = assertSubmittable(this, preparation);
    const intent = validated.intent;
    if (getAddress(intent.actor) !== this.safeAddress) {
      throw new Error(`The validated intent is actored by ${getAddress(intent.actor)}, not ${this.safeAddress}`);
    }
    if (intent.chainId !== this.chainId) {
      throw new Error(`The validated intent is for chain ${intent.chainId}, not ${this.chainId}`);
    }

    const nonce = String(payload.safeTransaction?.nonce ?? "");
    if (!/^\d+$/.test(nonce)) throw new Error("This preparation carries no usable Safe nonce");
    const origin = JSON.stringify(this.#origin(validated));
    const { proposal, transaction } = await this.proposalProvider.submit(
      validated,
      { safeNonce: nonce, safeTxHash: payload.safeTxHash },
      { origin, beforeProviderDispatch: options.beforeProviderDispatch },
    );
    this.#assertServiceDescribesIntent(transaction, {
      intent,
      safeTxHash: proposal.safeTxHash,
      nonce: proposal.safeNonce,
    });
    this.#assertProposerIsNotAConfirmer(transaction, proposal.senderAddress);
    return {
      state: safeStateFrom(transaction) === ExecutionState.EXECUTED ? ExecutionState.EXECUTED : ExecutionState.SUBMITTED,
      providerData: {
        safeAddress: this.safeAddress,
        safeTxHash: proposal.safeTxHash,
        safeNonce: proposal.safeNonce,
      },
      events: [{
        name: ExecutionEvent.SAFE_PROPOSED,
        detail: {
          safeTxHash: proposal.safeTxHash,
          safeAddress: this.safeAddress,
          safeNonce: proposal.safeNonce,
          adapterVersion: validated.validation.adapterVersion,
        },
      }],
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
  async #providerStatus(record, reconcile) {
    const safeTxHash = record?.providerData?.safeTxHash;
    if (!safeTxHash) throw new Error("This execution record has no safeTxHash to look up");
    const nonce = record?.providerData?.safeNonce;
    if (!nonce) throw new Error("This execution record has no Safe nonce to verify against");
    const expectedIntent = {
      target: record.target,
      data: record.audit.calldata,
      value: record.audit.value ?? "0",
    };
    const expected = { intent: expectedIntent, nonce };
    const transaction = reconcile && typeof this.proposalProvider.lookupTransaction === "function"
      ? await this.proposalProvider.lookupTransaction(safeTxHash, expected)
      : await this.proposalProvider.getTransaction(safeTxHash, expected);
    if (!transaction) {
      if (reconcile) return null;
      throw new Error(`The Safe Transaction Service does not know ${safeTxHash}`);
    }

    this.#assertServiceDescribesIntent(transaction, {
      intent: expectedIntent,
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

  async reconcile(record) {
    return this.#providerStatus(record, true);
  }

  async status(record) {
    return this.#providerStatus(record, false);
  }
}

module.exports = {
  OPERATION_CALL,
  SafeSupervisedExecutionAdapter,
  safeStateFrom,
};
