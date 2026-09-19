const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet, TypedDataEncoder } = require('ethers');

const gate = require('../src');

const DAO_VERIFIER = '0x00000000000000000000000000000000000000da';
const BASE_VERIFIER = '0x00000000000000000000000000000000000000ba';
const WALLET = '0x00000000000000000000000000000000000000AA';
const NONCE = `0x${'11'.repeat(32)}`;
const NOW = 1_800_000_000n;
const MAX_LIFETIME = 600n;

const config = Object.freeze({
  daoChainId: 1n,
  daoVerifier: DAO_VERIFIER,
  baseChainId: 8453n,
  baseVerifier: BASE_VERIFIER,
  audience: 'https://gate.gavel.xyz',
  maxLifetime: MAX_LIFETIME,
});

function enrollment(overrides = {}) {
  return {
    wallet: WALLET,
    purpose: 'enrollment',
    availability: 'accepting_now',
    dao: 'nouns',
    daoChainId: '1',
    acceptPreVote: false,
    acceptVoting: true,
    attentionAmount: '1000000',
    nonce: NONCE,
    issuedAt: NOW.toString(),
    expiry: (NOW + MAX_LIFETIME).toString(),
    version: '1',
    ...overrides,
  };
}

function payout(overrides = {}) {
  return {
    wallet: WALLET,
    dao: 'nouns',
    purpose: 'base_payout_control',
    nonce: NONCE,
    issuedAt: NOW.toString(),
    expiry: (NOW + MAX_LIFETIME).toString(),
    version: '1',
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    wallet: WALLET,
    role: 'dao_profile',
    audience: config.audience,
    purpose: 'wallet_session',
    nonce: NONCE,
    issuedAt: NOW.toString(),
    expiry: (NOW + MAX_LIFETIME).toString(),
    version: '1',
    ...overrides,
  };
}

test('freezes exact enrollment EIP-712 names, versions, types, and field order', () => {
  assert.deepEqual(gate.GATE_ENROLLMENT_TYPES, [
    { name: 'wallet', type: 'address' },
    { name: 'purpose', type: 'string' },
    { name: 'availability', type: 'string' },
    { name: 'dao', type: 'string' },
    { name: 'daoChainId', type: 'uint256' },
    { name: 'acceptPreVote', type: 'bool' },
    { name: 'acceptVoting', type: 'bool' },
    { name: 'attentionAmount', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'version', type: 'uint256' },
  ]);
  assert.deepEqual(gate.BASE_PAYOUT_CONTROL_TYPES, [
    { name: 'wallet', type: 'address' },
    { name: 'dao', type: 'string' },
    { name: 'purpose', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'version', type: 'uint256' },
  ]);
  assert.deepEqual(gate.WALLET_SESSION_TYPES, [
    { name: 'wallet', type: 'address' },
    { name: 'role', type: 'string' },
    { name: 'audience', type: 'string' },
    { name: 'purpose', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'version', type: 'uint256' },
  ]);
  for (const fields of [gate.GATE_ENROLLMENT_TYPES, gate.BASE_PAYOUT_CONTROL_TYPES, gate.WALLET_SESSION_TYPES]) {
    assert.equal(Object.isFrozen(fields), true);
    assert.equal(Object.isFrozen(fields[0]), true);
  }
});

test('builds exact Nouns, Base payout, and role-derived wallet-session typed data', () => {
  assert.deepEqual(gate.createGateEnrollmentTypedData(enrollment(), config, NOW), {
    domain: { name: 'GavelGate', version: '1', chainId: 1n, verifyingContract: DAO_VERIFIER },
    primaryType: 'GateEnrollment',
    types: { GateEnrollment: gate.GATE_ENROLLMENT_TYPES },
    message: enrollment(),
  });
  assert.deepEqual(gate.createBasePayoutControlTypedData(payout(), config, NOW), {
    domain: { name: 'GavelGate', version: '1', chainId: 8453n, verifyingContract: BASE_VERIFIER },
    primaryType: 'BasePayoutControl',
    types: { BasePayoutControl: gate.BASE_PAYOUT_CONTROL_TYPES },
    message: payout(),
  });

  for (const [role, chainId, verifier] of [
    ['base_sender', 8453n, BASE_VERIFIER],
    ['dao_profile', 1n, DAO_VERIFIER],
    ['dao_inbox', 1n, DAO_VERIFIER],
  ]) {
    const message = session({ role });
    assert.deepEqual(gate.createWalletSessionTypedData(message, config, NOW), {
      domain: { name: 'GavelGate', version: '1', chainId, verifyingContract: verifier },
      primaryType: 'WalletSession',
      types: { WalletSession: gate.WALLET_SESSION_TYPES },
      message,
    });
  }
});

