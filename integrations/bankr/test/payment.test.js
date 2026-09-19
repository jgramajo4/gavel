"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Interface, Signature, TypedDataEncoder, getAddress, verifyTypedData } = require("ethers");

const {
  RECEIVE_WITH_AUTHORIZATION_TYPES, SPLITTER_ABI, buildAuthorization, encodeSettleCall, payQuote, readTokenDomain,
} = require("../src/payment");
const { parseIssuedQuote } = require("../src/quote");
const { createEip1193Wallet, serializeTypedData } = require("../src/wallet");
const {
  BASE_SEPOLIA, PAYER, SPLITTER, TOKEN, TOKEN_NAME, TOKEN_VERSION, VOTER, createWalletStub, issuedQuote,
} = require("./helpers");

const splitterInterface = new Interface([...SPLITTER_ABI]);
const NOW_MS = 1_800_000_000_000;
const now = () => NOW_MS;

const quoteFixture = () => parseIssuedQuote(issuedQuote());

test("payment refuses to touch the wallet without explicit confirmation", async () => {
  const { wallet, calls } = createWalletStub();
  for (const confirmed of [undefined, false, "yes", 1, null]) {
    await assert.rejects(
      payQuote({ wallet, quote: quoteFixture(), confirmed, now }),
      (error) => error.code === "CONFIRMATION_REQUIRED",
    );
  }
  assert.equal(calls.signTypedData.length, 0);
  assert.equal(calls.sendTransaction.length, 0);
  assert.equal(calls.call.length, 0);
});

test("an expired quote never reaches the wallet", async () => {
  const { wallet, calls } = createWalletStub();
  const expired = parseIssuedQuote(issuedQuote({ message: { expiry: String(Math.floor(NOW_MS / 1000) - 1) } }));
  await assert.rejects(
    payQuote({ wallet, quote: expired, confirmed: true, now }),
    (error) => error.code === "QUOTE_EXPIRED",
  );
  assert.equal(calls.signTypedData.length + calls.sendTransaction.length + calls.call.length, 0);
});

test("a quote for a chain outside the allow-list never reaches the wallet", async () => {
  const { wallet, calls } = createWalletStub();
  const mainnet = parseIssuedQuote(issuedQuote({ domain: { chainId: 8453 } }));
  await assert.rejects(
    payQuote({ wallet, quote: mainnet, confirmed: true, now }),
    (error) => error.code === "CHAIN_NOT_ALLOWED",
  );
  assert.equal(calls.signTypedData.length + calls.sendTransaction.length, 0);
});

test("a wallet on the wrong chain is switched to the quote's chain", async () => {
  const { wallet, calls } = createWalletStub({ chainId: 11_155_111 });
  await payQuote({ wallet, quote: quoteFixture(), confirmed: true, now });
  assert.deepEqual(calls.switchChain, [BASE_SEPOLIA]);
});

test("a wallet that cannot switch chains refuses rather than paying on the wrong chain", async () => {
  const { wallet } = createWalletStub({ chainId: 11_155_111 });
  delete wallet.switchChain;
  await assert.rejects(
    payQuote({ wallet, quote: quoteFixture(), confirmed: true, now }),
    (error) => error.code === "WRONG_CHAIN",
  );
});

test("an insufficient token balance refuses before any signature", async () => {
  const { wallet, calls } = createWalletStub({ balance: 1_000_000n });
  await assert.rejects(
    payQuote({ wallet, quote: quoteFixture(), confirmed: true, now }),
    (error) => error.code === "INSUFFICIENT_BALANCE" && /1\.00 test USDC/.test(error.message),
  );
  assert.equal(calls.signTypedData.length, 0);
});

