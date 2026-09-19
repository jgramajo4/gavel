"use strict";

const { getAddress } = require("ethers");
const { BankrGateError } = require("./errors");

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

const EIP712_DOMAIN_TYPE = Object.freeze([
  Object.freeze({ name: "name", type: "string" }),
  Object.freeze({ name: "version", type: "string" }),
  Object.freeze({ name: "chainId", type: "uint256" }),
  Object.freeze({ name: "verifyingContract", type: "address" }),
]);

/**
 * The wallet capability surface this integration needs from Bankr.
 *
 * Bankr owns the keys. This integration asks for signatures and one transaction
 * and receives back only public material: an address, a chain id, an EIP-712
 * signature, a transaction hash, and `eth_call` results. It never asks for,
 * accepts, derives, stores, or logs a private key or a seed phrase, and there
 * is no code path here that could use one.
 *
 *   getAddress()                           -> 0x-address of the payer
 *   getChainId()                           -> number
 *   switchChain(chainId)                   -> optional; moves the wallet
 *   signTypedData({domain,types,primaryType,message}) -> 65-byte signature
 *   sendTransaction({from,to,data,value})  -> transaction hash
 *   call({to,data})                        -> hex return data
 *
 * Only `switchChain` is optional. A wallet missing any other capability is
 * refused up front, before an advocate is shown a price.
 */
const REQUIRED_CAPABILITIES = Object.freeze(["getAddress", "getChainId", "signTypedData", "sendTransaction", "call"]);

function assertWalletCapabilities(wallet) {
  const missing = REQUIRED_CAPABILITIES.filter((name) => typeof wallet?.[name] !== "function");
  if (missing.length) {
    throw new BankrGateError(
      "WALLET_CAPABILITY_MISSING",
      `This Bankr wallet cannot ${missing.join(", ")}. Gate payment needs typed-data signing, a contract read, and one transaction.`,
    );
  }
  return wallet;
}

function assertAddress(value, label) {
  if (typeof value !== "string" || !ADDRESS.test(value)) {
    throw new BankrGateError("WALLET_UNAVAILABLE", `The wallet did not return a usable ${label}.`);
  }
  return getAddress(value);
}

function assertSignature(value) {
  // A malformed signature is still signature material: it is never echoed.
  if (typeof value !== "string" || !SIGNATURE.test(value)) {
    throw new BankrGateError("AUTHORIZATION_FAILED", "The wallet returned an unusable signature.");
  }
  return value;
}

function assertTxHash(value) {
  if (typeof value !== "string" || !TX_HASH.test(value)) {
    throw new BankrGateError("BROADCAST_FAILED", "The wallet did not return a transaction hash.");
  }
  return value.toLowerCase();
}

/**
 * Serializes one typed-data payload for a wallet that wants the EIP-712 JSON.
 *
 * This is the ONLY adaptation layer. It adds the `EIP712Domain` type entry that
 * `eth_signTypedData_v4` requires and changes nothing else: the domain, the
 * ordered types, the primary type, and every message field pass through exactly
 * as Gate issued them, so the digest a wallet signs is Gate's digest.
 */
function serializeTypedData(payload) {
  if (!payload || typeof payload !== "object" || !payload.domain || !payload.types
      || typeof payload.primaryType !== "string" || !payload.message) {
    throw new BankrGateError("INVALID_TYPED_DATA", "Typed data is incomplete.");
  }
  return {
    domain: payload.domain,
    types: { EIP712Domain: [...EIP712_DOMAIN_TYPE], ...payload.types },
    primaryType: payload.primaryType,
    message: payload.message,
  };
}

/**
 * Adapts an EIP-1193 provider (what a Bankr sandbox exposes for a connected
 * wallet) to the capability surface above.
 */
function createEip1193Wallet(provider) {
  if (!provider || typeof provider.request !== "function") {
    throw new BankrGateError("WALLET_UNAVAILABLE", "An EIP-1193 provider with a request method is required.");
  }
  return Object.freeze({
    async getAddress() {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const [account] = Array.isArray(accounts) ? accounts : [];
      return assertAddress(account, "account");
    },
    async getChainId() {
      const raw = await provider.request({ method: "eth_chainId" });
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new BankrGateError("WRONG_CHAIN", "The wallet did not report a usable chain.");
      }
      return value;
    },
    async switchChain(chainId) {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${Number(chainId).toString(16)}` }],
      });
    },
    async signTypedData(payload) {
      const signature = await provider.request({
        method: "eth_signTypedData_v4",
        params: [getAddress(payload.account ?? (await this.getAddress())), JSON.stringify(serializeTypedData(payload))],
      });
      return assertSignature(signature);
    },
    async sendTransaction({ from, to, data, value = "0x0" }) {
      const txHash = await provider.request({
        method: "eth_sendTransaction",
        params: [{ from: getAddress(from), to: getAddress(to), data, value }],
      });
      return assertTxHash(txHash);
    },
    async call({ to, data }) {
      const result = await provider.request({ method: "eth_call", params: [{ to: getAddress(to), data }, "latest"] });
      if (typeof result !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(result)) {
        throw new BankrGateError("CHAIN_READ_FAILED", "A contract read failed.");
      }
      return result;
    },
  });
}

/**
 * Moves the wallet to the chain the SERVER bound this quote to.
 *
 * The chain id is never hard-coded here; it comes from `quote.domain.chainId`,
 * which Gate signed over.
 */
async function ensureChain(wallet, chainId) {
  const current = await wallet.getChainId();
  if (Number(current) === Number(chainId)) return Number(chainId);
  if (typeof wallet.switchChain !== "function") {
    throw new BankrGateError(
      "WRONG_CHAIN",
      `This wallet is on chain ${current}, and this quote is for chain ${chainId}. Switch the wallet and try again.`,
    );
  }
  await wallet.switchChain(Number(chainId));
  const moved = await wallet.getChainId();
  if (Number(moved) !== Number(chainId)) {
    throw new BankrGateError(
      "WRONG_CHAIN",
      `The wallet is not on chain ${chainId}, which this quote was issued for.`,
    );
  }
  return Number(moved);
}

module.exports = {
  EIP712_DOMAIN_TYPE,
  REQUIRED_CAPABILITIES,
  assertAddress,
  assertSignature,
  assertTxHash,
  assertWalletCapabilities,
  createEip1193Wallet,
  ensureChain,
  serializeTypedData,
};
