"use strict";

const util = require("node:util");
const { Transaction, Wallet, getAddress } = require("ethers");
const { redactSignerMaterial } = require("./quote-signer");

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const RAW_TX = /^0x[0-9a-fA-F]+$/;

class GateRelayerError extends Error {
  constructor(code, message, statusCode = 502) {
    super(redactSignerMaterial(String(message)));
    this.name = "GateRelayerError";
    this.code = code;
    this.statusCode = statusCode;
    if (code === "PREFLIGHT_FAILED" || code === "PREPARED_TX_REJECTED") this.definitelyNotSent = true;
  }
}

function assertPreparationInterface(value) {
  if (!value || typeof value.populateTransaction !== "function") {
    throw new TypeError("relayer signer must expose populateTransaction");
  }
  if (typeof value.signTransaction !== "function") throw new TypeError("relayer signer must expose signTransaction");
  if (!value.provider || typeof value.provider.call !== "function") {
    throw new TypeError("relayer signer provider.call is required for simulation");
  }
  if (typeof value.provider.broadcastTransaction !== "function") {
    throw new TypeError("relayer signer provider.broadcastTransaction is required");
  }
  let address;
  try { address = getAddress(String(value.address)); } catch { throw new TypeError("relayer address is invalid"); }
  return {
    address,
    populateTransaction: (transaction) => value.populateTransaction(transaction),
    signTransaction: (transaction) => value.signTransaction(transaction),
    simulateTransaction: (transaction) => value.provider.call(transaction),
    broadcastTransaction: (rawTransaction) => value.provider.broadcastTransaction(rawTransaction),
  };
}

function safeSettlement({ to, data, value } = {}, chain) {
  let destination;
  try { destination = getAddress(String(to)); } catch {
    throw new GateRelayerError("PREPARED_TX_REJECTED", "the relayer was given no usable destination", 400);
  }
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{8,}$/.test(data)) {
    throw new GateRelayerError("PREPARED_TX_REJECTED", "the relayer was given no usable calldata", 400);
  }
  let wei;
  try { wei = BigInt(value); } catch {
    throw new GateRelayerError("PREPARED_TX_REJECTED", "the relayer was given an unreadable value", 400);
  }
  if (wei !== 0n) throw new GateRelayerError("PREPARED_TX_REJECTED", "the relayer never sends ETH", 400);
  return { to: destination, data: data.toLowerCase(), value: 0n, chainId: chain };
}

function assertExactTransaction(transaction, expected, label) {
  let to;
  let value;
  let chainId;
  try {
    to = getAddress(String(transaction?.to));
    value = BigInt(transaction?.value ?? 0);
    chainId = BigInt(transaction?.chainId);
  } catch {
    throw new GateRelayerError("PREPARED_TX_REJECTED", `${label} transaction identity is invalid`, 400);
  }
  if (to !== expected.to || String(transaction?.data).toLowerCase() !== expected.data
      || value !== 0n || chainId !== BigInt(expected.chainId)) {
    throw new GateRelayerError("PREPARED_TX_REJECTED", `${label} transaction changed the prepared settlement`, 400);
  }
}

/**
 * Constructs the funded Gate gas-only relayer. Preflight and broadcast are
 * deliberately separate: preflight populates, simulates and signs but has no
 * path to send; broadcast accepts only those immutable signed bytes.
 */