test("the token's EIP-712 domain is proven against its own DOMAIN_SEPARATOR", async () => {
  const { wallet } = createWalletStub();
  const domain = await readTokenDomain(wallet, TOKEN, BASE_SEPOLIA);
  assert.deepEqual(domain, {
    name: TOKEN_NAME, version: TOKEN_VERSION, chainId: BASE_SEPOLIA, verifyingContract: TOKEN,
  });

  const lying = createWalletStub().wallet;
  const original = lying.call.bind(lying);
  lying.call = async (request) => {
    const result = await original(request);
    return request.data.startsWith("0x3644e515") ? `0x${"ff".repeat(32)}` : result;
  };
  await assert.rejects(
    readTokenDomain(lying, TOKEN, BASE_SEPOLIA),
    (error) => error.code === "TOKEN_DOMAIN_MISMATCH",
  );
});

test("the EIP-3009 authorization is derived entirely from the signed quote", async () => {
  const quote = quoteFixture();
  const authorization = buildAuthorization(quote);
  assert.deepEqual({ ...authorization }, {
    from: PAYER,
    to: SPLITTER,
    value: "1250000",
    validAfter: "0",
    validBefore: quote.message.expiry,
    nonce: quote.message.quoteId,
  });
});

test("the authorization signing request is ReceiveWithAuthorization on the token domain", async () => {
  const { wallet, calls } = createWalletStub();
  const quote = quoteFixture();
  await payQuote({ wallet, quote, confirmed: true, now });

  const [, authorizationRequest] = [null, calls.signTypedData[0]];
  assert.equal(calls.signTypedData.length, 1);
  assert.equal(authorizationRequest.primaryType, "ReceiveWithAuthorization");
  assert.deepEqual(authorizationRequest.types, RECEIVE_WITH_AUTHORIZATION_TYPES);
  assert.deepEqual(authorizationRequest.domain, {
    name: TOKEN_NAME, version: TOKEN_VERSION, chainId: BASE_SEPOLIA, verifyingContract: TOKEN,
  });
  assert.deepEqual({ ...authorizationRequest.message }, { ...buildAuthorization(quote) });

  // The digest is the token's, unchanged by any Bankr serialization.
  const signature = await wallet.signTypedData(authorizationRequest);
  assert.equal(
    verifyTypedData(authorizationRequest.domain, { ...RECEIVE_WITH_AUTHORIZATION_TYPES }, authorizationRequest.message, signature),
    PAYER,
  );
  assert.ok(TypedDataEncoder.hash(
    authorizationRequest.domain,
    { ...RECEIVE_WITH_AUTHORIZATION_TYPES },
    authorizationRequest.message,
  ).startsWith("0x"));
});

test("there is no ERC-20 approve anywhere in the payment path", async () => {
  const { wallet, calls } = createWalletStub();
  await payQuote({ wallet, quote: quoteFixture(), confirmed: true, now });
  const approveSelector = new Interface(["function approve(address,uint256)"]).getFunction("approve").selector;
  for (const tx of calls.sendTransaction) assert.ok(!tx.data.startsWith(approveSelector));
  assert.equal(calls.sendTransaction.length, 1);
});

test("the settle transaction is built from the quote and sent to the splitter", async () => {
  const { wallet, calls } = createWalletStub();
  const quote = quoteFixture();
  const result = await payQuote({ wallet, quote, confirmed: true, now });

  assert.equal(calls.sendTransaction.length, 1);
  const [tx] = calls.sendTransaction;
  assert.equal(getAddress(tx.to), SPLITTER);
  assert.equal(getAddress(tx.from), PAYER);
  assert.equal(tx.value, "0x0");

  const decoded = splitterInterface.decodeFunctionData("settle", tx.data);
  assert.equal(decoded[0].quoteId, quote.message.quoteId);
  assert.equal(getAddress(decoded[0].payer), PAYER);
  assert.equal(getAddress(decoded[0].voter), VOTER);
  assert.equal(decoded[0].attentionAmount.toString(), "1000000");
  assert.equal(decoded[0].gavelFeeAmount.toString(), "250000");
  assert.equal(decoded[0].submissionHash, quote.message.submissionHash);
  assert.equal(decoded[1], quote.signature);
  assert.equal(decoded[2].value.toString(), "1250000");
  assert.equal(decoded[2].nonce, quote.message.quoteId);
  assert.equal(result.txHash, `0x${"ab".repeat(32)}`);
  assert.equal(result.chainId, String(BASE_SEPOLIA));
});

