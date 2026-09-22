/**
 * Interactive execution: Gavel prepares, a human approves in their own wallet.
 *
 *   ValidatedExecutionIntent
 *       -> rebuild the exact call from `validated.intent`
 *       -> present it to the connected wallet
 *       -> the human approves or rejects, in their wallet, out of Gavel's reach
 *       -> EXECUTING / EXECUTED, or CANCELLED on rejection
 *
 * This adapter holds no credential. That is the whole point of it: the other
 * supervised mode holds a Gavel key that can propose into a queue, and the
 * autonomous mode holds a key that can broadcast. Here the key is in the
 * user's wallet app and Gavel only ever hands over a request, so there is
 * nothing to store, nothing to leak and nothing to revoke.
 *
 * The request is rebuilt from `validated.intent` at submit time and never read
 * out of the preparation payload, for the same reason the other adapters do
 * it: a caller can synthesize a look-alike preparation carrying a genuine
 * validated intent beside an attacker-chosen request. The wallet boundary
 * additionally refuses any request that does not carry a validated intent
 * hash, so this transport cannot become a second, unvalidated way to get
 * calldata signed.
 *
 * A rejection is a normal outcome, not an error. A user declining in their
 * wallet is the mode working, so it lands as CANCELLED with a reason rather
 * than as a thrown failure that looks like a bug.
 */

const { getAddress } = require("ethers");

const { ExecutionMode } = require("../../schema/execution");
const { ExecutionEvent } = require("../events");
const { ExecutionState } = require("../lifecycle");
const { assertPreparable, assertSubmittable, executionPreparation } = require("../adapter");
const {
  WalletCapability,
  WalletError,
  WalletErrorCode,
  assertWalletProvider,
} = require("../../wallet/provider");

class InteractiveWalletExecutionAdapter {
  #wallet;

  /**
   * @param {object} options
   * @param {object} options.wallet   a wallet provider (WalletConnect or local signer)
   * @param {number} options.chainId
   */
  constructor(options) {
    this.mode = ExecutionMode.EOA_SUPERVISED;
    this.chainId = Number(options?.chainId);
    if (!Number.isInteger(this.chainId) || this.chainId <= 0) {
      throw new TypeError("Interactive execution requires a chain id");
    }
    this.client = options?.client || null;
    this.#wallet = assertWalletProvider(options?.wallet);
    if (!this.#wallet.can(WalletCapability.SEND_TRANSACTION)) {
      throw new WalletError(
        WalletErrorCode.UNSUPPORTED,
        "Interactive execution needs a wallet that can submit transactions. " +
          "A read-only connection prepares votes but cannot cast them.",
        { type: this.#wallet.type },
      );
    }
  }

  get walletType() {
    return this.#wallet.type;
  }

  async getExecutionAddress() {
    const account = await this.#wallet.getAccount();
    if (!account) throw new WalletError(WalletErrorCode.NOT_CONNECTED, "No wallet is connected.");
    return getAddress(account);
  }

  /**
   * Check the connection *before* anything is presented, so a user is told
   * "your wallet is on chain 8453, this vote needs chain 1" instead of being
   * shown a request their wallet will refuse.
   */
  async #assertUsable(intent) {
    if (intent.chainId !== this.chainId) {
      throw new Error(`The validated intent is for chain ${intent.chainId}, not ${this.chainId}`);
    }
    await this.#wallet.assertChain(intent.chainId);
    await this.#wallet.assertAccount(intent.actor);
  }

  async prepare(validated) {
    const intent = assertPreparable(this, validated).intent;
    if (intent.operation !== "CALL") throw new Error("Interactive mode executes CALL operations only");
    await this.#assertUsable(intent);
    const status = await this.#wallet.getStatus();
    return executionPreparation(
      this,
      validated,
      {
        request: {
          chainId: this.chainId,
          from: getAddress(intent.actor),
          to: getAddress(intent.target),
          value: intent.value,
          data: intent.data,
          intentHash: validated.intentHash,
        },
        wallet: { type: status.type, account: status.account, chainId: status.chainId },
        intentHash: validated.intentHash,
      },
      { providerData: { providerStatus: "awaiting-human-approval" } },
    );
  }

  async submit(preparation) {
    const { validated } = assertSubmittable(this, preparation);
    const intent = validated.intent;
    await this.#assertUsable(intent);

    let response;
    try {
      response = await this.#wallet.requestTransaction({
        chainId: intent.chainId,
        from: getAddress(intent.actor),
        to: getAddress(intent.target),
        value: intent.value,
        data: intent.data,
        intentHash: validated.intentHash,
      });
    } catch (error) {
      if (error instanceof WalletError && error.code === WalletErrorCode.USER_REJECTED) {
        return {
          state: ExecutionState.CANCELLED,
          providerData: { providerStatus: "rejected-by-human" },
          events: [
            {
              name: ExecutionEvent.EXECUTION_FAILED,
              detail: { reasonCode: error.code, message: "The wallet owner declined this vote." },
            },
          ],
        };
      }
      throw error;
    }

    const transactionHash = response?.transactionHash || response?.hash || null;
    if (!transactionHash) throw new Error("The connected wallet returned no transaction hash");
    return {
      state: ExecutionState.EXECUTING,
      providerData: { transactionHash: String(transactionHash), providerStatus: "approved-by-human" },
      events: [
        { name: ExecutionEvent.EXECUTION_AUTHORIZED, detail: { reasonCode: "HUMAN_APPROVED" } },
        { name: ExecutionEvent.EXECUTION_SUBMITTED, detail: { transactionHash: String(transactionHash) } },
      ],
    };
  }

  async status(record) {
    const transactionHash = record?.providerData?.transactionHash;
    if (!transactionHash) {
      // Nothing was submitted. Saying so is more useful than inventing a state:
      // the human may simply not have opened their wallet yet.
      return { state: ExecutionState.AWAITING_AUTHORIZATION, providerData: record?.providerData || {} };
    }
    if (typeof this.client?.getTransactionStatus !== "function") {
      return { state: ExecutionState.EXECUTING, providerData: { transactionHash } };
    }
    const reported = await this.client.getTransactionStatus(transactionHash);
    const state =
      reported?.status === "success"
        ? ExecutionState.EXECUTED
        : reported?.status === "failed"
          ? ExecutionState.FAILED
          : ExecutionState.EXECUTING;
    return { state, providerData: { transactionHash } };
  }
}

module.exports = { InteractiveWalletExecutionAdapter };
