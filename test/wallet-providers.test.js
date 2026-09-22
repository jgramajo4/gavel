const assert = require("node:assert/strict");
const test = require("node:test");
const { Wallet, getAddress } = require("ethers");

const {
  LocalSignerWalletProvider,
  ReadOnlyWalletProvider,
  WalletCapability,
  WalletConnectProvider,
  WalletConnectionState,
  WalletConnectionType,
  WalletError,
  WalletErrorCode,
  assertGovernanceTransactionRequest,
  assertWalletProvider,
  hasWalletConnectTransport,
  listWalletMethods,
  registerWalletConnectTransport,
  resetWalletConnectTransports,
  serializeWalletSession,
  shortAddress,
} = require("../packages/core");

const SENTINEL_SYMKEY = "0x" + "ef".repeat(32);
const ACCOUNT = getAddress("0x2222222222222222222222222222222222222222");
const OTHER = getAddress("0x3333333333333333333333333333333333333333");
const GOVERNOR = getAddress("0x4444444444444444444444444444444444444444");
const INTENT_HASH = "a".repeat(64);

function governanceRequest(overrides = {}) {
  return {
    chainId: 1,
    from: ACCOUNT,
    to: GOVERNOR,
    value: "0",
    data: "0x1234",
    intentHash: INTENT_HASH,
    ...overrides,
  };
}

/**
 * A fake WalletConnect transport. Everything protocol-shaped lives behind this
 * interface, which is exactly why the session state machine is testable with
 * no relay, no network and no crypto.
 */
function fakeTransport(options = {}) {
  const calls = [];
  return {
    calls,
    async connect() {
      if (options.rejectConnection) return { rejected: true };
      return {
        topic: "topic-0123456789abcdef",
        account: options.account || ACCOUNT,
        chainId: options.chainId ?? 1,
        expiresAt: options.expiresAt || new Date(Date.now() + 3_600_000).toISOString(),
        // A real transport also hands back relay secrets. They must not survive.
        symKey: SENTINEL_SYMKEY,
        relay: { protocol: "irn", key: SENTINEL_SYMKEY },
      };
    },
    async request(payload) {
      calls.push(payload);
      if (options.rejectRequest) {
        const error = new Error("User rejected the request");
        error.code = "4001";
        throw error;
      }
      if (options.expireRequest) throw new Error("session topic doesn't exist");
      if (options.failRequest) throw new Error(`relay failure with symKey ${SENTINEL_SYMKEY}`);
      return options.response ?? "0xdeadbeefcafe";
    },
    async disconnect() {
      calls.push({ method: "disconnect" });
      if (options.failDisconnect) throw new Error("relay unreachable");
    },
  };
}

test("all three transports satisfy one provider contract", () => {
  const signer = Wallet.createRandom();
  const providers = [
    new ReadOnlyWalletProvider({ address: ACCOUNT, chainId: 1 }),
    new LocalSignerWalletProvider({
      signer: { address: async () => signer.address, signTypedData: async () => "0xsig" },
      chainId: 1,
      source: { kind: "environment", variable: "GAVEL_PRIVATE_KEY" },
    }),
    new WalletConnectProvider({ transport: fakeTransport(), chainId: 1 }),
  ];
  for (const provider of providers) assert.equal(assertWalletProvider(provider), provider);
  assert.throws(() => assertWalletProvider({ type: "invented" }), /Unknown wallet provider type/);
  assert.throws(
    () => assertWalletProvider({ type: WalletConnectionType.READ_ONLY }),
    /is missing connect\(\)/,
  );
});

test("read-only is a supported configuration, not a broken one", async () => {
  const provider = new ReadOnlyWalletProvider({ address: ACCOUNT, chainId: 1 });
  const status = await provider.getStatus();
  assert.equal(status.state, WalletConnectionState.CONNECTED);
  assert.equal(status.account, ACCOUNT);
  assert.equal(status.canSign, false);
  assert.deepEqual(status.capabilities, [WalletCapability.READ]);
  // The refusal explains the configuration rather than looking like a bug.
  await assert.rejects(provider.requestTransaction(governanceRequest()), (error) => {
    assert.equal(error.code, WalletErrorCode.UNSUPPORTED);
    assert.match(error.message, /cannot submit transactions/);
    return true;
  });
});

