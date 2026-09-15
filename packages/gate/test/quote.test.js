const test = require('node:test');
const assert = require('node:assert/strict');
const { TypedDataEncoder, Wallet, getAddress } = require('ethers');

const {
  GAVEL_FEE_AMOUNT,
  MIN_ATTENTION_AMOUNT,
  QUOTE_DOMAIN_NAME,
  QUOTE_DOMAIN_VERSION,
  QUOTE_PRIMARY_TYPE,
  QUOTE_TYPES,
  buildQuoteMessage,
  createQuoteDomain,
  createQuoteTypedData,
  deriveUsdcAuthorization,
  hashQuoteDigest,
  quoteTotalAmount,
  verifyQuoteSignature,
} = require('../src');

const SPLITTER = '0x2222222222222222222222222222222222222222';
const PAYER = '0x3333333333333333333333333333333333333333';
const VOTER = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const QUOTE_ID = `0x${'aa'.repeat(32)}`;
const SUBMISSION_HASH = `0x${'bb'.repeat(32)}`;
const ZERO = '0x0000000000000000000000000000000000000000';

function message(overrides = {}) {
  return buildQuoteMessage({
    quoteId: QUOTE_ID,
    payer: PAYER,
    voter: VOTER,
    attentionAmount: '1000000',
    gavelFeeAmount: '250000',
    submissionHash: SUBMISSION_HASH,
    token: TOKEN,
    expiry: '1789344600',
    quoteVersion: '1',
    ...overrides,
  });
}

test('freezes the exact splitter-bound EIP-712 domain and ordered Quote type', () => {
  assert.equal(QUOTE_DOMAIN_NAME, 'GavelGateSplitter');
  assert.equal(QUOTE_DOMAIN_VERSION, '1');
  assert.equal(QUOTE_PRIMARY_TYPE, 'Quote');
  assert.deepEqual(QUOTE_TYPES.map((field) => [field.name, field.type]), [
    ['quoteId', 'bytes32'],
    ['payer', 'address'],
    ['voter', 'address'],
    ['attentionAmount', 'uint256'],
    ['gavelFeeAmount', 'uint256'],
    ['submissionHash', 'bytes32'],
    ['token', 'address'],
    ['expiry', 'uint256'],
    ['quoteVersion', 'uint256'],
  ]);

  assert.deepEqual(createQuoteDomain({ chainId: 8453, verifyingContract: SPLITTER }), {
    name: 'GavelGateSplitter',
    version: '1',
    chainId: 8453,
    verifyingContract: getAddress(SPLITTER),
  });
});

test('the quote message carries exactly the nine signed fields and no unsigned duplicates', () => {
  assert.deepEqual(Object.keys(message()), QUOTE_TYPES.map((field) => field.name));
  assert.equal(quoteTotalAmount(message()), '1250000');
  assert.equal(quoteTotalAmount(message({ attentionAmount: '9000000' })), '9250000');

  for (const extra of ['chainId', 'verifyingContract', 'splitter', 'snapshotId']) {
    assert.throws(() => message({ [extra]: '1' }), /unknown quote field/i, `${extra} must be rejected`);
  }
});

test('rejects every economically invalid or malformed quote field', () => {
  assert.equal(GAVEL_FEE_AMOUNT, 250_000n);
  assert.equal(MIN_ATTENTION_AMOUNT, 1_000_000n);

  assert.throws(() => message({ gavelFeeAmount: '250001' }), /gavelFeeAmount/);
  assert.throws(() => message({ gavelFeeAmount: '0' }), /gavelFeeAmount/);
  assert.throws(() => message({ attentionAmount: '999999' }), /attentionAmount/);
  assert.throws(() => message({ quoteVersion: '2' }), /quoteVersion/);
  assert.throws(() => message({ quoteVersion: '0' }), /quoteVersion/);
  assert.throws(() => message({ expiry: '0' }), /expiry/);
  assert.throws(() => message({ payer: ZERO }), /payer/);
  assert.throws(() => message({ voter: ZERO }), /voter/);
  assert.throws(() => message({ token: ZERO }), /token/);
  assert.throws(() => message({ quoteId: `0x${'aa'.repeat(31)}` }), /quoteId/);
  assert.throws(() => message({ submissionHash: '0xnothex' }), /submissionHash/);
  assert.throws(() => createQuoteDomain({ chainId: 0, verifyingContract: SPLITTER }), /chainId/);
  assert.throws(() => createQuoteDomain({ chainId: 8453, verifyingContract: ZERO }), /verifyingContract/);
});

test('the typed digest matches ethers for the exact domain and is bound to chain and deployment', () => {
  const domain = createQuoteDomain({ chainId: 8453, verifyingContract: SPLITTER });
  const typed = createQuoteTypedData(message(), domain);

  assert.deepEqual(typed.types, { Quote: QUOTE_TYPES });
  assert.equal(typed.primaryType, 'Quote');
  assert.equal(hashQuoteDigest(typed), TypedDataEncoder.hash(domain, { Quote: QUOTE_TYPES }, message()));

  const otherChain = createQuoteTypedData(message(), createQuoteDomain({ chainId: 84532, verifyingContract: SPLITTER }));
  const otherSplitter = createQuoteTypedData(message(), createQuoteDomain({
    chainId: 8453, verifyingContract: '0x4444444444444444444444444444444444444444',
  }));
  assert.notEqual(hashQuoteDigest(typed), hashQuoteDigest(otherChain));
  assert.notEqual(hashQuoteDigest(typed), hashQuoteDigest(otherSplitter));
});

test('a locally verified signature accepts only the exact signer, message, and deployment', async () => {
  const signer = new Wallet(`0x${'7'.repeat(64)}`);
  const other = new Wallet(`0x${'8'.repeat(64)}`);
  const domain = createQuoteDomain({ chainId: 8453, verifyingContract: SPLITTER });
  const typed = createQuoteTypedData(message(), domain);
  const signature = await signer.signTypedData(typed.domain, typed.types, typed.message);

  assert.equal(verifyQuoteSignature(typed, signature, signer.address), true);
  assert.equal(verifyQuoteSignature(typed, signature, other.address), false);
  assert.equal(verifyQuoteSignature(typed, '0x00', signer.address), false);
  assert.equal(verifyQuoteSignature(createQuoteTypedData(message({ attentionAmount: '2000000' }), domain),
    signature, signer.address), false);
  assert.equal(verifyQuoteSignature(createQuoteTypedData(message({ submissionHash: `0x${'cc'.repeat(32)}` }), domain),
    signature, signer.address), false);
  assert.equal(verifyQuoteSignature(
    createQuoteTypedData(message(), createQuoteDomain({ chainId: 84532, verifyingContract: SPLITTER })),
    signature, signer.address), false);
});

test('the USDC authorization is a deterministic derivative of the unchanged quote message', () => {
  assert.deepEqual(deriveUsdcAuthorization(message(), SPLITTER), {
    from: getAddress(PAYER),
    to: getAddress(SPLITTER),
    value: '1250000',
    validAfter: '0',
    validBefore: '1789344600',
    nonce: QUOTE_ID,
  });
});
