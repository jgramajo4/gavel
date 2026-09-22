/**
 * The three wallet transports.
 *
 * They differ only in where authority lives: nowhere (read-only), in a signer
 * the host already holds (local), or in an app the user controls
 * (WalletConnect). Everything else -- capability checks, chain and account
 * assertions, status shape -- is the base class, so a fourth transport is a
 * class, not a refactor.
 */

const { getAddress } = require("ethers");

const { SecretSource, SecretStatus, resolveSecretStatus } = require("../config/secrets");
const {
  BaseWalletProvider,
  WalletCapability,
  WalletConnectionState,
  WalletConnectionType,
  WalletError,
  WalletErrorCode,
  assertGovernanceTransactionRequest,
  formatSessionTopic,
  serializeWalletSession,
} = require("./provider");

/**
 * Read-only: an address, and no authority at all.
 *
 * Not a degraded mode. Monitoring, analysis, recommendation and intent
 * preparation are the majority of what Gavel does, and all of them work here.
 * The refusal to sign is explicit rather than a missing method, so the message
 * a user sees explains the configuration rather than looking like a bug.
 */
class ReadOnlyWalletProvider extends BaseWalletProvider {
  constructor(options = {}) {
    super(options);
    this.type = WalletConnectionType.READ_ONLY;
    this._state = options.address ? WalletConnectionState.CONNECTED : WalletConnectionState.DISCONNECTED;
  }

  describe() {
    return "Read-only (no signer attached)";
  }

  getCapabilities() {
    return [WalletCapability.READ];
  }

  async connect(options = {}) {
    if (options.address) this._account = getAddress(options.address);
    this._state = this._account ? WalletConnectionState.CONNECTED : WalletConnectionState.DISCONNECTED;
    return this.getStatus();
  }

  async disconnect() {
    this._state = WalletConnectionState.DISCONNECTED;
    return this.getStatus();
  }

  async requestSignature() {
    this.assertCapability(WalletCapability.SIGN_MESSAGE, "sign messages");
  }

  async requestTransaction() {
    this.assertCapability(WalletCapability.SEND_TRANSACTION, "submit transactions");
  }
}

/**
 * A signer the host already holds.
 *
 * Gavel does not create, store or read key material here. It is handed a
 * signing identity (the same `assertSigningIdentity` contract the Safe and
 * WaaP paths use) plus a *reference* describing where it came from, and the
 * reference is the only part that is ever displayed or persisted:
 *
 *     Signer: environment
 *     Variable: GAVEL_PRIVATE_KEY
 *     Status: configured
 *
 * Preference order is keystore first, environment second, because an encrypted
 * keystore is revocable and an exported environment variable is visible to
 * every child process. A seed phrase is not a supported source in either.
 */
class LocalSignerWalletProvider extends BaseWalletProvider {
  #signer;
  #broadcaster;

  constructor(options = {}) {
    super(options);
    this.type = WalletConnectionType.LOCAL;
    if (!options.signer || typeof options.signer.address !== "function") {
      throw new TypeError("A local wallet requires a signing identity with address()");
    }
    this.#signer = options.signer;
    this.#broadcaster = options.broadcaster || null;
    // `source` is a reference, never a value: { kind, variable?, label? }.
    this.source = Object.freeze({
      kind: options.source?.kind === "keystore" ? SecretSource.KEYSTORE : SecretSource.ENVIRONMENT,
      variable: options.source?.variable || null,
      label: options.source?.label || null,
    });
    this._state = WalletConnectionState.CONNECTED;
  }

  describe() {
    if (this.source.kind === SecretSource.KEYSTORE) {
      return `Local signer (encrypted keystore${this.source.label ? `: ${this.source.label}` : ""})`;
    }
    return `Local signer (environment${this.source.variable ? `: ${this.source.variable}` : ""})`;
  }