test('Nouns adapter preserves proposal VOTING mapping while advertising candidate PRE_VOTE support', () => {
  assert.deepEqual(gate.NOUNS_GATE_SUPPORTED_STAGES, ['PRE_VOTE', 'VOTING']);
  assert.equal(Object.isFrozen(gate.NOUNS_GATE_SUPPORTED_STAGES), true);
  assert.deepEqual(gate.adaptNounsGateLifecycle('ACTIVE'), {
    eligibility: 'VOTING',
    mappingVersion: 'nouns-lifecycle/1',
  });
  for (const state of [1, '1', 'PENDING', 'active', null, undefined, {}, 'PRE_VOTE']) {
    assert.deepEqual(gate.adaptNounsGateLifecycle(state), {
      eligibility: 'CLOSED',
      mappingVersion: 'nouns-lifecycle/1',
    });
  }
});

test('validates exact literals, Nouns policy, addresses, bytes32 values, and lossless integers', () => {
  assert.deepEqual(gate.validateGateEnrollment(enrollment(), config, NOW), enrollment());
  assert.deepEqual(gate.validateBasePayoutControl(payout(), config, NOW), payout());
  assert.deepEqual(gate.validateWalletSession(session(), config, NOW), session());

  const invalidEnrollment = [
    enrollment({ purpose: 'profile_update' }),
    enrollment({ availability: 'ACCEPTING_NOW' }),
    enrollment({ dao: 'Nouns' }),
    enrollment({ daoChainId: '8453' }),
    enrollment({ acceptPreVote: false, acceptVoting: false }),
    enrollment({ acceptVoting: 'true' }),
    enrollment({ attentionAmount: '999999' }),
    enrollment({ attentionAmount: 1000000 }),
    enrollment({ nonce: `0x${'11'.repeat(31)}` }),
    enrollment({ wallet: '0x1234' }),
    enrollment({ version: '01' }),
    enrollment({ extra: true }),
  ];
  for (const value of invalidEnrollment) {
    assert.throws(() => gate.validateGateEnrollment(value, config, NOW));
  }

  for (const value of [
    payout({ purpose: 'enrollment' }),
    payout({ dao: 'other' }),
    payout({ nonce: '11'.repeat(32) }),
    payout({ expiry: Number(NOW + 1n) }),
  ]) {
    assert.throws(() => gate.validateBasePayoutControl(value, config, NOW));
  }

  for (const value of [
    session({ role: 'admin' }),
    session({ audience: 'https://evil.example' }),
    session({ purpose: 'enrollment' }),
    session({ chainId: '1' }),
    session({ verifier: DAO_VERIFIER }),
  ]) {
    assert.throws(() => gate.validateWalletSession(value, config, NOW));
  }
});

test('enforces issuedAt <= now < expiry and configured maximum lifetime', () => {
  assert.doesNotThrow(() => gate.validateGateEnrollment(enrollment({ issuedAt: NOW.toString() }), config, NOW));
  assert.throws(() => gate.validateGateEnrollment(enrollment({ issuedAt: (NOW + 1n).toString() }), config, NOW), /future/);
  assert.throws(() => gate.validateGateEnrollment(enrollment({ expiry: NOW.toString() }), config, NOW), /expired/);
  assert.throws(() => gate.validateGateEnrollment(enrollment({ expiry: (NOW - 1n).toString() }), config, NOW), /expired/);
  assert.throws(
    () => gate.validateGateEnrollment(enrollment({ expiry: (NOW + MAX_LIFETIME + 1n).toString() }), config, NOW),
    /maximum challenge lifetime/,
  );
});

test('derives wallet-session chain and verifier only from the signed role', () => {
  assert.deepEqual(gate.deriveWalletSessionAuthority('base_sender', config), {
    chainId: 8453n,
    verifier: BASE_VERIFIER,
  });
  assert.deepEqual(gate.deriveWalletSessionAuthority('dao_profile', config), {
    chainId: 1n,
    verifier: DAO_VERIFIER,
  });
  assert.deepEqual(gate.deriveWalletSessionAuthority('dao_inbox', config), {
    chainId: 1n,
    verifier: DAO_VERIFIER,
  });
  assert.throws(() => gate.deriveWalletSessionAuthority('other', config));
});

test('computes the EIP-712 payload hash and domain-bound digest with ethers', () => {
  const typed = gate.createGateEnrollmentTypedData(enrollment(), config, NOW);
  assert.equal(
    gate.hashTypedDataPayload(typed),
    TypedDataEncoder.hashStruct(typed.primaryType, typed.types, typed.message),
  );
  assert.equal(
    gate.hashTypedDataDigest(typed),
    TypedDataEncoder.hash(typed.domain, typed.types, typed.message),
  );
  assert.match(gate.hashTypedDataPayload(typed), /^0x[0-9a-f]{64}$/);
  assert.match(gate.hashTypedDataDigest(typed), /^0x[0-9a-f]{64}$/);
  const wrongDomain = { ...typed, domain: { ...typed.domain, chainId: 8453n } };
  assert.notEqual(gate.hashTypedDataDigest(wrongDomain), gate.hashTypedDataDigest(typed));
  assert.equal(gate.hashTypedDataPayload(wrongDomain), gate.hashTypedDataPayload(typed));
});

