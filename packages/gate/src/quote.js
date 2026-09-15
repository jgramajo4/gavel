const { TypedDataEncoder, getAddress, verifyTypedData } = require('ethers');
const {
  GAVEL_FEE_AMOUNT,
  MIN_ATTENTION_AMOUNT,
  QUOTE_VERSION,
} = require('./constants');

const QUOTE_DOMAIN_NAME = 'GavelGateSplitter';
const QUOTE_DOMAIN_VERSION = '1';
const QUOTE_PRIMARY_TYPE = 'Quote';

// The exact ordered EIP-712 struct. chainId and verifyingContract live in the
// domain only; they are never duplicated as unsigned application fields.
const QUOTE_TYPES = Object.freeze([
  { name: 'quoteId', type: 'bytes32' },
  { name: 'payer', type: 'address' },
  { name: 'voter', type: 'address' },
  { name: 'attentionAmount', type: 'uint256' },
  { name: 'gavelFeeAmount', type: 'uint256' },
  { name: 'submissionHash', type: 'bytes32' },
  { name: 'token', type: 'address' },
  { name: 'expiry', type: 'uint256' },
  { name: 'quoteVersion', type: 'uint256' },
].map((field) => Object.freeze(field)));

const QUOTE_FIELD_NAMES = Object.freeze(QUOTE_TYPES.map((field) => field.name));
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;

function uint(value, label) {
  let parsed;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) parsed = BigInt(value);
  else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) parsed = BigInt(value);
  else throw new TypeError(`${label} must be a lossless unsigned decimal integer`);
  if (parsed < 0n || parsed > MAX_UINT256) throw new TypeError(`${label} must fit uint256`);
  return parsed;
}

function nonzeroAddress(value, label) {
  let canonical;
  try {
    canonical = getAddress(String(value));
  } catch {
    throw new TypeError(`${label} must be a valid address`);
  }
  if (canonical === ZERO_ADDRESS) throw new TypeError(`${label} must not be the zero address`);
  return canonical;
}

function bytes32(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError(`${label} must be exactly 32 bytes`);
  }
  return value.toLowerCase();
}

function createQuoteDomain({ chainId, verifyingContract } = {}) {
  const chain = uint(chainId, 'chainId');
  if (chain < 1n || chain > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('chainId must be a positive safe integer');
  return Object.freeze({
    name: QUOTE_DOMAIN_NAME,
    version: QUOTE_DOMAIN_VERSION,
    chainId: Number(chain),
    verifyingContract: nonzeroAddress(verifyingContract, 'verifyingContract'),
  });
}

function buildQuoteMessage(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('quote message must be an object');
  const unknown = Object.keys(input).find((field) => !QUOTE_FIELD_NAMES.includes(field));
  if (unknown) throw new TypeError(`unknown quote field: ${unknown}`);
  const missing = QUOTE_FIELD_NAMES.find((field) => !Object.hasOwn(input, field));
  if (missing) throw new TypeError(`quote field is required: ${missing}`);

  const attentionAmount = uint(input.attentionAmount, 'attentionAmount');
  if (attentionAmount < MIN_ATTENTION_AMOUNT) {
    throw new TypeError(`attentionAmount must be at least ${MIN_ATTENTION_AMOUNT}`);
  }
  const gavelFeeAmount = uint(input.gavelFeeAmount, 'gavelFeeAmount');
  if (gavelFeeAmount !== GAVEL_FEE_AMOUNT) throw new TypeError(`gavelFeeAmount must equal ${GAVEL_FEE_AMOUNT}`);
  const quoteVersion = uint(input.quoteVersion, 'quoteVersion');
  if (quoteVersion !== BigInt(QUOTE_VERSION)) throw new TypeError(`quoteVersion must equal ${QUOTE_VERSION}`);
  const expiry = uint(input.expiry, 'expiry');
  if (expiry < 1n) throw new TypeError('expiry must be a positive Unix second');

  // Key order mirrors QUOTE_TYPES so serialized payloads stay byte-stable.
  return Object.freeze({
    quoteId: bytes32(input.quoteId, 'quoteId'),
    payer: nonzeroAddress(input.payer, 'payer'),
    voter: nonzeroAddress(input.voter, 'voter'),
    attentionAmount: attentionAmount.toString(10),
    gavelFeeAmount: gavelFeeAmount.toString(10),
    submissionHash: bytes32(input.submissionHash, 'submissionHash'),
    token: nonzeroAddress(input.token, 'token'),
    expiry: expiry.toString(10),
    quoteVersion: quoteVersion.toString(10),
  });
}

function requireMessage(message) {
  const names = Object.keys(message ?? {});
  if (names.length !== QUOTE_FIELD_NAMES.length || QUOTE_FIELD_NAMES.some((field) => !names.includes(field))) {
    throw new TypeError('quote message must be built with buildQuoteMessage');
  }
  return message;
}

function createQuoteTypedData(message, domain) {
  return Object.freeze({
    domain: createQuoteDomain(domain),
    primaryType: QUOTE_PRIMARY_TYPE,
    types: Object.freeze({ [QUOTE_PRIMARY_TYPE]: QUOTE_TYPES }),
    message: requireMessage(message),
  });
}

function quoteTotalAmount(message) {
  const value = requireMessage(message);
  return (BigInt(value.attentionAmount) + BigInt(value.gavelFeeAmount)).toString(10);
}

function hashQuoteDigest(typed) {
  return TypedDataEncoder.hash(typed.domain, typed.types, requireMessage(typed.message));
}

function verifyQuoteSignature(typed, signature, expectedSigner) {
  let expected;
  try {
    expected = getAddress(String(expectedSigner));
  } catch {
    return false;
  }
  try {
    return getAddress(verifyTypedData(typed.domain, typed.types, requireMessage(typed.message), signature)) === expected;
  } catch {
    return false;
  }
}

// The browser cannot choose these values: every one is a deterministic
// derivative of the unchanged signed Quote message.
function deriveUsdcAuthorization(message, splitter) {
  const value = requireMessage(message);
  return Object.freeze({
    from: value.payer,
    to: nonzeroAddress(splitter, 'splitter'),
    value: quoteTotalAmount(value),
    validAfter: '0',
    validBefore: value.expiry,
    nonce: value.quoteId,
  });
}

module.exports = {
  QUOTE_DOMAIN_NAME,
  QUOTE_DOMAIN_VERSION,
  QUOTE_FIELD_NAMES,
  QUOTE_PRIMARY_TYPE,
  QUOTE_TYPES,
  buildQuoteMessage,
  createQuoteDomain,
  createQuoteTypedData,
  deriveUsdcAuthorization,
  hashQuoteDigest,
  quoteTotalAmount,
  verifyQuoteSignature,
};