  getCapabilities() {
    const capabilities = [WalletCapability.READ, WalletCapability.SIGN_MESSAGE, WalletCapability.SIGN_TRANSACTION];
    if (this.#broadcaster) capabilities.push(WalletCapability.SEND_TRANSACTION);
    return capabilities;
  }

  async getAccount() {
    if (!this._account) this._account = getAddress(await this.#signer.address());
    return this._account;
  }

  async connect() {
    await this.getAccount();
    this._state = WalletConnectionState.CONNECTED;
    return this.getStatus();
  }

  async disconnect() {
    this._state = WalletConnectionState.DISCONNECTED;
    return this.getStatus();
  }

  async getStatus() {
    return { ...(await super.getStatus()), signerSource: this.source };
  }

  async requestSignature(payload) {
    this.assertCapability(WalletCapability.SIGN_MESSAGE, "sign messages");
    await this.assertChain(payload?.domain?.chainId ?? this.chainId);
    return this.#signer.signTypedData(payload.domain, payload.types, payload.message);
  }

  async requestTransaction(request) {
    this.assertCapability(WalletCapability.SEND_TRANSACTION, "submit transactions");
    const governance = assertGovernanceTransactionRequest(request);
    await this.assertChain(governance.chainId);
    await this.assertAccount(governance.from);
    return this.#broadcaster.broadcast(governance);
  }
}

/**
 * WalletConnect.
 *
 * The protocol lives behind a `transport`, injected. Core holds the session
 * state machine -- connect, expiry, disconnect, rejection, wrong chain, wrong
 * account, reconnect -- and nothing else, so there is no relay client, no
 * crypto and no networking inside a screen component.
 *
 * Sessions are assumed to be temporary. Every request re-checks expiry against
 * the clock *before* the transport is touched, so an expired session produces
 * `WALLET_SESSION_EXPIRED` and a reconnect prompt rather than an opaque
 * transport failure.
 */
class WalletConnectProvider extends BaseWalletProvider {
  #transport;

  constructor(options = {}) {
    super(options);
    this.type = WalletConnectionType.WALLET_CONNECT;
    if (!options.transport || typeof options.transport.connect !== "function") {
      throw new WalletError(
        WalletErrorCode.TRANSPORT_UNAVAILABLE,
        "WalletConnect needs a transport. Configure a WalletConnect project id and transport to use it.",
      );
    }
    this.#transport = options.transport;
    this._session = options.session ? serializeWalletSession(options.session) : null;
    this._account = this._session?.account || null;
    this.chainId = this._session?.chainId ?? this.chainId;
    this._state = this._session ? WalletConnectionState.CONNECTED : WalletConnectionState.DISCONNECTED;
    if (this._session) this.#refreshExpiry();
  }

  describe() {
    return "WalletConnect";
  }

  getCapabilities() {
    if (this._state !== WalletConnectionState.CONNECTED) return [WalletCapability.READ];
    return [
      WalletCapability.READ,
      WalletCapability.SIGN_MESSAGE,
      WalletCapability.SIGN_TRANSACTION,
      WalletCapability.SEND_TRANSACTION,
    ];
  }

  /** The persisted session: topic, account, chain, expiry. Never a relay key. */
  get session() {
    return this._session ? { ...this._session } : null;
  }

  #refreshExpiry() {
    if (!this._session?.expiresAt) return;
    if (Date.parse(this._session.expiresAt) <= this.now().getTime()) {
      this._state = WalletConnectionState.EXPIRED;
    }
  }

  #assertLive() {
    this.#refreshExpiry();
    if (this._state === WalletConnectionState.EXPIRED) {
      throw new WalletError(
        WalletErrorCode.SESSION_EXPIRED,
        "The WalletConnect session expired. Reconnect your wallet to continue.",
        { topic: formatSessionTopic(this._session?.topic) },
      );
    }
    if (this._state !== WalletConnectionState.CONNECTED || !this._account) {
      throw new WalletError(WalletErrorCode.NOT_CONNECTED, "No wallet is connected over WalletConnect.");
    }
  }

