"use strict";

const assert = require("node:assert/strict");
const util = require("node:util");
const test = require("node:test");
const { Wallet, getAddress } = require("ethers");

const { createGateRelayer, createGateRelayerFromEnv } = require("../src/gate/relay-signer");

const RELAYER_KEY = `0x${"3".repeat(64)}`;
const RELAYER_ADDRESS = getAddress(new Wallet(RELAYER_KEY).address);
const SPLITTER = getAddress(`0x${"5e".repeat(20)}`);
const DATA = `0x0faf632d${"00".repeat(64)}`;
const CHAIN_ID = 8453;

function backend({ fail = false, hash = `0x${"ab".repeat(32)}` } = {}) {
  const sent = [];
  return {
    sent,
    signer: {
      address: RELAYER_ADDRESS,
      async sendTransaction(transaction) {
        sent.push(transaction);
        if (fail) throw new Error("insufficient funds for gas");
        return { hash };
      },
    },
  };
}

test("the relayer broadcasts exactly one zero-value settlement", async () => {
  const stub = backend();
  const relayer = createGateRelayer({ signer: stub.signer, chainId: CHAIN_ID });
  const hash = await relayer.sendSettlement({ to: SPLITTER, data: DATA, value: "0x0" });

  assert.equal(hash, `0x${"ab".repeat(32)}`);
  assert.equal(stub.sent.length, 1);
  assert.equal(stub.sent[0].to, SPLITTER);
  assert.equal(stub.sent[0].value, 0n);
  assert.equal(stub.sent[0].chainId, CHAIN_ID);
  assert.equal(relayer.address, RELAYER_ADDRESS);
});

test("the relayer refuses to send ETH or malformed calldata", async () => {
  const stub = backend();
  const relayer = createGateRelayer({ signer: stub.signer, chainId: CHAIN_ID });
  const refusals = [
    { to: SPLITTER, data: DATA, value: "0x1" },
    { to: SPLITTER, data: DATA, value: "1000000000000000000" },
    { to: SPLITTER, data: DATA, value: undefined },
    { to: SPLITTER, data: "0x", value: "0x0" },
    { to: SPLITTER, data: "not-hex", value: "0x0" },
    { to: "not-an-address", data: DATA, value: "0x0" },
    {},
  ];
  for (const transaction of refusals) {
    await assert.rejects(
      relayer.sendSettlement(transaction),
      (error) => error.code === "PREPARED_TX_REJECTED",
      `expected ${JSON.stringify(transaction)} to be refused`,
    );
  }
  assert.equal(stub.sent.length, 0);
});

test("a broadcast failure is reported without leaking the transaction", async () => {
  const relayer = createGateRelayer({ signer: backend({ fail: true }).signer, chainId: CHAIN_ID });
  await assert.rejects(
    relayer.sendSettlement({ to: SPLITTER, data: DATA, value: "0x0" }),
    (error) => error.code === "BROADCAST_FAILED" && error.statusCode === 502,
  );
});

test("a relayer that returns no usable hash is a failure, not a receipt", async () => {
  for (const hash of ["0xnope", "", null]) {
    const relayer = createGateRelayer({ signer: backend({ hash }).signer, chainId: CHAIN_ID });
    await assert.rejects(
      relayer.sendSettlement({ to: SPLITTER, data: DATA, value: "0x0" }),
      (error) => error.code === "BROADCAST_FAILED",
    );
  }
});

test("the key is unreachable by property access, serialization, or inspection", () => {
  const relayer = createGateRelayer({
    signer: RELAYER_KEY,
    provider: { getTransactionCount: async () => 0 },
    chainId: CHAIN_ID,
  });
  const description = `GavelGateRelayer<${RELAYER_ADDRESS}>`;
  assert.equal(String(relayer), description);
  assert.equal(JSON.stringify(relayer), JSON.stringify(description));
  assert.equal(util.inspect(relayer), description);
  assert.deepEqual(Object.keys(relayer).sort(), ["address", "chainId", "sendSettlement", "toJSON", "toString"]);
  assert.doesNotMatch(JSON.stringify(Object.values(relayer).map(String)), /3{16}/);
});

