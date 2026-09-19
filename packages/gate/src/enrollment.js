const { z } = require('zod');
const {
  getAddress,
  TypedDataEncoder,
  verifyTypedData,
} = require('ethers');
const { AVAILABILITY, MIN_ATTENTION_AMOUNT } = require('./constants');

const GATE_TYPED_DATA_NAME = 'GavelGate';
const GATE_TYPED_DATA_VERSION = '1';
const GATE_ENROLLMENT_PURPOSE = 'enrollment';
const BASE_PAYOUT_CONTROL_PURPOSE = 'base_payout_control';
const WALLET_SESSION_PURPOSE = 'wallet_session';
const NOUNS_DAO = 'nouns';
const NOUNS_DAO_CHAIN_ID = 1n;
const ERC1271_MAGIC_VALUE = '0x1626ba7e';
const MAX_UINT256 = (1n << 256n) - 1n;
const WALLET_SESSION_ROLES = Object.freeze(['base_sender', 'dao_profile', 'dao_inbox']);

function frozenFields(fields) {
  return Object.freeze(fields.map((field) => Object.freeze(field)));
}

const GATE_ENROLLMENT_TYPES = frozenFields([
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

const BASE_PAYOUT_CONTROL_TYPES = frozenFields([
  { name: 'wallet', type: 'address' },
  { name: 'dao', type: 'string' },
  { name: 'purpose', type: 'string' },
  { name: 'nonce', type: 'bytes32' },
  { name: 'issuedAt', type: 'uint256' },
  { name: 'expiry', type: 'uint256' },
  { name: 'version', type: 'uint256' },
]);

const WALLET_SESSION_TYPES = frozenFields([
  { name: 'wallet', type: 'address' },
  { name: 'role', type: 'string' },
  { name: 'audience', type: 'string' },
  { name: 'purpose', type: 'string' },
  { name: 'nonce', type: 'bytes32' },
  { name: 'issuedAt', type: 'uint256' },
  { name: 'expiry', type: 'uint256' },
  { name: 'version', type: 'uint256' },
]);

function assertExactFields(message, fields, label) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError(`${label} must be an object`);
  }
  const expected = fields.map(({ name }) => name);
  const actual = Object.keys(message);
  if (actual.length !== expected.length || expected.some((name) => !actual.includes(name))) {
    throw new TypeError(`${label} must contain exactly ${expected.join(',')}`);
  }
}

function parseUint(value, label) {
  let parsed;
  if (typeof value === 'bigint') {
    if (value < 0n) throw new TypeError(`${label} must be an unsigned integer`);
    parsed = value;
  } else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new TypeError(`${label} must be a lossless unsigned decimal integer`);
  }
  if (parsed > MAX_UINT256) throw new TypeError(`${label} must fit uint256`);
  return parsed;
}