test('recovers only the exact EOA EIP-712 wallet and payload', async () => {
  const signer = new Wallet(`0x${'12'.repeat(32)}`);
  const message = enrollment({ wallet: signer.address });
  const typed = gate.createGateEnrollmentTypedData(message, config, NOW);
  const signature = await signer.signTypedData(typed.domain, typed.types, typed.message);

  assert.equal(gate.recoverTypedDataSigner(typed, signature), signer.address);
  assert.equal(gate.verifyEoaTypedDataSignature(typed, signature), true);
  assert.equal(
    gate.verifyEoaTypedDataSignature({ ...typed, message: { ...typed.message, nonce: `0x${'22'.repeat(32)}` } }, signature),
    false,
  );
  assert.equal(
    gate.verifyEoaTypedDataSignature({ ...typed, domain: { ...typed.domain, verifyingContract: BASE_VERIFIER } }, signature),
    false,
  );
});

test('keeps ERC-1271 verification behind an injected, network-free boundary', async () => {
  const typed = gate.createBasePayoutControlTypedData(payout(), config, NOW);
  const signature = '0x1234';
  let received;
  const valid = await gate.verifyErc1271TypedDataSignature(typed, signature, async (request) => {
    received = request;
    return '0x1626BA7E';
  });

  assert.equal(valid, true);
  assert.deepEqual(received, {
    wallet: WALLET,
    chainId: 8453n,
    verifyingContract: '0x00000000000000000000000000000000000000BA',
    digest: gate.hashTypedDataDigest(typed),
    signature,
  });
  assert.equal(await gate.verifyErc1271TypedDataSignature(typed, signature, async () => '0xffffffff'), false);
  await assert.rejects(
    gate.verifyErc1271TypedDataSignature(typed, signature, async () => { throw new Error('RPC unavailable'); }),
    /RPC unavailable/,
  );
  await assert.rejects(gate.verifyErc1271TypedDataSignature(typed, signature), /injected/);
});

test('uses only the configured authority required by each proof type and role', () => {
  assert.doesNotThrow(() => gate.createGateEnrollmentTypedData(enrollment(), {
    daoChainId: 1n,
    daoVerifier: DAO_VERIFIER,
    maxLifetime: MAX_LIFETIME,
  }, NOW));
  assert.doesNotThrow(() => gate.createBasePayoutControlTypedData(payout(), {
    baseChainId: 8453n,
    baseVerifier: BASE_VERIFIER,
    maxLifetime: MAX_LIFETIME,
  }, NOW));
  assert.doesNotThrow(() => gate.createWalletSessionTypedData(session({ role: 'base_sender' }), {
    baseChainId: 8453n,
    baseVerifier: BASE_VERIFIER,
    audience: config.audience,
    maxLifetime: MAX_LIFETIME,
  }, NOW));
  assert.doesNotThrow(() => gate.createWalletSessionTypedData(session({ role: 'dao_inbox' }), {
    daoChainId: 1n,
    daoVerifier: DAO_VERIFIER,
    audience: config.audience,
    maxLifetime: MAX_LIFETIME,
  }, NOW));
});

test('exposes strict reusable schemas and rejects values outside uint256', () => {
  const enrollmentSchema = gate.createGateEnrollmentSchema(config, NOW);
  const payoutSchema = gate.createBasePayoutControlSchema(config, NOW);
  const sessionSchema = gate.createWalletSessionSchema(config, NOW);

  assert.deepEqual(enrollmentSchema.parse(enrollment()), enrollment());
  assert.deepEqual(payoutSchema.parse(payout()), payout());
  assert.deepEqual(sessionSchema.parse(session()), session());
  assert.equal(enrollmentSchema.safeParse(enrollment({ purpose: 'wrong' })).success, false);
  assert.equal(payoutSchema.safeParse(payout({ extra: true })).success, false);
  assert.equal(sessionSchema.safeParse(session({ role: 'other' })).success, false);

  const aboveUint256 = (1n << 256n).toString();
  assert.throws(() => gate.validateGateEnrollment(enrollment({ attentionAmount: aboveUint256 }), config, NOW), /uint256/);
  assert.throws(() => gate.validateGateEnrollment(enrollment({ expiry: aboveUint256 }), config, NOW), /uint256/);
});