  async connect(options = {}) {
    this._state = WalletConnectionState.CONNECTING;
    let result;
    try {
      result = await this.#transport.connect({
        chainId: options.chainId ?? this.chainId,
        // A pairing URI is displayed to the user (a QR string); it authorizes
        // nothing on its own and expires with the proposal.
        onUri: options.onUri,
      });
    } catch (error) {
      this._state = WalletConnectionState.DISCONNECTED;
      if (error instanceof WalletError) throw error;
      throw new WalletError(
        WalletErrorCode.TRANSPORT_FAILED,
        `WalletConnect pairing failed: ${error?.message || "unknown transport failure"}`,
      );
    }
    if (result?.rejected === true) {
      this._state = WalletConnectionState.DISCONNECTED;
      throw new WalletError(WalletErrorCode.USER_REJECTED, "The wallet rejected the connection request.");
    }
    this._session = serializeWalletSession(result);
    this._account = this._session.account;
    this.chainId = this._session.chainId;
    this._state = WalletConnectionState.CONNECTED;
    this.#refreshExpiry();
    return this.getStatus();
  }

  async disconnect() {
    try {
      if (typeof this.#transport.disconnect === "function") {
        await this.#transport.disconnect({ topic: this._session?.topic || null });
      }
    } catch {
      // A disconnect that fails remotely still ends the local session: the
      // alternative is a UI that claims a wallet is attached when it is not.
    }
    this._session = null;
    this._account = null;
    this._state = WalletConnectionState.DISCONNECTED;
    return this.getStatus();
  }

  async getStatus() {
    this.#refreshExpiry();
    const status = await super.getStatus();
    return {
      ...status,
      state: this._state,
      session: this._session
        ? {
            topic: formatSessionTopic(this._session.topic),
            expiresAt: this._session.expiresAt,
            expired: this._state === WalletConnectionState.EXPIRED,
          }
        : null,
    };
  }

  async #request(method, params, { chainId, from } = {}) {
    this.#assertLive();
    if (chainId != null) await this.assertChain(chainId);
    if (from) await this.assertAccount(from);
    let response;
    try {
      response = await this.#transport.request({ topic: this._session.topic, method, params, chainId });
    } catch (error) {
      if (error instanceof WalletError) throw error;
      const code = String(error?.code ?? "");
      const message = String(error?.message || "");
      // 4001 is the EIP-1193 user-rejection code; wallets also phrase it in
      // prose, which is why both are recognized.
      if (code === "4001" || /reject|denied|cancell?ed/i.test(message)) {
        throw new WalletError(WalletErrorCode.USER_REJECTED, "The wallet rejected the request.");
      }
      if (/expired|no matching key|session topic doesn't exist/i.test(message)) {
        this._state = WalletConnectionState.EXPIRED;
        throw new WalletError(
          WalletErrorCode.SESSION_EXPIRED,
          "The WalletConnect session expired. Reconnect your wallet to continue.",
        );
      }
      throw new WalletError(WalletErrorCode.TRANSPORT_FAILED, `WalletConnect request failed: ${message}`);
    }
    return response;
  }

  async requestSignature(payload) {
    const chainId = payload?.domain?.chainId ?? this.chainId;
    const from = await this.getAccount();
    return this.#request("eth_signTypedData_v4", [from, payload], { chainId, from });
  }

  /**
   * Present a Gavel-validated governance transaction to the user's wallet.
   *
   * The request is gated on carrying a validated intent hash before the
   * transport sees it, so this cannot serve as a general-purpose send.
   */
  async requestTransaction(request) {
    const governance = assertGovernanceTransactionRequest(request);
    const response = await this.#request(
      "eth_sendTransaction",
      [
        {
          from: governance.from,
          to: governance.to,
          value: `0x${BigInt(governance.value).toString(16)}`,
          data: governance.data,
        },
      ],
      { chainId: governance.chainId, from: governance.from },
    );
    const transactionHash = typeof response === "string" ? response : response?.transactionHash || response?.hash;
    if (!transactionHash) {
      throw new WalletError(WalletErrorCode.TRANSPORT_FAILED, "The wallet returned no transaction hash.");
    }
    return { transactionHash: String(transactionHash), intentHash: governance.intentHash };
  }
}

