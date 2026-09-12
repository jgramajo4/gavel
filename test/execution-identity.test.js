"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Wallet } = require("ethers");

const {
  Capability,
  ExecutionIdentity,
  ExecutionIdentitySet,
  IdentityRole,
  ProposalIdentity,
  assertExecutionIdentity,
  assertIdentityForRole,
  assertProposalIdentity,
  createExecutionIdentity,
  createProposalIdentity,
} = require("../packages/core/src/execution/identity/roles");
const {
  EnvironmentSigningIdentity,
  KeystoreSigningIdentity,
  RemoteSigningIdentity,
  SecretStoreSigningIdentity,
  SigningIdentity,
  assertSigningIdentity,
} = require("../packages/core/src/execution/identity/signing");

const SAFE = "0x0000000000000000000000000000000000000003";
const OTHER_SAFE = "0x0000000000000000000000000000000000000005";
const PROPOSER_KEY = `0x${"11".repeat(32)}`;
const EXECUTOR_KEY = `0x${"22".repeat(32)}`;
const SIGNATURE = `0x${"ab".repeat(65)}`;

function stubSigner(address, overrides = {}) {
  return {
    async address() {
      return address;
    },
    async signTypedData(domain, types, message) {
      overrides.onSign?.({ domain, types, message });
      return overrides.signature || SIGNATURE;
    },
    ...overrides.extra,
  };
}

function safePayload(overrides = {}) {
  return {
    domain: { chainId: 1, verifyingContract: SAFE, ...overrides.domain },
    types: { SafeTx: [{ name: "to", type: "address" }] },
    message: { to: SAFE },
  };
}

test("a proposal identity can only propose, and a Safe payload is scope-checked", async () => {
  const signed = [];
  const identity = createProposalIdentity({
    signer: stubSigner("0x0000000000000000000000000000000000000009", { onSign: (p) => signed.push(p) }),
    safeAddress: SAFE,
    chainId: 1,
    label: "safe-proposer-main",
  });

  assert.equal(identity.role, IdentityRole.PROPOSAL);
  assert.deepEqual(identity.capabilities, [Capability.PROPOSE_SAFE_TRANSACTION]);
  assert.equal(identity.can(Capability.PROPOSE_SAFE_TRANSACTION), true);
  assert.equal(identity.can(Capability.SIGN_TRANSACTION), false);
  assert.equal(identity.can(Capability.BROADCAST_TRANSACTION), false);

  // The capabilities it lacks are absent, not merely disallowed. There is no
  // method to call and no flag to flip.
  assert.equal(typeof identity.signTransaction, "undefined");
  assert.equal(typeof identity.broadcast, "undefined");
  assert.equal(typeof identity.sendTransaction, "undefined");
  assert.equal(typeof identity.exportPrivateKey, "undefined");

  assert.equal(await identity.proposeSafeTransaction(safePayload()), SIGNATURE);
  assert.equal(signed.length, 1);

  // A credential created for one Safe cannot propose into another.
  await assert.rejects(
    identity.proposeSafeTransaction(safePayload({ domain: { verifyingContract: OTHER_SAFE } })),
    /not scoped to this Safe/,
  );
  await assert.rejects(
    identity.proposeSafeTransaction(safePayload({ domain: { chainId: 8453 } })),
    /not scoped to this chain/,
  );
  assert.equal(signed.length, 1, "a scope failure still reached the signer");
});

test("the two roles are not substitutable and nothing converts between them", async () => {
  const proposal = createProposalIdentity({ signer: stubSigner(SAFE), safeAddress: SAFE, chainId: 1 });
  const execution = createExecutionIdentity({
    signer: stubSigner("0x0000000000000000000000000000000000000004"),
    chainId: 1,
    broadcaster: { broadcast: async () => ({ transactionHash: `0x${"cd".repeat(32)}` }) },
  });

  assert.equal(ProposalIdentity.isProposalIdentity(proposal), true);
  assert.equal(ProposalIdentity.isProposalIdentity(execution), false);
  assert.equal(ExecutionIdentity.isExecutionIdentity(execution), true);
  assert.equal(ExecutionIdentity.isExecutionIdentity(proposal), false);

  // The identity invariant: a proposal identity cannot become an autonomous
  // execution identity.
  assert.throws(() => assertExecutionIdentity(proposal), /cannot become an\s+autonomous execution identity/);
  assert.throws(() => assertProposalIdentity(execution), /must never be used to/);

  // Neither role can be forged by shape or by prototype.
  for (const forgery of [
    { role: "execution", capabilities: ["signTransaction", "broadcastTransaction"], address: async () => SAFE },
    Object.create(ExecutionIdentity.prototype),
    Object.create(ProposalIdentity.prototype),
    null,
    "execution",
  ]) {
    assert.throws(() => assertExecutionIdentity(forgery), TypeError);
  }
  assert.throws(() => assertProposalIdentity(Object.create(ProposalIdentity.prototype)), TypeError);

  // Nothing exported upgrades a role.
  const roles = require("../packages/core/src/execution/identity/roles");
  for (const suspicious of ["toExecutionIdentity", "asExecutionIdentity", "promote", "upgrade", "withCapability"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(roles, suspicious), false, suspicious);
  }

  assert.equal(assertIdentityForRole(IdentityRole.PROPOSAL, proposal), proposal);
  assert.equal(assertIdentityForRole(IdentityRole.EXECUTION, execution), execution);
  assert.throws(() => assertIdentityForRole(IdentityRole.EXECUTION, proposal), TypeError);
  assert.throws(() => assertIdentityForRole("both", proposal), /Unknown identity role/);
});

