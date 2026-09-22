"use strict";

const { getAddress, verifyTypedData } = require("ethers");
const {
  PreparedSettlementError,
  assertPreparedSettlement,
  buildSettlementAuthorization,
  createQuoteTypedData,
  encodeSettleCall,
  quoteTotalAmount,
  verifyQuoteSignature,
} = require("@gavel/gate");
const { redactSignerMaterial } = require("./quote-signer");

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const PUBLIC_ID = /^[A-Za-z0-9_-]{22}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The EIP-3009 struct USDC signs. Every field value is a deterministic
 * derivative of the quote Gate itself signed, so the only thing a payer can
 * contribute is the signature over it.
 */
const RECEIVE_WITH_AUTHORIZATION_TYPES = Object.freeze({
  ReceiveWithAuthorization: Object.freeze([
    Object.freeze({ name: "from", type: "address" }),
    Object.freeze({ name: "to", type: "address" }),
    Object.freeze({ name: "value", type: "uint256" }),
    Object.freeze({ name: "validAfter", type: "uint256" }),
    Object.freeze({ name: "validBefore", type: "uint256" }),
    Object.freeze({ name: "nonce", type: "bytes32" }),
  ]),
});

// The body this endpoint accepts, in full. There is no `to`, no `data`, and no
// `value`: the transaction is built server-side from the quote Gate signed and
// persisted, so an arbitrary transaction has nowhere to enter.
const RELAY_BODY_FIELDS = Object.freeze(["authorization"]);
const RELAY_AUTHORIZATION_FIELDS = Object.freeze(["signature"]);

const DEFAULT_MAX_TRACKED_RELAYS = 256;
const RELAY_STORE_METHODS = Object.freeze([
  "claimRelayAttempt", "markRelayBroadcasting", "completeRelayBroadcast", "failRelayAttempt",
]);

class RelayRequestError extends Error {
  constructor(message, statusCode = 400, code = "INVALID_RELAY", state) {
    super(redactSignerMaterial(String(message)));
    this.name = "RelayRequestError";
    this.statusCode = statusCode;
    this.code = code;
    if (state !== undefined) this.state = state;
  }
}

const unauthenticated = () => new RelayRequestError("authentication required", 401, "UNAUTHORIZED");
const notFound = () => new RelayRequestError("Not found", 404, "NOT_FOUND");
const invalid = (message) => new RelayRequestError(message, 400, "INVALID_RELAY");

function canonicalAddress(value, name) {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw invalid(`${name} is invalid`);
  return getAddress(value);
}

/**
 * The narrow remote relay.
 *
 * Bankr — or any advocate client whose sandbox holds no funded key — signs the
 * EIP-3009 authorization and sends Gate NOTHING BUT that signature. Gate looks
 * up the quote it signed itself, rebuilds the settlement calldata from it,
 * re-runs the shared prepared-settlement guard over what it built, and only
 * then hands a gas-only relayer wallet `{ to, data, value: 0 }`.
 *
 * What this endpoint deliberately is not:
 *
 *   - a transaction relay. It accepts no target, no calldata, and no value,
 *     so there is no shape of request that broadcasts something else.
 *   - a payment authority. A transaction hash it returns is a settlement HINT.
 *     Gate's own scanner still verifies the `QuoteSettled` log independently,
 *     and only Gate's `accepted` means delivered.
 *   - a USDC path. The relayer pays gas; the USDC leg is the payer's EIP-3009
 *     authorization, from the payer to the splitter, and nothing else.
 */