function createGateRelayer({ signer, provider, chainId } = {}) {
  const chain = Number(chainId);
  if (!Number.isSafeInteger(chain) || chain < 1) throw new TypeError("relayer chainId must be a positive integer");
  let value = signer;
  if (typeof signer === "string") {
    if (!PRIVATE_KEY.test(signer)) throw new TypeError("relayer key must be a 32-byte hex private key");
    if (!provider || typeof provider.getTransactionCount !== "function") {
      throw new TypeError("a Base provider is required to prepare and broadcast with a raw relayer key");
    }
    try { value = new Wallet(signer, provider); } catch { throw new TypeError("relayer key is invalid"); }
  }
  const backend = assertPreparationInterface(value);
  let queue = Promise.resolve();

  async function preflightSettlement(transaction) {
    const expected = safeSettlement(transaction ?? {}, chain);
    let populated;
    let rawTransaction;
    try {
      populated = await backend.populateTransaction(expected);
      assertExactTransaction(populated, expected, "populated");
      await backend.simulateTransaction(populated);
      rawTransaction = await backend.signTransaction(populated);
    } catch (error) {
      if (error instanceof GateRelayerError) throw error;
      throw new GateRelayerError("PREFLIGHT_FAILED", `relayer preflight failed: ${error?.message ?? "unknown error"}`);
    }
    if (typeof rawTransaction !== "string" || !RAW_TX.test(rawTransaction)) {
      throw new GateRelayerError("PREFLIGHT_FAILED", "relayer signing returned no usable raw transaction");
    }
    let signed;
    try { signed = Transaction.from(rawTransaction); } catch {
      throw new GateRelayerError("PREFLIGHT_FAILED", "relayer signing returned an invalid raw transaction");
    }
    assertExactTransaction(signed, expected, "signed");
    if (!signed.hash || !TX_HASH.test(signed.hash)) {
      throw new GateRelayerError("PREFLIGHT_FAILED", "relayer signing returned no deterministic transaction hash");
    }
    return Object.freeze({ txHash: signed.hash.toLowerCase(), rawTransaction: rawTransaction.toLowerCase() });
  }

  async function broadcast(prepared) {
    if (!prepared || Object.keys(prepared).sort().join(",") !== "rawTransaction,txHash"
        || typeof prepared.rawTransaction !== "string" || !RAW_TX.test(prepared.rawTransaction)
        || typeof prepared.txHash !== "string" || !TX_HASH.test(prepared.txHash)) {
      throw new GateRelayerError("PREPARED_TX_REJECTED", "prepared transaction is invalid", 400);
    }
    let signed;
    try { signed = Transaction.from(prepared.rawTransaction); } catch {
      throw new GateRelayerError("PREPARED_TX_REJECTED", "prepared raw transaction is invalid", 400);
    }
    const expectedHash = String(signed.hash).toLowerCase();
    if (expectedHash !== prepared.txHash.toLowerCase() || signed.chainId !== BigInt(chain)
        || signed.value !== 0n || !signed.to || !/^0x[0-9a-fA-F]{8,}$/.test(signed.data)) {
      throw new GateRelayerError("PREPARED_TX_REJECTED", "prepared transaction identity does not match signed bytes", 400);
    }
    let sent;
    try { sent = await backend.broadcastTransaction(prepared.rawTransaction); } catch (error) {
      throw new GateRelayerError("BROADCAST_FAILED", `relayer broadcast failed: ${error?.message ?? "unknown error"}`);
    }
    const hash = typeof sent === "string" ? sent : sent?.hash;
    if (typeof hash !== "string" || !TX_HASH.test(hash) || hash.toLowerCase() !== expectedHash) {
      throw new GateRelayerError("BROADCAST_FAILED", "relayer broadcast hash did not match the prepared transaction");
    }
    return expectedHash;
  }

  function broadcastSettlement(prepared) {
    const next = queue.then(() => broadcast(prepared), () => broadcast(prepared));
    queue = next.catch(() => {});
    return next;
  }

  const description = `GavelGateRelayer<${backend.address}>`;
  return Object.freeze({
    address: backend.address,
    chainId: chain,
    preflightSettlement,
    broadcastSettlement,
    toJSON: () => description,
    toString: () => description,
    [util.inspect.custom]: () => description,
  });
}

function createGateRelayerFromEnv(env = {}, { provider, chainId } = {}) {
  const key = env.GAVEL_GATE_RELAYER_KEY;
  const declared = env.GAVEL_GATE_RELAYER_ADDRESS;
  if ((key === undefined || key === "") && (declared === undefined || declared === "")) return null;
  if (typeof key !== "string" || key === "") {
    throw new TypeError("GAVEL_GATE_RELAYER_KEY is required in the Gate service runtime secret store");
  }
  if (!PRIVATE_KEY.test(key)) throw new TypeError("GAVEL_GATE_RELAYER_KEY must be a 32-byte hex private key");
  if (typeof declared !== "string" || !ADDRESS.test(declared)) {
    throw new TypeError("GAVEL_GATE_RELAYER_ADDRESS must be an Ethereum address");
  }
  const relayer = createGateRelayer({ signer: key, provider, chainId });
  if (getAddress(declared) !== relayer.address) {
    throw new TypeError("GAVEL_GATE_RELAYER_KEY does not match GAVEL_GATE_RELAYER_ADDRESS");
  }
  return relayer;
}

module.exports = { GateRelayerError, createGateRelayer, createGateRelayerFromEnv };
