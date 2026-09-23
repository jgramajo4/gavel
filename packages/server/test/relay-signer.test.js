"use strict";

const assert = require("node:assert/strict");
const util = require("node:util");
const test = require("node:test");
const { Wallet, getAddress } = require("ethers");

const { createGateRelayer, createGateRelayerFromEnv } = require("../src/gate/relay-signer");

const RELAYER_KEY = `0x${"3".repeat(64)}`;
const wallet = new Wallet(RELAYER_KEY);
const RELAYER_ADDRESS = getAddress(wallet.address);
const SPLITTER = getAddress(`0x${"5e".repeat(20)}`);
const DATA = `0x0faf632d${"00".repeat(64)}`;
const CHAIN_ID = 8453;

function backend({ failBroadcast = false, wrongHash = false } = {}) {
  const calls = { populate: [], simulate: [], sign: [], send: [], broadcast: [] };
  const provider = {
    async call(transaction) { calls.simulate.push(transaction); return "0x"; },
    async broadcastTransaction(rawTransaction) {
      calls.broadcast.push(rawTransaction);
      if (failBroadcast) throw new Error("RPC response lost");
      const parsed = require("ethers").Transaction.from(rawTransaction);
      return { hash: wrongHash ? `0x${"cd".repeat(32)}` : parsed.hash };
    },
  };
  return {
    calls,
    signer: {
      address: RELAYER_ADDRESS,
      provider,
      async populateTransaction(transaction) {
        calls.populate.push(transaction);
        return { ...transaction, nonce: 7, gasLimit: 100000n, maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n, type: 2 };
      },
      async signTransaction(transaction) { calls.sign.push(transaction); return wallet.signTransaction(transaction); },
      async sendTransaction(transaction) { calls.send.push(transaction); throw new Error("must never be called"); },
    },
  };
}

async function prepared(relayer) {
  return relayer.preflightSettlement({ to: SPLITTER, data: DATA, value: "0x0" });
}

test("preflight simulates and signs the exact zero-value settlement without broadcasting", async () => {
  const stub = backend();
  const relayer = createGateRelayer({ signer: stub.signer, chainId: CHAIN_ID });
  const result = await prepared(relayer);

  assert.match(result.txHash, /^0x[0-9a-f]{64}$/);
  assert.match(result.rawTransaction, /^0x[0-9a-f]+$/);
  assert.equal(stub.calls.populate.length, 1);
  assert.equal(stub.calls.simulate.length, 1);
  assert.equal(stub.calls.sign.length, 1);
  assert.equal(stub.calls.send.length, 0);
  assert.equal(stub.calls.broadcast.length, 0);
  const signed = require("ethers").Transaction.from(result.rawTransaction);
  assert.equal(signed.to, SPLITTER);
  assert.equal(signed.data, DATA);
  assert.equal(signed.value, 0n);
  assert.equal(signed.chainId, BigInt(CHAIN_ID));
});

test("broadcast sends only the already prepared raw transaction", async () => {
  const stub = backend();
  const relayer = createGateRelayer({ signer: stub.signer, chainId: CHAIN_ID });
  const result = await prepared(relayer);
  const hash = await relayer.broadcastSettlement(result);
  assert.equal(hash, result.txHash);
  assert.deepEqual(stub.calls.broadcast, [result.rawTransaction]);
  assert.equal(stub.calls.send.length, 0);
  assert.equal(stub.calls.populate.length, 1);
  assert.equal(stub.calls.sign.length, 1);
});

test("the relayer refuses malformed settlement input before simulation or signing", async () => {
  const stub = backend();
  const relayer = createGateRelayer({ signer: stub.signer, chainId: CHAIN_ID });
  for (const transaction of [
    { to: SPLITTER, data: DATA, value: "0x1" }, { to: SPLITTER, data: DATA },
    { to: SPLITTER, data: "0x", value: "0x0" }, { to: "bad", data: DATA, value: "0x0" }, {},
  ]) await assert.rejects(relayer.preflightSettlement(transaction), (error) => error.code === "PREPARED_TX_REJECTED");
  assert.equal(stub.calls.simulate.length, 0);
  assert.equal(stub.calls.sign.length, 0);
  assert.equal(stub.calls.send.length, 0);
});