test("a local signer is a reference, never material", async () => {
  const signer = Wallet.createRandom();
  const broadcasts = [];
  const provider = new LocalSignerWalletProvider({
    signer: { address: async () => signer.address, signTypedData: async () => "0xsig" },
    broadcaster: { broadcast: async (request) => (broadcasts.push(request), { transactionHash: "0xabc" }) },
    chainId: 1,
    source: { kind: "environment", variable: "GAVEL_PRIVATE_KEY" },
  });
  const status = await provider.getStatus();
  assert.equal(status.account, getAddress(signer.address));
  assert.equal(status.canSign, true);
  assert.deepEqual(status.signerSource, { kind: "environment", variable: "GAVEL_PRIVATE_KEY", label: null });
  // The status line shows "environment / GAVEL_PRIVATE_KEY", and nothing else.
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes(signer.privateKey));
  assert.match(provider.describe(), /environment: GAVEL_PRIVATE_KEY/);

  const result = await provider.requestTransaction(
    governanceRequest({ from: getAddress(signer.address) }),
  );
  assert.equal(result.transactionHash, "0xabc");
  assert.equal(broadcasts[0].intentHash, INTENT_HASH);

  assert.throws(
    () => new LocalSignerWalletProvider({ chainId: 1 }),
    /requires a signing identity/,
  );
});

test("a WalletConnect session persists only topic, account, chain and expiry", async () => {
  const provider = new WalletConnectProvider({ transport: fakeTransport(), chainId: 1 });
  const status = await provider.connect();
  assert.equal(status.state, WalletConnectionState.CONNECTED);
  assert.equal(status.account, ACCOUNT);
  assert.equal(status.canSign, true);

  const session = provider.session;
  assert.deepEqual(Object.keys(session).sort(), ["account", "chainId", "expiresAt", "topic"]);
  const serialized = JSON.stringify({ session, status });
  assert.ok(!serialized.includes(SENTINEL_SYMKEY), "a relay key must never be persisted or rendered");
  // The rendered topic is shortened; a full topic is not useful in a status line.
  assert.match(status.session.topic, /^topic-…cdef$/);

  // Unknown keys are dropped rather than copied, so a transport returning more
  // cannot widen what gets written to GAVEL_DATA_DIR.
  assert.deepEqual(
    serializeWalletSession({ topic: "t", account: ACCOUNT, chainId: 1, expiresAt: null, symKey: SENTINEL_SYMKEY }),
    { topic: "t", account: ACCOUNT, chainId: 1, expiresAt: null },
  );
});

test("a rejected connection is a clear refusal, not a transport error", async () => {
  const provider = new WalletConnectProvider({ transport: fakeTransport({ rejectConnection: true }) });
  await assert.rejects(provider.connect(), (error) => {
    assert.equal(error.code, WalletErrorCode.USER_REJECTED);
    return true;
  });
  const status = await provider.getStatus();
  assert.equal(status.state, WalletConnectionState.DISCONNECTED);
});