test("relay configuration is opt-in and all-or-nothing", () => {
  const provider = { getTransactionCount: async () => 0 };
  assert.equal(createGateRelayerFromEnv({}, { provider, chainId: CHAIN_ID }), null);
  assert.equal(createGateRelayerFromEnv({ GAVEL_GATE_RELAYER_KEY: "", GAVEL_GATE_RELAYER_ADDRESS: "" },
    { provider, chainId: CHAIN_ID }), null);

  const failures = [
    { GAVEL_GATE_RELAYER_KEY: RELAYER_KEY },
    { GAVEL_GATE_RELAYER_ADDRESS: RELAYER_ADDRESS },
    { GAVEL_GATE_RELAYER_KEY: "not-a-key", GAVEL_GATE_RELAYER_ADDRESS: RELAYER_ADDRESS },
    { GAVEL_GATE_RELAYER_KEY: RELAYER_KEY, GAVEL_GATE_RELAYER_ADDRESS: "not-an-address" },
    { GAVEL_GATE_RELAYER_KEY: RELAYER_KEY, GAVEL_GATE_RELAYER_ADDRESS: `0x${"9".repeat(40)}` },
  ];
  for (const env of failures) {
    assert.throws(() => createGateRelayerFromEnv(env, { provider, chainId: CHAIN_ID }), TypeError,
      `expected ${JSON.stringify(Object.keys(env))} to fail closed`);
  }

  const relayer = createGateRelayerFromEnv(
    { GAVEL_GATE_RELAYER_KEY: RELAYER_KEY, GAVEL_GATE_RELAYER_ADDRESS: RELAYER_ADDRESS.toLowerCase() },
    { provider, chainId: CHAIN_ID },
  );
  assert.equal(relayer.address, RELAYER_ADDRESS);
});

test("a raw key with no Base provider cannot be constructed", () => {
  assert.throws(() => createGateRelayer({ signer: RELAYER_KEY, chainId: CHAIN_ID }), /Base provider is required/);
  assert.throws(() => createGateRelayer({ signer: backend().signer, chainId: 0 }), /chainId/);
  assert.throws(() => createGateRelayer({ signer: { address: RELAYER_ADDRESS }, chainId: CHAIN_ID }),
    /sendTransaction/);
});

test("broadcasts are serialized so two settlements never race one account nonce", async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const relayer = createGateRelayer({
    chainId: CHAIN_ID,
    signer: {
      address: RELAYER_ADDRESS,
      async sendTransaction({ data }) {
        order.push(`start:${data.slice(-1)}`);
        if (data.endsWith("1")) await gate;
        order.push(`end:${data.slice(-1)}`);
        return { hash: `0x${"ab".repeat(32)}` };
      },
    },
  });

  const first = relayer.sendSettlement({ to: SPLITTER, data: `${DATA}1`, value: "0x0" });
  const second = relayer.sendSettlement({ to: SPLITTER, data: `${DATA}2`, value: "0x0" });
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["start:1", "end:1", "start:2", "end:2"]);
});

test("a failed broadcast does not wedge the account for the next one", async () => {
  let attempt = 0;
  const relayer = createGateRelayer({
    chainId: CHAIN_ID,
    signer: {
      address: RELAYER_ADDRESS,
      async sendTransaction() {
        attempt += 1;
        if (attempt === 1) throw new Error("insufficient funds for gas");
        return { hash: `0x${"cd".repeat(32)}` };
      },
    },
  });
  await assert.rejects(relayer.sendSettlement({ to: SPLITTER, data: DATA, value: "0x0" }),
    (error) => error.code === "BROADCAST_FAILED");
  assert.equal(await relayer.sendSettlement({ to: SPLITTER, data: DATA, value: "0x0" }), `0x${"cd".repeat(32)}`);
});
