'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Signature, Wallet, getAddress } = require('ethers');

const {
  PREPARED_SETTLEMENT_FIELDS,
  PreparedSettlementError,
  SETTLE_SELECTOR,
  assertPreparedSettlement,
  buildQuoteMessage,
  createQuoteTypedData,
  decodeSettleCall,
  encodeSettleCall,
  quoteTotalAmount,
} = require('../src/index');

const PAYER_KEY = `0x${'11'.repeat(32)}`;
const payerWallet = new Wallet(PAYER_KEY);
const PAYER = getAddress(payerWallet.address);
const VOTER = getAddress(`0x${'ab'.repeat(20)}`);
const SPLITTER = getAddress(`0x${'5e'.repeat(20)}`);
const TOKEN = getAddress(`0x${'c0'.repeat(20)}`);
const CHAIN_ID = 8453;
const NOW_SECONDS = 1_800_000_000;
const AUTH_SIGNATURE = Signature.from({
  r: `0x${'22'.repeat(32)}`,
  s: `0x${'33'.repeat(32)}`,
  v: 27,
}).serialized;

function quoteFixture(overrides = {}) {
  const message = buildQuoteMessage({
    quoteId: `0x${'a1'.repeat(32)}`,
    payer: PAYER,
    voter: VOTER,
    attentionAmount: '1000000',
    gavelFeeAmount: '250000',
    submissionHash: `0x${'77'.repeat(32)}`,
    token: TOKEN,
    expiry: String(NOW_SECONDS + 600),
    quoteVersion: '1',
    ...overrides,
  });
  const typed = createQuoteTypedData(message, { chainId: CHAIN_ID, verifyingContract: SPLITTER });
  return Object.freeze({
    domain: typed.domain,
    message: typed.message,
    signature: `0x${'cd'.repeat(65)}`,
    totalAmount: quoteTotalAmount(message),
    splitter: SPLITTER,
    token: TOKEN,
    chainId: CHAIN_ID,
  });
}

function preparedFor(quote = quoteFixture()) {
  return { quote, prepared: { to: quote.splitter, data: encodeSettleCall(quote, AUTH_SIGNATURE), value: '0x0' } };
}

test('a prepared settlement built from a quote passes and is normalized', () => {
  const { quote, prepared } = preparedFor();
  const safe = assertPreparedSettlement(prepared, quote, NOW_SECONDS);
  assert.deepEqual(Object.keys(safe).sort(), [...PREPARED_SETTLEMENT_FIELDS].sort());
  assert.equal(safe.to, SPLITTER);
  assert.equal(safe.value, '0x0');
  assert.ok(safe.data.startsWith(SETTLE_SELECTOR));
  assert.ok(Object.isFrozen(safe));
});

test('the decoded call carries the authorization signature back out of the calldata', () => {
  const { prepared } = preparedFor();
  const decoded = decodeSettleCall(prepared.data);
  assert.equal(decoded.authorizationSignature, AUTH_SIGNATURE);
  assert.equal(decoded.authorization.from, PAYER);
  assert.equal(decoded.authorization.to, SPLITTER);
  assert.equal(decoded.authorization.value, '1250000');
  assert.notEqual(decoded.authorization.from, VOTER);
});

test('an arbitrary destination is rejected', () => {
  const { quote, prepared } = preparedFor();
  assert.throws(
    () => assertPreparedSettlement({ ...prepared, to: getAddress(`0x${'9'.repeat(40)}`) }, quote, NOW_SECONDS),
    (error) => error instanceof PreparedSettlementError && error.code === 'PREPARED_TX_REJECTED'
      && /splitter/.test(error.message),
  );
});

