"use strict";

const { getAddress, Interface } = require("ethers");
const Safe = require("@safe-global/protocol-kit").default;
const { generateTypedData } = require("@safe-global/protocol-kit");
const SafeApiKit = require("@safe-global/api-kit").default;

const SAFE_EXECUTION_EVENTS = new Interface([
  "event ExecutionSuccess(bytes32 txHash, uint256 payment)",
  "event ExecutionFailure(bytes32 txHash, uint256 payment)",
]);

const { assertProposalIdentity } = require("../identity/roles");
const { assertValidatedExecutionIntent } = require("../../intent/validated");

const SafeProposalAuthorization = Object.freeze({
  AUTHORIZED: "authorized",
  NOT_AUTHORIZED: "not-authorized",
  OWNER_CONFLICT: "owner-conflict",
  SERVICE_UNAVAILABLE: "service-unavailable",
});

class SafeProposalProvider {
  #protocolKit;
  #protocolKitPromise;
  #apiKit;
  #proposalIdentity;

  constructor(options = {}) {
    this.safeAddress = getAddress(options.safeAddress);
    this.chainId = Number(options.chainId);
    if (!Number.isSafeInteger(this.chainId) || this.chainId <= 0) {
      throw new TypeError("SafeProposalProvider requires a chain id");
    }
    this.#proposalIdentity = assertProposalIdentity(options.proposalIdentity);
    if (this.#proposalIdentity.scope.safeAddress !== this.safeAddress) {
      throw new Error("The proposal identity is scoped to a different Safe");
    }
    if (this.proposalIdentity.scope.chainId !== this.chainId) {
      throw new Error("The proposal identity is scoped to a different chain");
    }

    this.#protocolKit = options.protocolKit || null;
    if (!this.#protocolKit && !options.provider) {
      throw new TypeError("SafeProposalProvider requires an EIP-1193/RPC provider");
    }
    this.#protocolKitPromise = this.#protocolKit
      ? Promise.resolve(this.#protocolKit)
      : Safe.init({ provider: options.provider, safeAddress: this.safeAddress });
    this.#apiKit =
      options.apiKit ||
      new SafeApiKit({
        chainId: BigInt(this.chainId),
        txServiceUrl: options.txServiceUrl,
        apiKey: options.apiKey,
      });
  }

  get proposalIdentity() {
    return this.#proposalIdentity;
  }

  async #safe() {
    return this.#protocolKitPromise;
  }