test("a rejected signature, an expired session, and a reconnect", async () => {
  const rejecting = new WalletConnectProvider({ transport: fakeTransport({ rejectRequest: true }) });
  await rejecting.connect();
  await assert.rejects(rejecting.requestTransaction(governanceRequest()), (error) => {
    assert.equal(error.code, WalletErrorCode.USER_REJECTED);
    return true;
  });

  // Expiry detected from the clock, before the transport is touched.
  const expired = new WalletConnectProvider({
    transport: fakeTransport(),
    session: {
      topic: "t",
      account: ACCOUNT,
      chainId: 1,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const expiredStatus = await expired.getStatus();
  assert.equal(expiredStatus.state, WalletConnectionState.EXPIRED);
  assert.equal(expiredStatus.session.expired, true);
  await assert.rejects(expired.requestTransaction(governanceRequest()), (error) => {
    assert.equal(error.code, WalletErrorCode.SESSION_EXPIRED);
    assert.match(error.message, /Reconnect your wallet/);
    return true;
  });
  // Reconnecting clears it.
  const reconnected = await expired.connect();
  assert.equal(reconnected.state, WalletConnectionState.CONNECTED);

  // Expiry reported by the transport mid-request is recognized too.
  const serverExpired = new WalletConnectProvider({ transport: fakeTransport({ expireRequest: true }) });
  await serverExpired.connect();
  await assert.rejects(serverExpired.requestTransaction(governanceRequest()), (error) => {
    assert.equal(error.code, WalletErrorCode.SESSION_EXPIRED);
    return true;
  });
});

test("wrong chain and wrong account are named, with what to do about it", async () => {
  const provider = new WalletConnectProvider({ transport: fakeTransport({ chainId: 8453 }) });
  await provider.connect();
  await assert.rejects(provider.requestTransaction(governanceRequest({ chainId: 1 })), (error) => {
    assert.equal(error.code, WalletErrorCode.WRONG_CHAIN);
    assert.match(error.message, /on chain 8453; this action requires chain 1/);
    return true;
  });

  const other = new WalletConnectProvider({ transport: fakeTransport() });
  await other.connect();
  await assert.rejects(other.requestTransaction(governanceRequest({ from: OTHER })), (error) => {
    assert.equal(error.code, WalletErrorCode.WRONG_ACCOUNT);
    assert.match(error.message, new RegExp(shortAddress(OTHER)));
    return true;
  });
});

test("disconnect ends the local session even when the relay fails", async () => {
  const provider = new WalletConnectProvider({ transport: fakeTransport({ failDisconnect: true }) });
  await provider.connect();
  const status = await provider.disconnect();
  assert.equal(status.state, WalletConnectionState.DISCONNECTED);
  assert.equal(provider.session, null);
  await assert.rejects(provider.requestTransaction(governanceRequest()), (error) => {
    assert.equal(error.code, WalletErrorCode.NOT_CONNECTED);
    return true;
  });
});

test("a wallet provider is not an arbitrary transaction bus", async () => {
  // The invariant that stops WalletConnect becoming a second path around the
  // adapter -> intent -> validation pipeline.
  assert.throws(
    () => assertGovernanceTransactionRequest({ chainId: 1, from: ACCOUNT, to: GOVERNOR, data: "0xdead" }),
    (error) => {
      assert.equal(error.code, WalletErrorCode.NOT_GOVERNANCE_REQUEST);
      assert.match(error.message, /only Gavel-validated governance intents/);
      return true;
    },
  );
  assert.throws(
    () => assertGovernanceTransactionRequest({ ...governanceRequest(), intentHash: "not-a-hash" }),
    (error) => error.code === WalletErrorCode.NOT_GOVERNANCE_REQUEST,
  );

  const provider = new WalletConnectProvider({ transport: fakeTransport() });
  await provider.connect();
  await assert.rejects(provider.requestTransaction({ chainId: 1, from: ACCOUNT, to: OTHER, data: "0xdead" }));
});

test("transport failure messages cannot leak session material", async () => {
  const provider = new WalletConnectProvider({ transport: fakeTransport({ failRequest: true }) });
  await provider.connect();
  await assert.rejects(provider.requestTransaction(governanceRequest()), (error) => {
    assert.equal(error.code, WalletErrorCode.TRANSPORT_FAILED);
    assert.ok(!error.message.includes(SENTINEL_SYMKEY));
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
});

test("the wizard is offered only wallet methods this build can actually use", (t) => {
  t.after(() => resetWalletConnectTransports());
  resetWalletConnectTransports();

  const withoutTransport = listWalletMethods({ env: {} });
  const walletConnect = withoutTransport.find((m) => m.type === WalletConnectionType.WALLET_CONNECT);
  // Shown, not hidden: a missing option looks like Gavel does not support it.
  assert.equal(walletConnect.available, false);
  assert.match(walletConnect.blockers.join(" "), /No WalletConnect transport/);
  assert.match(walletConnect.blockers.join(" "), /WALLETCONNECT_PROJECT_ID/);
  assert.equal(walletConnect.recommended, true);
  // Read-only is always available.
  assert.equal(withoutTransport.find((m) => m.type === WalletConnectionType.READ_ONLY).available, true);
  // A local signer needs a keystore or a host-provided variable.
  const local = withoutTransport.find((m) => m.type === WalletConnectionType.LOCAL);
  assert.equal(local.available, false);
  assert.match(local.blockers.join(" "), /gavel identity create/);
  assert.ok(!JSON.stringify(withoutTransport).includes(SENTINEL_SYMKEY));

  registerWalletConnectTransport("test", () => fakeTransport());
  assert.equal(hasWalletConnectTransport(), true);
  const ready = listWalletMethods({ env: { WALLETCONNECT_PROJECT_ID: "project", GAVEL_PRIVATE_KEY: "0x" + "11".repeat(32) } });
  assert.equal(ready.find((m) => m.type === WalletConnectionType.WALLET_CONNECT).available, true);
  assert.equal(ready.find((m) => m.type === WalletConnectionType.LOCAL).available, true);
});

test("a WalletConnect provider refuses to exist without a transport", () => {
  assert.throws(() => new WalletConnectProvider({}), (error) => {
    assert.ok(error instanceof WalletError);
    assert.equal(error.code, WalletErrorCode.TRANSPORT_UNAVAILABLE);
    return true;
  });
});
