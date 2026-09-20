"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getAddress } = require("ethers");

const { authorizePayment, broadcastPayment } = require("../src/payment");
const { assertPreparedTransaction, broadcastSettlement } = require("../src/relayer");
const { SETTLE_SELECTOR, encodeSettleCall } = require("../src/splitter");
const { parseIssuedQuote } = require("../src/quote");
const {
  BASE_MAINNET, PAYER, RELAYER, SPLITTER, createRelayerStub, createWalletStub, issuedQuote,
} = require("./helpers");

const NOW_MS = 1_800_000_000_000;
const now = () => NOW_MS;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

const quoteFixture = () => parseIssuedQuote(issuedQuote());

async function preparedFor(quote = quoteFixture()) {
  const { wallet } = createWalletStub();
  return { quote, prepared: await authorizePayment({ wallet, quote, confirmed: true, now }) };
}

test("the relayer broadcasts and its address differs from the payer", async () => {
  const { quote, prepared } = await preparedFor();
  const relayerStub = createRelayerStub();
  const result = await broadcastSettlement({ relayer: relayerStub.relayer, prepared, quote, nowSeconds: NOW_SECONDS });

  assert.equal(result.relayer, RELAYER);
  assert.equal(result.payer, PAYER);
  assert.notEqual(result.relayer, result.payer);
  assert.equal(result.broadcast, true);
  assert.equal(result.accepted, false);
  assert.equal(relayerStub.calls.sendTransaction.length, 1);
});

test("a relayer that IS the payer is refused", async () => {
  const { quote, prepared } = await preparedFor();
  const relayerStub = createRelayerStub({ account: PAYER });
  await assert.rejects(
    broadcastSettlement({ relayer: relayerStub.relayer, prepared, quote, nowSeconds: NOW_SECONDS }),
    (error) => error.code === "RELAYER_IS_PAYER",
  );
  assert.equal(relayerStub.calls.sendTransaction.length, 0);
});

test("the relayer never becomes the authorization `from`", async () => {
  const { quote, prepared } = await preparedFor();
  const relayerStub = createRelayerStub();
  await broadcastSettlement({ relayer: relayerStub.relayer, prepared, quote, nowSeconds: NOW_SECONDS });

  const [tx] = relayerStub.calls.sendTransaction;
  const { authorization } = require("../src/splitter").decodeSettleCall(tx.data);
  assert.equal(authorization.from, PAYER);
  assert.notEqual(authorization.from, RELAYER);
  assert.equal(authorization.to, SPLITTER);
  assert.equal(authorization.value, quote.totalAmount);
});

test("the relayer receives exactly the prepared splitter transaction and nothing else", async () => {
  const { quote, prepared } = await preparedFor();
  const relayerStub = createRelayerStub();
  await broadcastSettlement({ relayer: relayerStub.relayer, prepared, quote, nowSeconds: NOW_SECONDS });

  const [tx] = relayerStub.calls.sendTransaction;
  assert.deepEqual(Object.keys(tx).sort(), ["data", "value", "to"].sort());
  assert.equal(getAddress(tx.to), SPLITTER);
  assert.ok(tx.data.startsWith(SETTLE_SELECTOR));
  assert.equal(tx.value, "0x0");
});

test("no Gate session token or Bankr credential ever reaches the relayer", async () => {
  const { quote, prepared } = await preparedFor();
  const relayerStub = createRelayerStub();
  await broadcastSettlement({ relayer: relayerStub.relayer, prepared, quote, nowSeconds: NOW_SECONDS });

  const serialized = JSON.stringify(relayerStub.calls.sendTransaction);
  for (const secret of ["token", "authorization", "Bearer", "session", "apiKey", "privateKey", "rpc"]) {
    assert.doesNotMatch(serialized, new RegExp(secret, "i"), `relayer saw ${secret}`);
  }
  // The only keys that crossed the boundary.
  for (const tx of relayerStub.calls.sendTransaction) {
    assert.deepEqual(Object.keys(tx).sort(), ["data", "to", "value"]);
  }
});

test("a substituted target is rejected", async () => {
  const { quote, prepared } = await preparedFor();
  const relayerStub = createRelayerStub();
  const hijacked = { ...prepared, to: getAddress(`0x${"9".repeat(40)}`) };

  assert.throws(
    () => assertPreparedTransaction(hijacked, quote, NOW_SECONDS),
    (error) => error.code === "PREPARED_TX_REJECTED" && /splitter/.test(error.message),
  );
  await assert.rejects(
    broadcastSettlement({ relayer: relayerStub.relayer, prepared: hijacked, quote, nowSeconds: NOW_SECONDS }),
    (error) => error.code === "PREPARED_TX_REJECTED",
  );
  assert.equal(relayerStub.calls.sendTransaction.length, 0);
});

