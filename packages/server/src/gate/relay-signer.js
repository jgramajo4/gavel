"use strict";

const util = require("node:util");
const { Wallet, getAddress } = require("ethers");
const { redactSignerMaterial } = require("./quote-signer");

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * The funded Gate relayer: a GAS-ONLY wallet.
 *
 * This account never holds, receives, or moves USDC. It cannot: the only thing
 * it is ever asked to send is a `settle` call whose EIP-3009 authorization pays
 * FROM the payer TO the splitter, and this signer refuses any transaction that
 * is not exactly `{ to, data, value: 0 }`. It has no token allowance to spend,
 * no transfer path, and no balance the splitter would read.
 *
 * Operationally that means: fund it with ETH for gas and nothing else. A USDC
 * balance on this address is an operator mistake, not a capability.
 *
 * As with the quote signer, neither the key nor the wrapped Wallet is stored on
 * the returned object, so it cannot be reached by property access, enumeration,
 * JSON serialization, or util.inspect.
 */
class GateRelayerError extends Error {
  constructor(code, message, statusCode = 502) {
    super(redactSignerMaterial(String(message)));
    this.name = "GateRelayerError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function assertBroadcastInterface(value) {
  if (!value || typeof value.sendTransaction !== "function") {
    throw new TypeError("relayer must be a private key or an object exposing sendTransaction");
  }
  let address;
  try {
    address = getAddress(String(value.address));
  } catch {
    throw new TypeError("relayer address is invalid");
  }
  return { address, sendTransaction: (transaction) => value.sendTransaction(transaction) };
}

/**
 * `signer` is either a raw key (deployment secret store) or an injected
 * broadcasting interface (KMS/HSM, or a test double). A raw key additionally
 * requires the Base provider this deployment already holds; no relayer ever
 * opens an RPC endpoint of its own, and the RPC credential never leaves the
 * process.
 */
function createGateRelayer({ signer, provider, chainId } = {}) {
  const chain = Number(chainId);
  if (!Number.isSafeInteger(chain) || chain < 1) throw new TypeError("relayer chainId must be a positive integer");
  let backend;
  if (typeof signer === "string") {
    if (!PRIVATE_KEY.test(signer)) throw new TypeError("relayer key must be a 32-byte hex private key");
    if (!provider || typeof provider.getTransactionCount !== "function") {
      throw new TypeError("a Base provider is required to broadcast with a raw relayer key");
    }
    let wallet;
    try {
      wallet = new Wallet(signer, provider);
    } catch {
      throw new TypeError("relayer key is invalid");
    }
    backend = assertBroadcastInterface({
      address: wallet.address,
      sendTransaction: (transaction) => wallet.sendTransaction(transaction),
    });
  } else {
    backend = assertBroadcastInterface(signer);
  }

  // Broadcasts are serialized. Two settlements racing for the same account
  // nonce would leave one of them rejected as a duplicate or a replacement, and
  // an operator staring at a transaction that never appeared.
  let queue = Promise.resolve();

  /**
   * Broadcasts ONE prepared Gate settlement.
   *
   * The three fields are re-checked here, at the last possible moment, because
   * this is the only place in the process that can spend money. A non-zero
   * value, a missing destination, or empty calldata is refused rather than
   * signed.
   */
  async function sendSettlement(transaction) {
    const next = queue.then(() => broadcast(transaction ?? {}), () => broadcast(transaction ?? {}));
    // The queue follows the attempt whether it settled or failed, so one failed
    // broadcast never wedges the account.
    queue = next.catch(() => {});
    return next;
  }

  async function broadcast({ to, data, value } = {}) {
    let destination;
    try {
      destination = getAddress(String(to));
    } catch {
      throw new GateRelayerError("PREPARED_TX_REJECTED", "the relayer was given no usable destination", 400);
    }
    if (typeof data !== "string" || !/^0x[0-9a-fA-F]{8,}$/.test(data)) {
      throw new GateRelayerError("PREPARED_TX_REJECTED", "the relayer was given no usable calldata", 400);
    }
    let wei;
    try {
      wei = BigInt(value);
    } catch {
      throw new GateRelayerError("PREPARED_TX_REJECTED", "the relayer was given an unreadable value", 400);
    }
    // Gas only. A Gate settlement never sends ETH.
    if (wei !== 0n) throw new GateRelayerError("PREPARED_TX_REJECTED", "the relayer never sends ETH", 400);

    // The backend estimates gas before it signs, so a settlement that would
    // revert — a spent EIP-3009 nonce, a payer who moved the USDC after
    // authorizing — never reaches the chain and costs nothing. That is what
    // keeps this endpoint from being a way to burn the relayer's ETH, so an
    // injected broadcasting interface MUST preserve it.
    let sent;
    try {
      sent = await backend.sendTransaction({ to: destination, data, value: 0n, chainId: chain });
    } catch (error) {
      throw new GateRelayerError("BROADCAST_FAILED", `relayer broadcast failed: ${error?.message ?? "unknown error"}`);
    }
    const hash = typeof sent === "string" ? sent : sent?.hash;
    if (typeof hash !== "string" || !TX_HASH.test(hash)) {
      throw new GateRelayerError("BROADCAST_FAILED", "the relayer returned no usable transaction hash");
    }
    return hash.toLowerCase();
  }

  const description = `GavelGateRelayer<${backend.address}>`;
  return Object.freeze({
    address: backend.address,
    chainId: chain,
    sendSettlement,
    toJSON: () => description,
    toString: () => description,
    [util.inspect.custom]: () => description,
  });
}

/**
 * The relayer secret is a Gate-service runtime secret only: it belongs in the
 * deployment secret store, never in the root app `.env`, the browser bundle,
 * the CLI config, Postgres, or any log line.
 *
 * Returns null when no relay is configured, so a Gate deployment that does not
 * relay simply has no relay route. Partial configuration fails startup.
 */
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