test("a broadcast transaction hash is explicitly NOT acceptance", async () => {
  const { wallet } = createWalletStub();
  const result = await payQuote({ wallet, quote: quoteFixture(), confirmed: true, now });
  assert.equal(result.broadcast, true);
  assert.equal(result.accepted, false);
  assert.equal(result.delivered, undefined);
});

test("a rejected signature and a reverted broadcast are distinct failures", async () => {
  const rejected = createWalletStub({ failSign: true });
  await assert.rejects(
    payQuote({ wallet: rejected.wallet, quote: quoteFixture(), confirmed: true, now }),
    (error) => error.code === "AUTHORIZATION_FAILED",
  );
  assert.equal(rejected.calls.sendTransaction.length, 0);

  const reverted = createWalletStub({ failSend: true });
  await assert.rejects(
    payQuote({ wallet: reverted.wallet, quote: quoteFixture(), confirmed: true, now }),
    (error) => error.code === "BROADCAST_FAILED",
  );
});

test("a quote issued to another payer is refused", async () => {
  const { wallet } = createWalletStub({ account: getAddress(`0x${"7".repeat(40)}`) });
  await assert.rejects(
    payQuote({ wallet, quote: quoteFixture(), confirmed: true, now }),
    (error) => error.code === "PAYER_MISMATCH",
  );
});

test("encodeSettleCall normalizes a 0/1 recovery id without changing the signature", () => {
  const quote = quoteFixture();
  const raw = `0x${"11".repeat(32)}${"22".repeat(32)}00`;
  const data = encodeSettleCall(quote, raw);
  const decoded = splitterInterface.decodeFunctionData("settle", data);
  assert.equal(Number(decoded[2].v), Signature.from(raw).v);
  assert.equal(decoded[2].r, `0x${"11".repeat(32)}`);
  assert.equal(decoded[2].s, `0x${"22".repeat(32)}`);
});

test("the EIP-1193 adapter adds only the EIP712Domain type entry", () => {
  const payload = {
    domain: { name: "GavelGate", version: "1", chainId: 84532, verifyingContract: TOKEN },
    types: { WalletSession: [{ name: "wallet", type: "address" }] },
    primaryType: "WalletSession",
    message: { wallet: PAYER },
  };
  const serialized = serializeTypedData(payload);
  assert.deepEqual(Object.keys(serialized.types), ["EIP712Domain", "WalletSession"]);
  assert.deepEqual(serialized.domain, payload.domain);
  assert.deepEqual(serialized.message, payload.message);
  assert.equal(serialized.primaryType, "WalletSession");
});

test("the EIP-1193 adapter never requests a private key", async () => {
  const methods = [];
  const provider = {
    async request({ method, params }) {
      methods.push(method);
      if (method === "eth_requestAccounts") return [PAYER];
      if (method === "eth_chainId") return "0x14a34";
      if (method === "eth_signTypedData_v4") {
        assert.equal(typeof params[1], "string");
        return `0x${"cd".repeat(65)}`;
      }
      return null;
    },
  };
  const wallet = createEip1193Wallet(provider);
  assert.equal(await wallet.getAddress(), PAYER);
  assert.equal(await wallet.getChainId(), BASE_SEPOLIA);
  await wallet.signTypedData({
    account: PAYER,
    domain: { name: "n", version: "1", chainId: 1, verifyingContract: TOKEN },
    types: { A: [{ name: "wallet", type: "address" }] },
    primaryType: "A",
    message: { wallet: PAYER },
  });
  for (const method of methods) {
    assert.doesNotMatch(method, /private|export|seed|mnemonic|sign_?raw/i);
  }
});