function createGateRelayService({
  relayer,
  relayStore,
  submissionService,
  deployment,
  tokenDomain,
  now = () => Date.now(),
  maxTrackedRelays = DEFAULT_MAX_TRACKED_RELAYS,
} = {}) {
  if (!relayer || typeof relayer.preflightSettlement !== "function"
      || typeof relayer.broadcastSettlement !== "function" || typeof relayer.address !== "string") {
    throw new TypeError("a Gate relayer exposing address, preflightSettlement, and broadcastSettlement is required");
  }
  if (!relayStore || RELAY_STORE_METHODS.some((method) => typeof relayStore[method] !== "function")) {
    throw new TypeError("a durable Gate relay store is required");
  }
  if (!submissionService || typeof submissionService.resumeSubmission !== "function") {
    throw new TypeError("submissionService.resumeSubmission is required for the relay service");
  }
  if (!deployment || typeof deployment !== "object") throw new TypeError("deployment identity is required");
  const chainId = String(deployment.chainId);
  if (!/^[1-9][0-9]*$/.test(chainId)) throw new TypeError("deployment chainId must be a positive decimal integer");
  const splitter = canonicalAddress(String(deployment.splitter), "deployment splitter");
  const token = canonicalAddress(String(deployment.token), "deployment token");
  const quoteSigner = canonicalAddress(String(deployment.quoteSigner), "deployment quote signer");
  const relayerAddress = canonicalAddress(relayer.address, "relayer address");
  if (!tokenDomain || typeof tokenDomain.name !== "string" || tokenDomain.name === ""
      || typeof tokenDomain.version !== "string" || tokenDomain.version === "") {
    throw new TypeError("the payment token's attested EIP-712 name and version are required");
  }
  if (!Number.isSafeInteger(maxTrackedRelays) || maxTrackedRelays < 1) {
    throw new TypeError("maxTrackedRelays must be a positive integer");
  }
  // The relayer pays gas and nothing else. Colliding it with the splitter or
  // the token would put the gas payer inside the money path.
  for (const [name, value] of [["splitter", splitter], ["token", token], ["quote signer", quoteSigner]]) {
    if (relayerAddress === value) throw new TypeError(`the Gate relayer must not be the ${name}`);
  }

  const authorizationDomain = Object.freeze({
    name: tokenDomain.name,
    version: tokenDomain.version,
    chainId: Number(chainId),
    verifyingContract: token,
  });

  // One broadcast per quote. A retried relay — a lost response, a resumed
  // submission, an advocate that pressed twice — returns the SAME transaction
  // hash instead of spending gas on a second transaction that the token's
  // spent-nonce check would revert anyway.
  const broadcasts = new Map();

  function remember(quoteId, promise) {
    broadcasts.set(quoteId, promise);
    while (broadcasts.size > maxTrackedRelays) broadcasts.delete(broadcasts.keys().next().value);
    return promise;
  }

  function assertRelayBody(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw invalid("relay request body must be an object");
    }
    const extras = Object.keys(request).filter((field) => !RELAY_BODY_FIELDS.includes(field));
    // Naming the field is what makes "this is not a transaction relay" legible
    // to whoever tried: `to`, `data`, and `value` are refused, not ignored.
    if (extras.length) throw invalid(`relay request carries only an authorization; got ${extras[0]}`);
    const authorization = request.authorization;
    if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) {
      throw invalid("relay request requires the payer's EIP-3009 authorization");
    }
    const unknown = Object.keys(authorization).filter((field) => !RELAY_AUTHORIZATION_FIELDS.includes(field));
    if (unknown.length) throw invalid(`relay authorization carries only a signature; got ${unknown[0]}`);
    if (typeof authorization.signature !== "string" || !SIGNATURE.test(authorization.signature)) {
      // The signature itself is never echoed back, malformed or not.
      throw invalid("relay authorization signature is invalid");
    }
    return authorization.signature;
  }

  /**
   * Rebuilds the canonical view of a quote Gate signed.
   *
   * Nothing in it comes from the request: the domain, every message field, and
   * the signature are read back from Gate's own owner-bound record.
   */
  function assertRelayableQuote(issued, payer) {
    let typed;
    try {
      typed = createQuoteTypedData(issued.message, issued.domain);
    } catch {
      throw new RelayRequestError("persisted quote is unreadable", 500, "INTERNAL_ERROR");
    }
    if (String(typed.domain.chainId) !== chainId
        || getAddress(typed.domain.verifyingContract) !== splitter
        || getAddress(typed.message.token) !== token) {
      throw new RelayRequestError("this quote does not belong to this Gate deployment", 409, "INVALID_RELAY");
    }
    if (!verifyQuoteSignature(typed, issued.signature, quoteSigner)) {
      throw new RelayRequestError("this quote is not signed by this Gate", 409, "INVALID_RELAY");
    }
    if (getAddress(typed.message.payer) !== payer) {
      // Owner-bound resume already enforces this; re-checking it here means the
      // relayer can never broadcast someone else's authorization.
      throw notFound();
    }
    return Object.freeze({
      domain: typed.domain,
      message: typed.message,
      signature: issued.signature,
      totalAmount: quoteTotalAmount(typed.message),
      splitter,
      token,
      chainId: Number(chainId),
    });
  }

  /**
   * Proves the EIP-3009 signature covers the authorization THIS quote derives,
   * and recovers to the quote's payer.
   *
   * A bad signature would revert on chain and cost the relayer gas, so it is
   * rejected before a transaction is built. The failure never echoes the
   * signature.
   */
  function assertAuthorizationSignature(quote, signature) {
    const authorization = buildSettlementAuthorization(quote);
    let recovered;
    try {
      recovered = getAddress(verifyTypedData(
        authorizationDomain,
        { ...RECEIVE_WITH_AUTHORIZATION_TYPES },
        authorization,
        signature,
      ));
    } catch {
      throw invalid("the payment authorization could not be verified");
    }
    if (recovered !== getAddress(quote.message.payer)) {
      throw invalid("the payment authorization does not recover to this quote's payer");
    }
    return authorization;
  }

  function prepareTransaction(quote, signature) {
    let data;
    try {
      data = encodeSettleCall(quote, signature);
    } catch {
      throw invalid("the payment authorization could not be encoded for this quote");
    }
    // The same guard the advocate client runs, over the transaction this server
    // just built. It is the last point at which a substituted target, a mutated
    // calldata, or a smuggled ETH value could still be caught.
    let safe;
    try {
      safe = assertPreparedSettlement({ to: splitter, data, value: "0x0" }, quote,
        Math.floor(Number(now()) / 1000));
    } catch (error) {
      if (error instanceof PreparedSettlementError) {
        throw error.code === "QUOTE_EXPIRED"
          ? new RelayRequestError("This quote expired before it was broadcast. Nothing was sent.", 410, "EXPIRED", "expired")
          : new RelayRequestError(error.message, 400, "PREPARED_TX_REJECTED");
      }
      throw error;
    }
    // The gas payer is never the USDC payer.
    if (relayerAddress === getAddress(quote.message.payer)) {
      throw new RelayRequestError("the Gate relayer must be a separate account from the payer", 503, "RELAYER_IS_PAYER");
    }
    return safe;
  }

  function receipt(txHash) {
    return Object.freeze({ txHash, chainId, relayer: relayerAddress });
  }

  async function broadcast(quote, signature) {
    const quoteId = String(quote.message.quoteId).toLowerCase();
    const identity = {
      quoteId,
      // EIP-3009's authoritative authorization identity is its nonce. Gate
      // freezes that nonce to quoteId; signature bytes and caller text are not
      // deduplication keys because equivalent valid ECDSA signatures authorize
      // this same immutable message.
      authorizationNonce: quoteId,
      chainId,
      splitter,
      token,
    };
    const claim = await relayStore.claimRelayAttempt(identity);
    if (claim.disposition !== "claimed") {
      if (claim.status === "reconciliation_required") {
        throw new RelayRequestError("relay outcome requires operator reconciliation", 503,
          "RELAY_RECONCILIATION_REQUIRED");
      }
      if (claim.txHash) return receipt(claim.txHash);
      throw new RelayRequestError("relay attempt is already in progress", 409, "RELAY_IN_PROGRESS");
    }

    const transaction = prepareTransaction(quote, signature);
    let prepared;
    try {
      // This boundary may validate, simulate, and estimate gas, but it MUST NOT
      // invoke any send/broadcast primitive. Its deterministic hash is durable
      // before the external side effect begins.
      prepared = await relayer.preflightSettlement(transaction);
    } catch (error) {
      await relayStore.failRelayAttempt({ quoteId, claimToken: claim.claimToken, definitelyNotSent: true });
      throw error;
    }
    await relayStore.markRelayBroadcasting({ quoteId, claimToken: claim.claimToken,
      txHash: prepared.txHash, rawTransaction: prepared.rawTransaction });
    try {
      const txHash = await relayer.broadcastSettlement(prepared);
      if (String(txHash).toLowerCase() !== String(prepared.txHash).toLowerCase()) {
        throw new Error("relayer broadcast hash did not match the prepared transaction");
      }
      await relayStore.completeRelayBroadcast({ quoteId, txHash: prepared.txHash });
      return receipt(prepared.txHash);
    } catch {
      // Once broadcast begins, an RPC error cannot prove that the node did not
      // accept the signed transaction. Keep its deterministic hash and never
      // blindly send another transaction for this authorization.
      await relayStore.failRelayAttempt({ quoteId, claimToken: claim.claimToken, definitelyNotSent: false });
      throw new RelayRequestError("relay outcome requires operator reconciliation", 503,
        "RELAY_RECONCILIATION_REQUIRED");
    }
  }

  /**
   * Validates and broadcasts one prepared Gate settlement.
   *
   * The advocate supplies a submission id and one signature. Everything else —
   * the destination, the calldata, the amounts, the payer, the voter, the
   * token, the nonce, the expiry — comes from the quote this Gate signed.
   */
  async function relaySettlement({ session, publicId, request } = {}) {
    if (!session || session.role !== "base_sender" || typeof session.wallet !== "string") throw unauthenticated();
    let payer;
    try {
      payer = getAddress(session.wallet);
    } catch {
      throw unauthenticated();
    }
    if (typeof publicId !== "string" || !PUBLIC_ID.test(publicId)) throw notFound();
    const signature = assertRelayBody(request);

    // Owner-bound: a submission that is not this session's is a plain 404, and
    // a resume issues, refreshes, and reserves nothing.
    const resumed = await submissionService.resumeSubmission({ session, publicId });
    if (!resumed) throw notFound();
    if (resumed.state === "expired" || !resumed.quote) {
      throw new RelayRequestError(
        `this submission is ${String(resumed.state)}; there is nothing to broadcast`,
        resumed.state === "expired" ? 410 : 409,
        resumed.state === "expired" ? "EXPIRED" : "NOT_PAYABLE",
        resumed.state,
      );
    }
    if (resumed.state !== "payment_required") {
      // pending_settlement, accepted, rejected_by_policy: Gate has already moved
      // on, and a second broadcast would only burn gas.
      throw new RelayRequestError(
        `this submission is ${String(resumed.state)}; there is nothing to broadcast`,
        409, "NOT_PAYABLE", resumed.state,
      );
    }

    const quote = assertRelayableQuote(resumed.quote, payer);
    assertAuthorizationSignature(quote, signature);

    const quoteId = String(quote.message.quoteId).toLowerCase();
    const pending = broadcasts.get(quoteId);
    if (pending) return pending;
    const attempt = remember(quoteId, broadcast(quote, signature));
    try {
      return await attempt;
    } catch (error) {
      // Definitely-not-sent preflight failures are released durably. Ambiguous
      // post-send failures remain reconciliation-required in the store.
      if (broadcasts.get(quoteId) === attempt) broadcasts.delete(quoteId);
      throw error;
    }
  }

  return Object.freeze({
    relayerAddress,
    chainId,
    relaySettlement,
  });
}

module.exports = {
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  RELAY_AUTHORIZATION_FIELDS,
  RELAY_BODY_FIELDS,
  RelayRequestError,
  createGateRelayService,
};