test("one key cannot back both the Safe proposer and the autonomous executor", async () => {
  const shared = stubSigner("0x0000000000000000000000000000000000000007");
  const violating = new ExecutionIdentitySet({
    proposal: createProposalIdentity({ signer: shared, safeAddress: SAFE, chainId: 1 }),
    execution: createExecutionIdentity({ signer: shared, chainId: 1, broadcaster: { broadcast: async () => ({}) } }),
  });
  await assert.rejects(violating.assertSeparation(), /Identity separation violated/);

  const separated = new ExecutionIdentitySet({
    proposal: createProposalIdentity({
      signer: stubSigner("0x0000000000000000000000000000000000000007"),
      safeAddress: SAFE,
      chainId: 1,
    }),
    execution: createExecutionIdentity({
      signer: stubSigner("0x0000000000000000000000000000000000000008"),
      chainId: 1,
      broadcaster: { broadcast: async () => ({}) },
    }),
  });
  assert.equal(await separated.assertSeparation(), true);

  // Having only one of the two is normal: a voter in supervised mode has no
  // execution identity at all.
  assert.equal(await new ExecutionIdentitySet({ proposal: separated.proposal }).assertSeparation(), true);
  assert.throws(() => new ExecutionIdentitySet({ proposal: separated.execution }), TypeError);
});

test("an execution identity is chain-scoped for both signing and broadcast", async () => {
  const broadcasts = [];
  const identity = createExecutionIdentity({
    signer: stubSigner("0x0000000000000000000000000000000000000004"),
    chainId: 1,
    policyId: "governance-only",
    broadcaster: {
      broadcast: async (request) => {
        broadcasts.push(request);
        return { transactionHash: `0x${"cd".repeat(32)}` };
      },
    },
  });

  assert.deepEqual(identity.capabilities, [Capability.SIGN_TRANSACTION, Capability.BROADCAST_TRANSACTION]);
  assert.equal(identity.scope.policyId, "governance-only");
  assert.equal(typeof identity.proposeSafeTransaction, "undefined");

  await identity.broadcast({ chainId: 1, to: SAFE, data: "0x" });
  assert.equal(broadcasts.length, 1);
  await assert.rejects(identity.broadcast({ chainId: 8453, to: SAFE }), /not scoped to this chain/);
  await assert.rejects(identity.signTransaction({ domain: { chainId: 8453 } }), /not scoped to this chain/);
  assert.equal(broadcasts.length, 1);

  assert.throws(
    () => createExecutionIdentity({ signer: stubSigner(SAFE), chainId: 1 }),
    /requires a broadcaster/,
  );
});

test("signing backends satisfy one narrow interface with no key export", async () => {
  assert.throws(() => assertSigningIdentity({}), /must implement address/);
  assert.throws(() => assertSigningIdentity({ address: () => {} }), /must implement signTypedData/);
  await assert.rejects(new SigningIdentity().address(), /must implement address/);

  // The interface is structural, so a KMS client wrapper need not import Gavel.
  assert.equal(assertSigningIdentity(stubSigner(SAFE)) != null, true);

  // Remote: the hosted / KMS / HSM seam.
  const requests = [];
  const remote = new RemoteSigningIdentity({
    address: "0x0000000000000000000000000000000000000009",
    description: "kms:tenant-42",
    sign: async (payload) => {
      requests.push(payload);
      return SIGNATURE;
    },
  });
  assert.equal(await remote.address(), "0x0000000000000000000000000000000000000009");
  assert.equal(await remote.signTypedData({ chainId: 1 }, {}, {}), SIGNATURE);
  assert.equal(requests.length, 1);
  assert.equal(remote.description, "kms:tenant-42");
  // A lazily-known address (a freshly provisioned KMS key) is supported.
  const lazy = new RemoteSigningIdentity({
    sign: async () => SIGNATURE,
    resolveAddress: async () => "0x000000000000000000000000000000000000000a",
  });
  assert.equal(await lazy.address(), "0x000000000000000000000000000000000000000A");
  await assert.rejects(new RemoteSigningIdentity({ sign: async () => SIGNATURE }).address(), /no address and no resolver/);

  // No backend exposes key material.
  for (const identity of [remote, lazy]) {
    for (const leak of ["privateKey", "exportPrivateKey", "signMessage", "sendTransaction"]) {
      assert.equal(typeof identity[leak], "undefined", leak);
    }
  }
});