/**
 * WalletConnect transports are registered by the host, not built here.
 *
 * Core carries the state machine; the relay client is a dependency a host
 * chooses. Until one is registered the wizard offers WalletConnect as
 * unavailable with a reason, rather than pretending it can pair.
 */
const transports = new Map();

function registerWalletConnectTransport(id, factory) {
  if (typeof factory !== "function") throw new TypeError("A WalletConnect transport factory is required");
  transports.set(String(id), factory);
  return id;
}

function hasWalletConnectTransport() {
  return transports.size > 0;
}

function createWalletConnectTransport(options = {}) {
  const [factory] = [...transports.values()];
  if (!factory) {
    throw new WalletError(
      WalletErrorCode.TRANSPORT_UNAVAILABLE,
      "No WalletConnect transport is registered in this build.",
    );
  }
  return factory(options);
}

/** Cleared between tests; never called by shipping code. */
function resetWalletConnectTransports() {
  transports.clear();
}

/**
 * Which wallet methods this runtime can actually offer, and why not.
 *
 * The wizard renders exactly this. An option that cannot work is shown
 * disabled with its reason rather than hidden, because a silently missing
 * WalletConnect option looks like Gavel does not support it.
 */
function listWalletMethods(options = {}) {
  const env = options.env || process.env;
  const projectId = resolveSecretStatus("walletconnect-project", { env });
  const transportReady = options.hasTransport ?? hasWalletConnectTransport();
  const walletConnectBlockers = [];
  if (!transportReady) walletConnectBlockers.push("No WalletConnect transport is registered in this build.");
  if (projectId.status !== SecretStatus.CONFIGURED) {
    walletConnectBlockers.push(`Set ${projectId.variable} to a WalletConnect project id.`);
  }
  const localSigner = resolveSecretStatus("execution-signer", { env });
  const keystoreAvailable = options.keystoreLabels?.length > 0;

  return [
    {
      type: WalletConnectionType.WALLET_CONNECT,
      label: "WalletConnect",
      summary: "Approve each action in your own wallet app. No key or phrase enters Gavel.",
      recommended: true,
      available: walletConnectBlockers.length === 0,
      blockers: walletConnectBlockers,
    },
    {
      type: WalletConnectionType.LOCAL,
      label: "Local wallet",
      summary: keystoreAvailable
        ? "Use an encrypted keystore Gavel already holds."
        : `Use a signer supplied by the host (${localSigner.variable}) or an encrypted keystore.`,
      recommended: false,
      available: keystoreAvailable || localSigner.status === SecretStatus.CONFIGURED,
      blockers:
        keystoreAvailable || localSigner.status === SecretStatus.CONFIGURED
          ? []
          : [
              `Create an encrypted keystore with \`gavel identity create\`, or provide ${localSigner.variable}.`,
            ],
      // Shown so the user sees the reference, never a value.
      signerSources: [
        { kind: SecretSource.KEYSTORE, available: keystoreAvailable, labels: options.keystoreLabels || [] },
        { kind: SecretSource.ENVIRONMENT, available: localSigner.status === SecretStatus.CONFIGURED, variable: localSigner.variable },
      ],
    },
    {
      type: WalletConnectionType.READ_ONLY,
      label: "Read-only",
      summary: "Follow, analyze and prepare votes. Gavel will not sign or broadcast.",
      recommended: false,
      available: true,
      blockers: [],
    },
  ];
}

function createWalletProvider(descriptor = {}) {
  if (descriptor.type === WalletConnectionType.LOCAL) return new LocalSignerWalletProvider(descriptor);
  if (descriptor.type === WalletConnectionType.WALLET_CONNECT) return new WalletConnectProvider(descriptor);
  return new ReadOnlyWalletProvider(descriptor);
}

module.exports = {
  LocalSignerWalletProvider,
  ReadOnlyWalletProvider,
  WalletConnectProvider,
  createWalletConnectTransport,
  createWalletProvider,
  hasWalletConnectTransport,
  listWalletMethods,
  registerWalletConnectTransport,
  resetWalletConnectTransports,
};