test('an arbitrary selector and mutated calldata are rejected', () => {
  const { quote, prepared } = preparedFor();
  const otherQuote = quoteFixture({ attentionAmount: '9000000' });
  const flipped = prepared.data[20] === 'f' ? 'e' : 'f';
  const candidates = [
    { ...prepared, data: '0xdeadbeef' },
    { ...prepared, data: `0xdeadbeef${prepared.data.slice(10)}` },
    { ...prepared, data: encodeSettleCall(otherQuote, AUTH_SIGNATURE) },
    { ...prepared, data: `${prepared.data.slice(0, 20)}${flipped}${prepared.data.slice(21)}` },
  ];
  for (const candidate of candidates) {
    assert.throws(
      () => assertPreparedSettlement(candidate, quote, NOW_SECONDS),
      (error) => error.code === 'PREPARED_TX_REJECTED',
    );
  }
});

test('a non-zero ETH value is rejected', () => {
  const { quote, prepared } = preparedFor();
  for (const value of ['0x1', '1', 1, '0xde0b6b3a7640000', undefined, null, {}]) {
    assert.throws(
      () => assertPreparedSettlement({ ...prepared, value }, quote, NOW_SECONDS),
      (error) => error.code === 'PREPARED_TX_REJECTED' && /ETH/.test(error.message),
    );
  }
});

test('extra prepared fields are rejected by name', () => {
  const { quote, prepared } = preparedFor();
  for (const [field, extra] of [['from', { from: PAYER }], ['gasPrice', { gasPrice: '0x1' }]]) {
    assert.throws(
      () => assertPreparedSettlement({ ...prepared, ...extra }, quote, NOW_SECONDS),
      (error) => error.code === 'PREPARED_TX_REJECTED' && error.message.includes(field),
    );
  }
});

test('every signed quote field must match the calldata exactly', () => {
  const { prepared } = preparedFor();
  const mismatches = [
    [{ quoteId: `0x${'b2'.repeat(32)}` }, /quote id/],
    [{ payer: getAddress(`0x${'44'.repeat(20)}`) }, /payer/],
    [{ voter: getAddress(`0x${'55'.repeat(20)}`) }, /voter/],
    [{ attentionAmount: '2000000' }, /attention amount/],
    [{ token: getAddress(`0x${'66'.repeat(20)}`) }, /token/],
    [{ submissionHash: `0x${'88'.repeat(32)}` }, /submission hash/],
    [{ expiry: String(NOW_SECONDS + 1200) }, /expiry/],
  ];
  for (const [override, pattern] of mismatches) {
    const other = quoteFixture(override);
    assert.throws(
      () => assertPreparedSettlement(prepared, other, NOW_SECONDS),
      (error) => error.code === 'PREPARED_TX_REJECTED' && pattern.test(error.message),
      `expected a refusal matching ${pattern}`,
    );
  }
});

test('a different Gate quote signature is rejected', () => {
  const { quote, prepared } = preparedFor();
  const resigned = { ...quote, signature: `0x${'ef'.repeat(65)}` };
  assert.throws(
    () => assertPreparedSettlement(prepared, resigned, NOW_SECONDS),
    (error) => error.code === 'PREPARED_TX_REJECTED' && /quote signature/.test(error.message),
  );
});

test('an expired quote is never broadcast', () => {
  const quote = quoteFixture({ expiry: String(NOW_SECONDS) });
  const { prepared } = preparedFor(quote);
  assert.throws(
    () => assertPreparedSettlement(prepared, quote, NOW_SECONDS),
    (error) => error.code === 'QUOTE_EXPIRED',
  );
  // One second earlier the same settlement is still payable.
  assert.ok(assertPreparedSettlement(prepared, quote, NOW_SECONDS - 1).data);
});

test('a relayer can never become the authorization payer', () => {
  // The authorization `from` is derived from the quote, so a settlement that
  // names anyone else does not decode back to the quote it claims.
  const { quote, prepared } = preparedFor();
  const decoded = decodeSettleCall(prepared.data);
  assert.equal(decoded.authorization.from, getAddress(quote.message.payer));
  const impostor = quoteFixture({ payer: getAddress(`0x${'7e'.repeat(20)}`) });
  assert.throws(
    () => assertPreparedSettlement(prepared, impostor, NOW_SECONDS),
    (error) => error.code === 'PREPARED_TX_REJECTED',
  );
});