test("mutated calldata is rejected", async () => {
  const { quote, prepared } = await preparedFor();
  const relayerStub = createRelayerStub();

  // A different quote's settle call, and a byte-level tamper of this one.
  const otherQuote = parseIssuedQuote(issuedQuote({ message: { attentionAmount: "9000000" }, totalAmount: "9250000" }));
  const swapped = { ...prepared, data: encodeSettleCall(otherQuote, `0x${"11".repeat(32)}${"22".repeat(32)}1b`) };
  // Tampered inside the quote id word, i.e. a change that alters execution.
  // The guard checks DECODED values, so it catches every mutation that changes
  // what the splitter would do with this calldata.
  const flipped = prepared.data[20] === "f" ? "e" : "f";
  const tampered = { ...prepared, data: `${prepared.data.slice(0, 20)}${flipped}${prepared.data.slice(21)}` };
  const wrongSelector = { ...prepared, data: `0xdeadbeef${prepared.data.slice(10)}` };

  for (const candidate of [swapped, tampered, wrongSelector]) {
    assert.throws(
      () => assertPreparedTransaction(candidate, quote, NOW_SECONDS),
      (error) => error.code === "PREPARED_TX_REJECTED",
    );
    await assert.rejects(
      broadcastSettlement({ relayer: relayerStub.relayer, prepared: candidate, quote, nowSeconds: NOW_SECONDS }),
      (error) => error.code === "PREPARED_TX_REJECTED",
    );
  }
  assert.equal(relayerStub.calls.sendTransaction.length, 0);
});

test("a nonzero ETH value is rejected", async () => {
  const { quote, prepared } = await preparedFor();
  const relayerStub = createRelayerStub();
  for (const value of ["0x1", "1", 1, "0xde0b6b3a7640000", undefined, null]) {
    assert.throws(
      () => assertPreparedTransaction({ ...prepared, value }, quote, NOW_SECONDS),
      (error) => error.code === "PREPARED_TX_REJECTED",
    );
  }
  await assert.rejects(
    broadcastSettlement({ relayer: relayerStub.relayer, prepared: { ...prepared, value: "0x1" }, quote, nowSeconds: NOW_SECONDS }),
    (error) => error.code === "PREPARED_TX_REJECTED",
  );
  assert.equal(relayerStub.calls.sendTransaction.length, 0);
});

test("a prepared transaction carrying extra fields is rejected", async () => {
  const { quote, prepared } = await preparedFor();
  for (const extra of [{ from: PAYER }, { gasPrice: "0x1" }, { token: "T".repeat(43) }]) {
    assert.throws(
      () => assertPreparedTransaction({ ...prepared, ...extra }, quote, NOW_SECONDS),
      (error) => error.code === "PREPARED_TX_REJECTED",
    );
  }
});

test("a prepared transaction for a DIFFERENT quote is rejected", async () => {
  const { prepared } = await preparedFor();
  const otherQuote = parseIssuedQuote(issuedQuote({ message: { quoteId: `0x${"b2".repeat(32)}` } }));
  assert.throws(
    () => assertPreparedTransaction(prepared, otherQuote, NOW_SECONDS),
    (error) => error.code === "PREPARED_TX_REJECTED" && /quote id/.test(error.message),
  );
});

test("an expired quote is never broadcast", async () => {
  const quote = parseIssuedQuote(issuedQuote({ message: { expiry: String(NOW_SECONDS + 60) } }));
  const { prepared } = await preparedFor(quote);
  const relayerStub = createRelayerStub();

  await assert.rejects(
    broadcastSettlement({ relayer: relayerStub.relayer, prepared, quote, nowSeconds: NOW_SECONDS + 61 }),
    (error) => error.code === "QUOTE_EXPIRED",
  );
  assert.equal(relayerStub.calls.sendTransaction.length, 0);
});

test("a missing relayer is a named blocker, never a Bankr broadcast fallback", async () => {
  const { quote, prepared } = await preparedFor();
  for (const relayer of [undefined, {}, { getAddress: async () => RELAYER }]) {
    await assert.rejects(
      broadcastPayment({ relayer, prepared, quote, now }),
      (error) => error.code === "RELAYER_UNAVAILABLE" && /does not broadcast/.test(error.message),
    );
  }
});

test("the relayer is only reachable through the prepared-transaction guard", async () => {
  // There is no arbitrary-call entry point: broadcastSettlement takes a quote
  // and re-derives the transaction from it every time.
  const { quote, prepared } = await preparedFor();
  const relayerStub = createRelayerStub();
  const arbitrary = { to: getAddress(`0x${"8".repeat(40)}`), data: "0xdeadbeef", value: "0x0" };
  await assert.rejects(
    broadcastSettlement({ relayer: relayerStub.relayer, prepared: arbitrary, quote, nowSeconds: NOW_SECONDS }),
    (error) => error.code === "PREPARED_TX_REJECTED",
  );
  assert.equal(relayerStub.calls.sendTransaction.length, 0);

  const ok = await broadcastSettlement({ relayer: relayerStub.relayer, prepared, quote, nowSeconds: NOW_SECONDS });
  assert.equal(ok.chainId, String(BASE_MAINNET));
});