test("broadcast rejects changed or mismatched prepared transactions", async () => {
  const stub = backend();
  const relayer = createGateRelayer({ signer: stub.signer, chainId: CHAIN_ID });
  const result = await prepared(relayer);
  await assert.rejects(relayer.broadcastSettlement({ ...result, txHash: `0x${"ef".repeat(32)}` }),
    (error) => error.code === "PREPARED_TX_REJECTED");
  await assert.rejects(relayer.broadcastSettlement({ ...result, rawTransaction: "0x12" }),
    (error) => error.code === "PREPARED_TX_REJECTED");
  assert.equal(stub.calls.broadcast.length, 0);
});

test("broadcast failures and returned hash mismatches are ambiguous failures", async () => {
  for (const options of [{ failBroadcast: true }, { wrongHash: true }]) {
    const stub = backend(options);
    const relayer = createGateRelayer({ signer: stub.signer, chainId: CHAIN_ID });
    const result = await prepared(relayer);
    await assert.rejects(relayer.broadcastSettlement(result), (error) => error.code === "BROADCAST_FAILED");
    assert.equal(stub.calls.broadcast.length, 1);
  }
});

test("the key is unreachable by property access, serialization, or inspection", () => {
  const provider = { getTransactionCount: async () => 0, call: async () => "0x", broadcastTransaction: async () => ({}) };
  const relayer = createGateRelayer({ signer: RELAYER_KEY, provider, chainId: CHAIN_ID });
  const description = `GavelGateRelayer<${RELAYER_ADDRESS}>`;
  assert.equal(String(relayer), description);
  assert.equal(JSON.stringify(relayer), JSON.stringify(description));
  assert.equal(util.inspect(relayer), description);
  assert.deepEqual(Object.keys(relayer).sort(), ["address", "broadcastSettlement", "chainId", "preflightSettlement", "toJSON", "toString"]);
  assert.doesNotMatch(JSON.stringify(Object.values(relayer).map(String)), /3{16}/);
});

test("relay configuration is opt-in and all-or-nothing", () => {
  const provider = { getTransactionCount: async () => 0, call: async () => "0x", broadcastTransaction: async () => ({}) };
  assert.equal(createGateRelayerFromEnv({}, { provider, chainId: CHAIN_ID }), null);
  const failures = [
    { GAVEL_GATE_RELAYER_KEY: RELAYER_KEY }, { GAVEL_GATE_RELAYER_ADDRESS: RELAYER_ADDRESS },
    { GAVEL_GATE_RELAYER_KEY: "not-a-key", GAVEL_GATE_RELAYER_ADDRESS: RELAYER_ADDRESS },
    { GAVEL_GATE_RELAYER_KEY: RELAYER_KEY, GAVEL_GATE_RELAYER_ADDRESS: "not-an-address" },
    { GAVEL_GATE_RELAYER_KEY: RELAYER_KEY, GAVEL_GATE_RELAYER_ADDRESS: `0x${"9".repeat(40)}` },
  ];
  for (const env of failures) assert.throws(() => createGateRelayerFromEnv(env, { provider, chainId: CHAIN_ID }), TypeError);
  assert.equal(createGateRelayerFromEnv({ GAVEL_GATE_RELAYER_KEY: RELAYER_KEY,
    GAVEL_GATE_RELAYER_ADDRESS: RELAYER_ADDRESS.toLowerCase() }, { provider, chainId: CHAIN_ID }).address, RELAYER_ADDRESS);
});

test("preflight requires preparation, simulation, signing, and raw broadcast capabilities", () => {
  assert.throws(() => createGateRelayer({ signer: RELAYER_KEY, chainId: CHAIN_ID }), /Base provider/);
  assert.throws(() => createGateRelayer({ signer: backend().signer, chainId: 0 }), /chainId/);
  for (const missing of ["populateTransaction", "signTransaction"]) {
    const value = backend().signer; delete value[missing];
    assert.throws(() => createGateRelayer({ signer: value, chainId: CHAIN_ID }), new RegExp(missing));
  }
  const noSimulation = backend().signer; delete noSimulation.provider.call;
  assert.throws(() => createGateRelayer({ signer: noSimulation, chainId: CHAIN_ID }), /provider.call/);
  const noBroadcast = backend().signer; delete noBroadcast.provider.broadcastTransaction;
  assert.throws(() => createGateRelayer({ signer: noBroadcast, chainId: CHAIN_ID }), /broadcastTransaction/);
});