test("the preferred BYOH backends keep no plaintext key and refuse address drift", async () => {
  const wallet = new Wallet(PROPOSER_KEY);
  const types = { Thing: [{ name: "value", type: "uint256" }] };

  // Encrypted keystore, unlocked per use through a passphrase provider.
  let passphraseReads = 0;
  const keystore = new KeystoreSigningIdentity({
    keystore: { version: 3, address: wallet.address.slice(2) },
    address: wallet.address,
    passphrase: async () => {
      passphraseReads += 1;
      return "correct horse";
    },
    decrypt: async (document, passphrase) => {
      assert.equal(passphrase, "correct horse");
      assert.equal(document.version, 3);
      return wallet;
    },
  });
  assert.equal(await keystore.address(), wallet.address);
  const signature = await keystore.signTypedData({ chainId: 1 }, types, { value: 1 });
  assert.match(signature, /^0x[0-9a-f]{130}$/i);
  assert.equal(passphraseReads, 1, "the passphrase was cached rather than fetched per unlock");
  assert.equal(Object.prototype.hasOwnProperty.call(keystore, "privateKey"), false);
  assert.throws(
    () => new KeystoreSigningIdentity({ keystore: {}, passphrase: "literal", decrypt: async () => wallet }),
    /not a stored passphrase/,
  );

  // A keystore that decrypts to a different address than the bound identity is
  // a misconfiguration, not a surprise to sign through. Reporting the bound
  // address needs no unlock -- showing an address should not prompt for a
  // passphrase -- so the check fires where it matters, at signing.
  const drifting = new KeystoreSigningIdentity({
    keystore: { version: 3 },
    address: wallet.address,
    passphrase: async () => "x",
    decrypt: async () => new Wallet(EXECUTOR_KEY),
  });
  assert.equal(await drifting.address(), wallet.address);
  await assert.rejects(
    drifting.signTypedData({ chainId: 1 }, types, { value: 1 }),
    /does not match the bound identity/,
  );

  // OS keychain / system secret store: the command lives in the runtime.
  let lookups = 0;
  const keychain = new SecretStoreSigningIdentity({
    description: "keychain:gavel-safe-proposer",
    fetchSecret: async () => {
      lookups += 1;
      return PROPOSER_KEY;
    },
    toSigner: (secret) => new Wallet(secret),
  });
  assert.equal(await keychain.address(), wallet.address);
  await keychain.signTypedData({ chainId: 1 }, types, { value: 1 });
  assert.equal(lookups, 2, "the secret was held rather than fetched per use");
  assert.equal(keychain.description, "keychain:gavel-safe-proposer");
});

test("a plaintext env-var key is reachable only by explicitly acknowledging it", async () => {
  // Not a production recommendation, and configuration drift cannot reach it.
  assert.throws(
    () => new EnvironmentSigningIdentity({ variable: "GAVEL_PROPOSER_KEY", toSigner: (s) => new Wallet(s) }),
    /development-only backend/,
  );
  assert.throws(
    () =>
      new EnvironmentSigningIdentity({
        variable: "GAVEL_PROPOSER_KEY",
        toSigner: (s) => new Wallet(s),
        acknowledgeDevelopmentOnly: "yes",
      }),
    /development-only backend/,
  );

  const development = new EnvironmentSigningIdentity({
    variable: "GAVEL_PROPOSER_KEY",
    env: { GAVEL_PROPOSER_KEY: PROPOSER_KEY },
    toSigner: (secret) => new Wallet(secret),
    acknowledgeDevelopmentOnly: true,
  });
  assert.equal(await development.address(), new Wallet(PROPOSER_KEY).address);
  assert.match(development.description, /development only/);

  const missing = new EnvironmentSigningIdentity({
    variable: "GAVEL_PROPOSER_KEY",
    env: {},
    toSigner: (secret) => new Wallet(secret),
    acknowledgeDevelopmentOnly: true,
  });
  await assert.rejects(missing.address(), /is not set/);
});