function assertAddress(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be an address`);
  try {
    getAddress(value);
  } catch {
    throw new TypeError(`${label} must be a valid address`);
  }
}

function assertBytes32(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError(`${label} must be exactly 32 bytes`);
  }
}

function validateTimeWindow(message, now, maxLifetime) {
  const issuedAt = parseUint(message.issuedAt, 'issuedAt');
  const expiry = parseUint(message.expiry, 'expiry');
  const current = parseUint(now, 'now');
  const maximum = parseUint(maxLifetime, 'maxLifetime');
  if (issuedAt > current) throw new TypeError('issuedAt must not be in the future');
  if (current >= expiry) throw new TypeError('proof must not be expired');
  if (expiry - issuedAt > maximum) throw new TypeError('proof exceeds maximum challenge lifetime');
}

function validateCommon(message, fields, label, purpose, now, maxLifetime) {
  assertExactFields(message, fields, label);
  assertAddress(message.wallet, 'wallet');
  if (message.purpose !== purpose) throw new TypeError(`purpose must equal ${purpose}`);
  assertBytes32(message.nonce, 'nonce');
  if (parseUint(message.version, 'version') !== 1n) throw new TypeError('version must equal 1');
  validateTimeWindow(message, now, maxLifetime);
  return message;
}

function requireConfig(config) {
  if (!config || typeof config !== 'object') throw new TypeError('config is required');
  return config;
}

function validateMaximumLifetime(config) {
  const maxLifetime = parseUint(requireConfig(config).maxLifetime, 'maxLifetime');
  if (maxLifetime === 0n) throw new TypeError('maxLifetime must be positive');
  return maxLifetime;
}

function validateDaoConfig(config) {
  requireConfig(config);
  const daoChainId = parseUint(config.daoChainId, 'daoChainId');
  if (daoChainId !== NOUNS_DAO_CHAIN_ID) throw new TypeError('Nouns DAO chain must equal 1');
  assertAddress(config.daoVerifier, 'daoVerifier');
  return { daoChainId, maxLifetime: validateMaximumLifetime(config) };
}

function validateBaseConfig(config) {
  requireConfig(config);
  const baseChainId = parseUint(config.baseChainId, 'baseChainId');
  assertAddress(config.baseVerifier, 'baseVerifier');
  return { baseChainId, maxLifetime: validateMaximumLifetime(config) };
}

function validateAudience(config) {
  requireConfig(config);
  if (typeof config.audience !== 'string' || config.audience.length === 0) {
    throw new TypeError('audience must be a non-empty string');
  }
}

function validateGateEnrollment(message, config, now) {
  const normalized = validateDaoConfig(config);
  validateCommon(message, GATE_ENROLLMENT_TYPES, 'GateEnrollment', GATE_ENROLLMENT_PURPOSE, now, normalized.maxLifetime);
  if (!AVAILABILITY.includes(message.availability)) throw new TypeError('invalid availability');
  if (message.dao !== NOUNS_DAO) throw new TypeError('dao must equal nouns');
  if (parseUint(message.daoChainId, 'daoChainId') !== normalized.daoChainId) {
    throw new TypeError('daoChainId must equal the Nouns domain chain');
  }
  if (typeof message.acceptPreVote !== 'boolean' || typeof message.acceptVoting !== 'boolean'
      || (!message.acceptPreVote && !message.acceptVoting)) {
    throw new TypeError('at least one Nouns stage must be accepted');
  }
  if (parseUint(message.attentionAmount, 'attentionAmount') < MIN_ATTENTION_AMOUNT) {
    throw new TypeError(`attentionAmount must be at least ${MIN_ATTENTION_AMOUNT}`);
  }
  return message;
}

function validateBasePayoutControl(message, config, now) {
  const normalized = validateBaseConfig(config);
  validateCommon(message, BASE_PAYOUT_CONTROL_TYPES, 'BasePayoutControl', BASE_PAYOUT_CONTROL_PURPOSE, now, normalized.maxLifetime);
  if (message.dao !== NOUNS_DAO) throw new TypeError('dao must equal nouns');
  return message;
}

function deriveWalletSessionAuthority(role, config) {
  if (!WALLET_SESSION_ROLES.includes(role)) throw new TypeError('invalid wallet session role');
  validateAudience(config);
  if (role === 'base_sender') {
    const { baseChainId } = validateBaseConfig(config);
    return { chainId: baseChainId, verifier: config.baseVerifier };
  }
  const { daoChainId } = validateDaoConfig(config);
  return { chainId: daoChainId, verifier: config.daoVerifier };
}

function validateWalletSession(message, config, now) {
  assertExactFields(message, WALLET_SESSION_TYPES, 'WalletSession');
  deriveWalletSessionAuthority(message.role, config);
  const maxLifetime = validateMaximumLifetime(config);
  validateCommon(message, WALLET_SESSION_TYPES, 'WalletSession', WALLET_SESSION_PURPOSE, now, maxLifetime);
  if (message.audience !== config.audience) throw new TypeError('audience does not match configured Gate API audience');
  return message;
}

function createValidationSchema(validate, config, now, label) {
  return z.custom((value) => {
    try {
      validate(value, config, now);
      return true;
    } catch {
      return false;
    }
  }, { message: `invalid ${label}` });
}

function createGateEnrollmentSchema(config, now) {
  return createValidationSchema(validateGateEnrollment, config, now, 'GateEnrollment');
}

function createBasePayoutControlSchema(config, now) {
  return createValidationSchema(validateBasePayoutControl, config, now, 'BasePayoutControl');
}

function createWalletSessionSchema(config, now) {
  return createValidationSchema(validateWalletSession, config, now, 'WalletSession');
}

function domain(chainId, verifyingContract) {
  return {
    name: GATE_TYPED_DATA_NAME,
    version: GATE_TYPED_DATA_VERSION,
    chainId,
    verifyingContract,
  };
}

function typedData(primaryType, fields, message, typedDomain) {
  return { domain: typedDomain, primaryType, types: { [primaryType]: fields }, message };
}

function createGateEnrollmentTypedData(message, config, now) {
  validateGateEnrollment(message, config, now);
  const { daoChainId } = validateDaoConfig(config);
  return typedData('GateEnrollment', GATE_ENROLLMENT_TYPES, message, domain(daoChainId, config.daoVerifier));
}

function createBasePayoutControlTypedData(message, config, now) {
  validateBasePayoutControl(message, config, now);
  const { baseChainId } = validateBaseConfig(config);
  return typedData('BasePayoutControl', BASE_PAYOUT_CONTROL_TYPES, message, domain(baseChainId, config.baseVerifier));
}

function createWalletSessionTypedData(message, config, now) {
  validateWalletSession(message, config, now);
  const authority = deriveWalletSessionAuthority(message.role, config);
  return typedData('WalletSession', WALLET_SESSION_TYPES, message, domain(authority.chainId, authority.verifier));
}

function hashTypedDataPayload(typed) {
  return TypedDataEncoder.hashStruct(typed.primaryType, typed.types, typed.message);
}

function hashTypedDataDigest(typed) {
  return TypedDataEncoder.hash(typed.domain, typed.types, typed.message);
}

function recoverTypedDataSigner(typed, signature) {
  return verifyTypedData(typed.domain, typed.types, typed.message, signature);
}

function verifyEoaTypedDataSignature(typed, signature) {
  return getAddress(recoverTypedDataSigner(typed, signature)) === getAddress(typed.message.wallet);
}

async function verifyErc1271TypedDataSignature(typed, signature, verifier) {
  if (typeof verifier !== 'function') throw new TypeError('ERC-1271 verifier must be injected');
  const result = await verifier({
    wallet: getAddress(typed.message.wallet),
    chainId: BigInt(typed.domain.chainId),
    verifyingContract: getAddress(typed.domain.verifyingContract),
    digest: hashTypedDataDigest(typed),
    signature,
  });
  return typeof result === 'string' && result.toLowerCase() === ERC1271_MAGIC_VALUE;
}

module.exports = {
  GATE_TYPED_DATA_NAME,
  GATE_TYPED_DATA_VERSION,
  GATE_ENROLLMENT_PURPOSE,
  BASE_PAYOUT_CONTROL_PURPOSE,
  WALLET_SESSION_PURPOSE,
  NOUNS_DAO,
  NOUNS_DAO_CHAIN_ID,
  ERC1271_MAGIC_VALUE,
  WALLET_SESSION_ROLES,
  GATE_ENROLLMENT_TYPES,
  BASE_PAYOUT_CONTROL_TYPES,
  WALLET_SESSION_TYPES,
  validateGateEnrollment,
  validateBasePayoutControl,
  validateWalletSession,
  createGateEnrollmentSchema,
  createBasePayoutControlSchema,
  createWalletSessionSchema,
  deriveWalletSessionAuthority,
  createGateEnrollmentTypedData,
  createBasePayoutControlTypedData,
  createWalletSessionTypedData,
  hashTypedDataPayload,
  hashTypedDataDigest,
  recoverTypedDataSigner,
  verifyEoaTypedDataSignature,
  verifyErc1271TypedDataSignature,
};
