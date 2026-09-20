'use strict';

const { Interface, Signature, getAddress } = require('ethers');
const { deriveUsdcAuthorization, quoteTotalAmount } = require('./quote');

/**
 * The one prepared-settlement guard, shared by every broadcaster.
 *
 * A Gate settlement is broadcast by an account that is NOT the payer: the
 * splitter does not require `msg.sender == payer`, because the payer's
 * authority travels entirely inside the EIP-3009 authorization signature, which
 * binds `from`, `to`, `value`, and the quote id as its nonce.
 *
 * That split means a broadcaster is handed calldata it did not build. This
 * module is what makes that safe, and it lives here — in the shared domain
 * package — so the advocate client that prepares a settlement and the Gate
 * server that actually spends gas on it run the SAME checks over the SAME
 * decoded values. A guard that existed on only one side of that boundary would
 * be a guard the other side could drift away from.
 *
 * Nothing here trusts a caller's description of a transaction. Every value is
 * decoded back out of the calldata that will actually execute.
 */

// Matches contracts/gate/src/GavelGateSplitter.sol exactly.
const SPLITTER_SETTLE_ABI = Object.freeze([
  'function settle((bytes32 quoteId,address payer,address voter,uint256 attentionAmount,uint256 gavelFeeAmount,bytes32 submissionHash,address token,uint256 expiry,uint256 quoteVersion) quote, bytes quoteSignature, (address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s) authorization)',
]);

const splitterInterface = new Interface([...SPLITTER_SETTLE_ABI]);
const SETTLE_SELECTOR = splitterInterface.getFunction('settle').selector;

/** The only three fields a broadcaster may ever see. */
const PREPARED_SETTLEMENT_FIELDS = Object.freeze(['to', 'data', 'value']);

/**
 * A refusal to broadcast.
 *
 * `code` is deliberately the same coarse vocabulary the advocate client and the
 * Gate relay endpoint already speak. A message is a reason to stop; it never
 * carries a key, a session token, or a signature.
 */
class PreparedSettlementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PreparedSettlementError';
    this.code = code;
  }
}

function rejected(message) {
  return new PreparedSettlementError('PREPARED_TX_REJECTED', message);
}

/** The authorization is a deterministic derivative of the signed quote. */
function buildSettlementAuthorization(quote) {
  return deriveUsdcAuthorization(quote.message, quote.splitter ?? quote.domain?.verifyingContract);
}

/**
 * Encodes the single `settle` call.
 *
 * There is NO ERC-20 approve path: one EIP-3009 `receiveWithAuthorization`
 * authorization is consumed by one `settle` call on the splitter, and no USDC
 * ever moves to a Gavel-operated server address.
 */
function encodeSettleCall(quote, authorizationSignature) {
  const { v, r, s } = Signature.from(authorizationSignature);
  return splitterInterface.encodeFunctionData('settle', [
    {
      quoteId: quote.message.quoteId,
      payer: quote.message.payer,
      voter: quote.message.voter,
      attentionAmount: quote.message.attentionAmount,
      gavelFeeAmount: quote.message.gavelFeeAmount,
      submissionHash: quote.message.submissionHash,
      token: quote.message.token,
      expiry: quote.message.expiry,
      quoteVersion: quote.message.quoteVersion,
    },
    quote.signature,
    { ...buildSettlementAuthorization(quote), v, r, s },
  ]);
}

/**
 * Decodes a settle call back into the exact values it will execute with.
 *
 * `authorizationSignature` is re-serialized from the decoded v/r/s, so a caller
 * that needs the payer's EIP-3009 signature reads it out of the calldata rather
 * than being handed a second, possibly different, copy of it.
 */
function decodeSettleCall(data) {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data) || !data.startsWith(SETTLE_SELECTOR)) {
    throw rejected('This transaction is not a Gate splitter settlement.');
  }
  let decoded;
  try {
    decoded = splitterInterface.decodeFunctionData('settle', data);
  } catch {
    throw rejected('This settlement calldata could not be decoded.');
  }
  const [quote, quoteSignature, authorization] = decoded;
  let authorizationSignature;
  try {
    authorizationSignature = Signature.from({
      v: Number(authorization.v),
      r: String(authorization.r),
      s: String(authorization.s),
    }).serialized;
  } catch {
    throw rejected('This settlement carries an unusable payment authorization.');
  }
  return Object.freeze({
    quote: Object.freeze({
      quoteId: String(quote.quoteId).toLowerCase(),
      payer: getAddress(quote.payer),
      voter: getAddress(quote.voter),
      attentionAmount: quote.attentionAmount.toString(10),
      gavelFeeAmount: quote.gavelFeeAmount.toString(10),
      submissionHash: String(quote.submissionHash).toLowerCase(),
      token: getAddress(quote.token),
      expiry: quote.expiry.toString(10),
      quoteVersion: quote.quoteVersion.toString(10),
    }),
    quoteSignature,
    authorizationSignature,
    authorization: Object.freeze({
      from: getAddress(authorization.from),
      to: getAddress(authorization.to),
      value: authorization.value.toString(10),
      validAfter: authorization.validAfter.toString(10),
      validBefore: authorization.validBefore.toString(10),
      nonce: String(authorization.nonce).toLowerCase(),
    }),
  });
}