  async #onchainSecurityState() {
    const safe = await this.#safe();
    const actualChainId = Number(await safe.getChainId());
    if (!Number.isSafeInteger(actualChainId) || actualChainId !== this.chainId) {
      throw new Error(`Configured chain ${this.chainId} does not match RPC chain ${actualChainId}`);
    }
    const [rawOwners, rawThreshold, rawNonce] = await Promise.all([
      safe.getOwners(), safe.getThreshold(), safe.getNonce(),
    ]);
    const owners = rawOwners.map(getAddress);
    const threshold = Number(rawThreshold);
    const nonce = Number(rawNonce);
    if (owners.length === 0 || new Set(owners).size !== owners.length) throw new Error("missing or malformed onchain Safe owners");
    if (!Number.isSafeInteger(threshold) || threshold <= 0 || threshold > owners.length) {
      throw new Error("missing or malformed onchain Safe threshold");
    }
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("missing or malformed onchain Safe nonce");
    return { safe, owners, ownerSet: new Set(owners), threshold, nonce };
  }

  async #delegates(proposer) {
    const results = [];
    let offset;
    const seenOffsets = new Set();
    do {
      const page = await this.#apiKit.getSafeDelegates({
        safeAddress: this.safeAddress,
        delegateAddress: proposer,
        ...(offset === undefined ? {} : { offset }),
      });
      if (!page || !Array.isArray(page.results) || !Number.isInteger(page.count)) {
        throw new Error("malformed delegate response");
      }
      results.push(...page.results);
      if (!page.next) break;
      const nextOffset = Number(new URL(page.next, "https://safe.invalid").searchParams.get("offset"));
      if (!Number.isSafeInteger(nextOffset) || nextOffset < 0 || seenOffsets.has(nextOffset)) {
        throw new Error("malformed delegate pagination");
      }
      seenOffsets.add(nextOffset);
      offset = nextOffset;
    } while (true);
    return results;
  }

  async authorization() {
    let proposer;
    try {
      proposer = getAddress(await this.proposalIdentity.address());
      const { owners: normalizedOwners, ownerSet } = await this.#onchainSecurityState();
      if (normalizedOwners.includes(proposer)) {
        return { status: SafeProposalAuthorization.OWNER_CONFLICT, proposer };
      }
      const delegates = await this.#delegates(proposer);
      const now = Date.now();
      const authorized = delegates.some((entry) => {
        if (
          !entry ||
          getAddress(entry.safe) !== this.safeAddress ||
          getAddress(entry.delegate) !== proposer ||
          !ownerSet.has(getAddress(entry.delegator))
        ) return false;
        const expiry = Date.parse(entry.expiryDate);
        return Number.isFinite(expiry) && expiry > now;
      });
      return {
        status: authorized ? SafeProposalAuthorization.AUTHORIZED : SafeProposalAuthorization.NOT_AUTHORIZED,
        proposer,
      };
    } catch (error) {
      return {
        status: SafeProposalAuthorization.SERVICE_UNAVAILABLE,
        proposer,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async #assertAuthorized() {
    const authorization = await this.authorization();
    if (authorization.status === SafeProposalAuthorization.AUTHORIZED) return authorization;
    const messages = {
      [SafeProposalAuthorization.NOT_AUTHORIZED]: "The proposal identity is not authorized as a Safe delegate",
      [SafeProposalAuthorization.OWNER_CONFLICT]: "The proposal identity is a Safe owner and cannot operate as a delegate",
      [SafeProposalAuthorization.SERVICE_UNAVAILABLE]: "Safe delegate authorization is unavailable",
    };
    const message = messages[authorization.status] || "Safe delegate authorization failed";
    const error = new Error(authorization.reason ? `${message}: ${authorization.reason}` : message);
    error.code = authorization.status;
    throw error;
  }

  #assertIntent(validated) {
    const value = assertValidatedExecutionIntent(validated);
    const intent = value.intent;
    if (getAddress(intent.actor) !== this.safeAddress) throw new Error("The validated intent actor is not the configured Safe");
    if (intent.chainId !== this.chainId) throw new Error("The validated intent is for a different chain");
    if (intent.operation !== "CALL") throw new Error("Safe proposals support CALL operations only");
    return intent;
  }

  #assertSafeTransactionData(data, intent, nonce) {
    const required = [
      "to", "value", "data", "operation", "safeTxGas", "baseGas", "gasPrice", "gasToken", "refundReceiver", "nonce",
    ];
    if (!data || required.some((field) => data[field] === undefined || data[field] === null)) {
      throw new Error("Protocol Kit returned a malformed Safe transaction");
    }
    try {
      if (
        getAddress(data.to) !== getAddress(intent.target) ||
        BigInt(data.value) !== BigInt(intent.value) ||
        String(data.data).toLowerCase() !== String(intent.data).toLowerCase() ||
        Number(data.operation) !== 0 ||
        Number(data.nonce) !== nonce
      ) {
        throw new Error("mismatch");
      }
    } catch {
      throw new Error("Protocol Kit returned a malformed Safe transaction");
    }
    return data;
  }

  async #build(validated, nonce) {
    const intent = this.#assertIntent(validated);
    const safe = await this.#safe();
    const safeTransaction = await safe.createTransaction({
      transactions: [{
        to: getAddress(intent.target),
        value: String(intent.value),
        data: intent.data,
        operation: 0,
      }],
      options: { nonce },
    });
    const safeTransactionData = this.#assertSafeTransactionData(safeTransaction?.data, intent, nonce);
    const safeTxHash = await safe.getTransactionHash(safeTransaction);
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(safeTxHash))) {
      throw new Error("Protocol Kit returned a malformed Safe transaction hash");
    }
    const safeVersion = safe.getContractVersion();
    if (typeof safeVersion !== "string" || !/^\d+\.\d+\.\d+/.test(safeVersion)) {
      throw new Error("Protocol Kit returned a malformed Safe version");
    }
    const typedData = generateTypedData({
      safeAddress: this.safeAddress,
      safeVersion,
      chainId: BigInt(this.chainId),
      data: safeTransactionData,
    });
    if (!typedData?.domain || !typedData?.types || !typedData?.message) {
      throw new Error("Protocol Kit returned malformed Safe typed data");
    }
    const { EIP712Domain: _domainType, ...types } = typedData.types;
    const signature = await this.proposalIdentity.proposeSafeTransaction({
      domain: typedData.domain,
      types,
      message: typedData.message,
    }, { chainId: this.chainId });
    if (!/^0x[0-9a-fA-F]{130}$/.test(String(signature))) {
      throw new Error("The proposal identity returned a malformed Safe signature");
    }
    return {
      safeAddress: this.safeAddress,
      chainId: this.chainId,
      safeNonce: String(nonce),
      safeTransactionData,
      safeTxHash: String(safeTxHash),
      senderAddress: getAddress(await this.proposalIdentity.address()),
      senderSignature: signature,
    };
  }

  async prepare(validated, options = {}) {
    this.#assertIntent(validated);
    await this.#assertAuthorized();
    const rawNonce = options.safeNonce ?? await this.#apiKit.getNextNonce(this.safeAddress);
    if (!/^\d+$/.test(String(rawNonce))) throw new Error("Safe API Kit returned an unusable nonce");
    const nonce = Number(rawNonce);
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("Safe API Kit returned an unusable nonce");
    return this.#build(validated, nonce);
  }

  async #normalizeTransaction(transaction) {
    const required = [
      "safeTxHash", "safe", "to", "data", "value", "operation", "nonce", "confirmations", "confirmationsRequired", "isExecuted",
    ];
    if (!transaction || required.some((field) => transaction[field] === undefined || transaction[field] === null)) {
      throw new Error("Safe API Kit returned a malformed Safe service transaction");
    }
    try {
      const safeTxHash = String(transaction.safeTxHash);
      if (!/^0x[0-9a-fA-F]{64}$/.test(safeTxHash)) throw new Error("hash");
      const data = String(transaction.data);
      if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) throw new Error("data");
      const value = String(transaction.value);
      BigInt(value);
      const nonce = String(transaction.nonce);
      if (!/^\d+$/.test(nonce)) throw new Error("nonce");
      const operation = Number(transaction.operation);
      if (!Number.isInteger(operation)) throw new Error("operation");
      const confirmationsRequired = Number(transaction.confirmationsRequired);
      if (!Number.isSafeInteger(confirmationsRequired) || confirmationsRequired <= 0) throw new Error("threshold");
      if (typeof transaction.isExecuted !== "boolean") throw new Error("execution status");
      if (
        transaction.isExecuted &&
        (typeof transaction.isSuccessful !== "boolean" ||
          !/^0x[0-9a-fA-F]{64}$/.test(String(transaction.transactionHash)))
      ) {
        throw new Error("executed transaction outcome");
      }
      const confirmations = transaction.confirmations;
      if (!Array.isArray(confirmations)) throw new Error("confirmations");
      const { safe, ownerSet, threshold, nonce: onchainNonce } = await this.#onchainSecurityState();
      const proposer = getAddress(await this.proposalIdentity.address());
      if (!transaction.proposedByDelegate || getAddress(transaction.proposedByDelegate) !== proposer) {
        throw new Error("transaction was not proposed by the configured proposal delegate");
      }
      const confirmedOwners = new Set();
      let onchainExecutionStatus = null;
      for (const confirmation of confirmations) {
        let owner;
        try { owner = getAddress(confirmation?.owner); } catch { throw new Error("confirmation owner"); }
        if (!ownerSet.has(owner)) throw new Error("confirmation is not from a current onchain Safe owner");
        confirmedOwners.add(owner);
      }
      if (transaction.isExecuted) {
        const safeProvider = safe.getSafeProvider?.();
        const external = safeProvider?.getExternalProvider?.();
        if (!safeProvider || typeof safeProvider.getTransaction !== "function" ||
            !external || typeof external.getTransactionReceipt !== "function") {
          throw new Error("onchain execution evidence is unavailable");
        }
        const transactionHash = String(transaction.transactionHash);
        const [chainTransaction, receipt] = await Promise.all([
          safeProvider.getTransaction(transactionHash),
          external.getTransactionReceipt({ hash: transactionHash }),
        ]);
        if (!chainTransaction || getAddress(chainTransaction.to) !== this.safeAddress) {
          throw new Error("execution transaction does not target the Safe");
        }
        if (!receipt) throw new Error("onchain execution receipt is unavailable");
        const receiptSucceeded = receipt.status === "success" || receipt.status === 1 || receipt.status === 1n || receipt.status === "0x1";
        if (!receiptSucceeded || !Array.isArray(receipt.logs)) {
          throw new Error("onchain execution receipt is not a successful mined Safe transaction");
        }
        const executionEvent = receipt.logs.flatMap((log) => {
          try {
            if (getAddress(log.address) !== this.safeAddress) return [];
            const parsed = SAFE_EXECUTION_EVENTS.parseLog({ topics: log.topics, data: log.data });
            return parsed && String(parsed.args.txHash).toLowerCase() === safeTxHash.toLowerCase() ? [parsed] : [];
          } catch { return []; }
        });
        if (executionEvent.length !== 1) throw new Error("onchain receipt has no unique expected Safe execution event");
        const eventSucceeded = executionEvent[0].name === "ExecutionSuccess";
        if (eventSucceeded !== transaction.isSuccessful) {
          throw new Error("service execution outcome conflicts with the onchain Safe execution event");
        }
        onchainExecutionStatus = eventSucceeded ? "success" : "failed";
      }
      return {
        ...transaction,
        safeTxHash,
        safe: getAddress(transaction.safe),
        to: getAddress(transaction.to),
        data,
        value,
        operation,
        nonce,
        confirmations,
        confirmationsRequired,
        proposedByDelegate: proposer,
        authoritativeConfirmations: confirmedOwners.size,
        onchainThreshold: threshold,
        onchainSafeNonce: onchainNonce,
        nonceConsumed: !transaction.isExecuted && Number(nonce) < onchainNonce,
        onchainExecutionStatus,
        isExecuted: transaction.isExecuted,
        chainId: this.chainId,
      };
    } catch (error) {
      if (error.message === "Safe API Kit returned a malformed Safe service transaction") throw error;
      throw new Error(`Safe API Kit returned a malformed Safe service transaction: ${error.message}`);
    }
  }

  #assertExpectedTransaction(transaction, safeTxHash, expected = {}) {
    const intent = expected.intent;
    try {
      if (
        transaction.safeTxHash.toLowerCase() !== String(safeTxHash).toLowerCase() ||
        transaction.safe !== this.safeAddress ||
        (expected.nonce !== undefined && transaction.nonce !== String(expected.nonce)) ||
        (intent && (
          transaction.to !== getAddress(intent.target) ||
          transaction.data.toLowerCase() !== String(intent.data).toLowerCase() ||
          BigInt(transaction.value) !== BigInt(intent.value) ||
          transaction.operation !== 0
        ))
      ) {
        throw new Error("mismatch");
      }
    } catch {
      throw new Error("Safe API Kit returned a different transaction than expected");
    }
    return transaction;
  }

  async lookupTransaction(safeTxHash, expected = {}) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(safeTxHash))) throw new Error("A valid safeTxHash is required");
    let transaction;
    try {
      transaction = await this.#apiKit.getTransaction(String(safeTxHash));
    } catch (error) {
      if (error?.statusCode === 404) return null;
      throw error;
    }
    if (!transaction) return null;
    return this.#assertExpectedTransaction(await this.#normalizeTransaction(transaction), safeTxHash, expected);
  }

  async getTransaction(safeTxHash, expected = {}) {
    const transaction = await this.lookupTransaction(safeTxHash, expected);
    if (!transaction) throw new Error(`The Safe Transaction Service does not know ${safeTxHash}`);
    return transaction;
  }

  async submit(validated, preparation, options = {}) {
    this.#assertIntent(validated);
    await this.#assertAuthorized();
    const rawNonce = preparation?.safeNonce;
    if (!/^\d+$/.test(String(rawNonce))) throw new Error("The Safe preparation has no usable nonce");
    const nonce = Number(rawNonce);
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("The Safe preparation has no usable nonce");
    const proposal = await this.#build(validated, nonce);
    if (String(preparation?.safeTxHash).toLowerCase() !== proposal.safeTxHash.toLowerCase()) {
      throw new Error("The Safe preparation was altered between prepare and submit");
    }
    await options.beforeProviderDispatch?.();
    try {
      await this.#apiKit.proposeTransaction({
        safeAddress: this.safeAddress,
        safeTransactionData: proposal.safeTransactionData,
        safeTxHash: proposal.safeTxHash,
        senderAddress: proposal.senderAddress,
        senderSignature: proposal.senderSignature,
        origin: options.origin,
      });
    } catch (error) {
      const status = Number(error?.statusCode ?? error?.status);
      if (status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status)) {
        error.submissionOutcome = "definitely-not-submitted";
      }
      throw error;
    }
    const transaction = await this.getTransaction(proposal.safeTxHash, {
      intent: this.#assertIntent(validated),
      nonce: proposal.safeNonce,
    });
    return { proposal, transaction };
  }
}

module.exports = { SafeProposalAuthorization, SafeProposalProvider };
