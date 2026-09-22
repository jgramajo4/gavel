/**
 * The wallet provider boundary.
 *
 * Everything above this line -- the TUI, the wizard, the execution layer --
 * talks about connecting, accounts, chains, capabilities, and asking for a
 * signature. Nothing above this line knows what a WalletConnect pairing topic
 * is, or where a keystore lives.
 *
 * Three transports implement the same contract:
 *
 *   ReadOnlyWalletProvider   an address and nothing else. A first-class,
 *                            fully supported configuration: Gavel monitors,
 *                            analyzes, recommends and prepares, and stops.
 *   LocalSignerWalletProvider  a signer the host already holds -- an encrypted
 *                            keystore or an environment-provided key. Gavel
 *                            never learns the material; it holds a signer
 *                            object and a *reference* to where it came from.
 *   WalletConnectProvider    a wallet the user controls in another app. The
 *                            preferred interactive path, because no key or
 *                            phrase ever enters Gavel.
 *
 * Two rules hold across all three:
 *
 * 1. `requestTransaction()` is not a general send. It takes a governance
 *    request carrying the `intentHash` of a ValidatedExecutionIntent, and the
 *    only caller in the system is the interactive execution adapter, which
 *    rebuilds that request from `validated.intent`. WalletConnect must not
 *    become a second way to get arbitrary calldata signed, and this is where
 *    that is refused.
 *
 * 2. Nothing here ever returns, stores, logs or renders signing material. A
 *    session is persisted as `{ topic, account, chainId, expiresAt }` and
 *    nothing else -- see `serializeWalletSession()`.
 */

const { getAddress } = require("ethers");

const { redactMessage } = require("../config/secrets");

/** How the user controls their wallet. Stored in config as `wallet.type`. */
const WalletConnectionType = Object.freeze({
  READ_ONLY: "read-only",
  LOCAL: "local",
  WALLET_CONNECT: "walletconnect",
});

/** What a connected wallet can actually do. Drives which execution modes are offered. */
const WalletCapability = Object.freeze({
  READ: "read",
  SIGN_MESSAGE: "signMessage",
  SIGN_TRANSACTION: "signTransaction",
  SEND_TRANSACTION: "sendTransaction",
});

const WalletConnectionState = Object.freeze({
  DISCONNECTED: "disconnected",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  EXPIRED: "expired",
});

/**
 * The error taxonomy. Each code names the layer that failed, because "wallet
 * error" tells a user nothing about what to do next.
 */
const WalletErrorCode = Object.freeze({
  NOT_CONNECTED: "WALLET_NOT_CONNECTED",
  SESSION_EXPIRED: "WALLET_SESSION_EXPIRED",
  USER_REJECTED: "WALLET_REQUEST_REJECTED",
  WRONG_CHAIN: "WALLET_WRONG_CHAIN",
  WRONG_ACCOUNT: "WALLET_WRONG_ACCOUNT",
  UNSUPPORTED: "WALLET_CAPABILITY_UNSUPPORTED",
  TRANSPORT_UNAVAILABLE: "WALLET_TRANSPORT_UNAVAILABLE",
  TRANSPORT_FAILED: "WALLET_TRANSPORT_FAILED",
  NOT_GOVERNANCE_REQUEST: "WALLET_NOT_GOVERNANCE_REQUEST",
});