function isZeroValue(value) {
  if (value === undefined || value === null) return false;
  try {
    return BigInt(value) === 0n;
  } catch {
    return false;
  }
}

/**
 * Re-derives and re-checks a prepared transaction against the authoritative
 * quote, immediately before it is broadcast.
 *
 * This runs at the broadcast boundary even when the same process built the
 * object, because that boundary is the last point at which a substituted
 * target, a mutated calldata, or a smuggled ETH value could still be caught.
 *
 * `quote` is a parsed, signed Gate quote: `{ domain, message, signature }`,
 * optionally carrying the `splitter` and `totalAmount` derived from it.
 */
function assertPreparedSettlement(prepared, quote, nowSeconds) {
  if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) {
    throw rejected('A prepared settlement transaction is required.');
  }
  const extras = Object.keys(prepared).filter((field) => !PREPARED_SETTLEMENT_FIELDS.includes(field));
  if (extras.length) throw rejected(`A prepared settlement carries only to, data, and value; got ${extras[0]}.`);

  // 1. The destination is the authoritative splitter from the signed quote's
  //    EIP-712 domain, never a configured or caller-supplied address.
  let to;
  try {
    to = getAddress(String(prepared.to));
  } catch {
    throw rejected('The prepared transaction has no usable destination.');
  }
  const splitter = getAddress(quote.domain.verifyingContract);
  if (to !== splitter) throw rejected('The prepared transaction does not target the Gate splitter this quote names.');

  // 2. The selector is exactly the splitter's `settle`.
  if (typeof prepared.data !== 'string' || !prepared.data.startsWith(SETTLE_SELECTOR)) {
    throw rejected('The prepared transaction is not a Gate splitter settlement.');
  }

  // 3. No ETH moves. Settlement is USDC through EIP-3009 only.
  if (!isZeroValue(prepared.value)) throw rejected('A Gate settlement never sends ETH.');

  // 4. The calldata decodes back to this exact quote.
  const decoded = decodeSettleCall(prepared.data);
  const payer = getAddress(quote.message.payer);
  const total = quote.totalAmount === undefined ? quoteTotalAmount(quote.message) : String(quote.totalAmount);
  const mismatches = [
    [decoded.quote.quoteId, String(quote.message.quoteId).toLowerCase(), 'quote id'],
    [decoded.quote.payer, payer, 'payer'],
    [decoded.quote.voter, getAddress(quote.message.voter), 'voter'],
    [decoded.quote.attentionAmount, quote.message.attentionAmount, 'attention amount'],
    [decoded.quote.gavelFeeAmount, quote.message.gavelFeeAmount, 'Gavel fee'],
    [decoded.quote.submissionHash, String(quote.message.submissionHash).toLowerCase(), 'submission hash'],
    [decoded.quote.token, getAddress(quote.message.token), 'token'],
    [decoded.quote.expiry, quote.message.expiry, 'expiry'],
    [decoded.quote.quoteVersion, quote.message.quoteVersion, 'quote version'],
    [decoded.quoteSignature, quote.signature, 'Gate quote signature'],
    // 5. The authorization pays FROM the payer TO the splitter, for the quote
    //    total. A broadcaster can never become the `from`.
    [decoded.authorization.from, payer, 'authorization payer'],
    [decoded.authorization.to, splitter, 'authorization recipient'],
    [decoded.authorization.value, total, 'authorization amount'],
    [decoded.authorization.nonce, String(quote.message.quoteId).toLowerCase(), 'authorization nonce'],
    [decoded.authorization.validBefore, quote.message.expiry, 'authorization expiry'],
  ].filter(([actual, expected]) => actual !== expected);
  if (mismatches.length) {
    throw rejected(`The prepared settlement does not match this quote's ${mismatches[0][2]}.`);
  }

  // 6. An expired quote is dead on arrival: the splitter reverts on it, so
  //    broadcasting would only burn gas.
  if (nowSeconds !== undefined && BigInt(quote.message.expiry) <= BigInt(Math.floor(Number(nowSeconds)))) {
    throw new PreparedSettlementError(
      'QUOTE_EXPIRED',
      'This quote expired before it was broadcast. Nothing was sent.',
    );
  }
  return Object.freeze({ to, data: prepared.data, value: '0x0' });
}

module.exports = {
  PREPARED_SETTLEMENT_FIELDS,
  PreparedSettlementError,
  SETTLE_SELECTOR,
  SPLITTER_SETTLE_ABI,
  assertPreparedSettlement,
  buildSettlementAuthorization,
  decodeSettleCall,
  encodeSettleCall,
  splitterInterface,
};