class WalletError extends Error {
  constructor(code, message, detail = {}) {
    // Redacted on construction rather than at the log site: an error message
    // built from a transport's response is exactly where a session secret
    // would otherwise escape.
    super(redactMessage(message));
    this.name = "WalletError";
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}

const REQUIRED_PROVIDER_METHODS = Object.freeze([
  "connect",
  "disconnect",
  "getAccount",
  "getChainId",
  "getCapabilities",
  "getStatus",
  "requestSignature",
  "requestTransaction",
  // The guards callers rely on rather than reimplementing. Required so a
  // hand-rolled provider cannot silently skip the chain and account checks.
  "can",
  "assertChain",
  "assertAccount",
]);

function assertWalletProvider(provider) {
  if (!provider || typeof provider !== "object") throw new TypeError("A wallet provider is required");
  if (!Object.values(WalletConnectionType).includes(provider.type)) {
    throw new TypeError(`Unknown wallet provider type: ${provider?.type}`);
  }
  for (const method of REQUIRED_PROVIDER_METHODS) {
    if (typeof provider[method] !== "function") {
      throw new TypeError(`Wallet provider ${provider.type} is missing ${method}()`);
    }
  }
  return provider;
}

/**
 * A validated intent hash, in either form the codebase uses: canonical
 * intents carry a `0x` prefix, prepared-transaction documents do not.
 */
const INTENT_HASH_PATTERN = /^(?:0x)?[0-9a-f]{64}$/i;

/**
 * The gate on `requestTransaction()`.
 *
 * A request without a validated intent hash is not a governance action, and a
 * wallet provider is not a transaction bus. This is what stops the wallet
 * transport from becoming an alternate arbitrary-call path around the
 * canonical adapter -> intent -> validation pipeline.
 */
function assertGovernanceTransactionRequest(request) {
  if (!request || typeof request !== "object") {
    throw new WalletError(WalletErrorCode.NOT_GOVERNANCE_REQUEST, "A transaction request is required");
  }
  if (!INTENT_HASH_PATTERN.test(String(request.intentHash || ""))) {
    throw new WalletError(
      WalletErrorCode.NOT_GOVERNANCE_REQUEST,
      "A wallet provider submits only Gavel-validated governance intents. " +
        "This request carries no validated intent hash.",
    );
  }
  if (!Number.isInteger(Number(request.chainId)) || Number(request.chainId) <= 0) {
    throw new WalletError(WalletErrorCode.NOT_GOVERNANCE_REQUEST, "A governance request needs a chain id");
  }
  return {
    intentHash: String(request.intentHash),
    chainId: Number(request.chainId),
    from: getAddress(request.from),
    to: getAddress(request.to),
    value: String(request.value ?? "0"),
    data: String(request.data ?? "0x"),
  };
}

/**
 * The persistable shape of a wallet session.
 *
 * This is the whole of what may be written to GAVEL_DATA_DIR. A WalletConnect
 * session also has a relay symmetric key and a pairing secret; neither appears
 * here, and neither is accepted -- unknown keys are dropped rather than copied,
 * so a transport that returns extra fields cannot widen what gets persisted.
 */
function serializeWalletSession(session) {
  if (!session) return null;
  return {
    topic: session.topic ? String(session.topic) : null,
    account: session.account ? getAddress(session.account) : null,
    chainId: session.chainId != null ? Number(session.chainId) : null,
    expiresAt: session.expiresAt ? String(session.expiresAt) : null,
  };
}

/** A short, safe label for a session topic: a session id is not a secret, but it is not useful in full either. */
function formatSessionTopic(topic) {
  const text = String(topic || "");
  if (text.length <= 12) return text;
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

/** `0x1234…abcd`. The only address form the TUI renders in lists. */
function shortAddress(address) {
  if (!address) return "—";
  const checksummed = getAddress(address);
  return `${checksummed.slice(0, 6)}…${checksummed.slice(-4)}`;
}

/**
 * Base class: status assembly, capability checks, chain/account assertions.
 *
 * Subclasses implement the transport-specific parts only, which is what keeps
 * the three providers genuinely substitutable rather than similar-looking.
 */
class BaseWalletProvider {
  constructor(options = {}) {
    this.chainId = options.chainId != null ? Number(options.chainId) : null;
    this.now = options.now || (() => new Date());
    this._state = WalletConnectionState.DISCONNECTED;
    this._account = options.address ? getAddress(options.address) : null;
  }

  getCapabilities() {
    return [WalletCapability.READ];
  }

  can(capability) {
    return this.getCapabilities().includes(capability);
  }

  async getAccount() {
    return this._account;
  }

  async getChainId() {
    return this.chainId;
  }

  /**
   * The view model the TUI renders. Deliberately the only way to ask a
   * provider about itself, so every surface shows the same fields and none of
   * them reaches into a transport for something extra.
   */
  async getStatus() {
    const account = await this.getAccount();
    return {
      type: this.type,
      state: this._state,
      account,
      accountShort: account ? shortAddress(account) : null,
      chainId: await this.getChainId(),
      capabilities: this.getCapabilities(),
      canSign: this.can(WalletCapability.SIGN_TRANSACTION) || this.can(WalletCapability.SEND_TRANSACTION),
      description: this.describe(),
      session: null,
    };
  }

  describe() {
    return this.type;
  }

  assertCapability(capability, what) {
    if (!this.can(capability)) {
      throw new WalletError(
        WalletErrorCode.UNSUPPORTED,
        `This wallet connection cannot ${what}.`,
        { type: this.type, capability },
      );
    }
  }

  async assertChain(chainId) {
    const connected = await this.getChainId();
    if (connected != null && Number(chainId) !== Number(connected)) {
      throw new WalletError(
        WalletErrorCode.WRONG_CHAIN,
        `Connected wallet is on chain ${connected}; this action requires chain ${chainId}.`,
        { connectedChainId: Number(connected), requiredChainId: Number(chainId) },
      );
    }
  }

  async assertAccount(address) {
    const account = await this.getAccount();
    if (!account) {
      throw new WalletError(WalletErrorCode.NOT_CONNECTED, "No wallet is connected.", { type: this.type });
    }
    if (getAddress(address) !== account) {
      throw new WalletError(
        WalletErrorCode.WRONG_ACCOUNT,
        `Connected wallet is ${shortAddress(account)}; this action must be signed by ${shortAddress(address)}.`,
        { connected: account, required: getAddress(address) },
      );
    }
  }
}

module.exports = {
  BaseWalletProvider,
  REQUIRED_PROVIDER_METHODS,
  WalletCapability,
  WalletConnectionState,
  WalletConnectionType,
  WalletError,
  WalletErrorCode,
  assertGovernanceTransactionRequest,
  assertWalletProvider,
  formatSessionTopic,
  serializeWalletSession,
  shortAddress,
};
