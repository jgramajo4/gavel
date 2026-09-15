"use strict";

const util = require("node:util");
const { Wallet, getAddress } = require("ethers");
const {
  QUOTE_PRIMARY_TYPE,
  QUOTE_TYPES,
  buildQuoteMessage,
  createQuoteDomain,
  createQuoteTypedData,
} = require("@gavel/gate");

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
// Any 32-byte or signature-length hex run is treated as secret material in logs.
const SECRET_HEX = /0x[0-9a-fA-F]{64,}/g;

// Every log line, error message, and stack that a Gate operator can ever see
// passes through this. It is deliberately blunt: losing a hex identifier from a
// log is cheaper than leaking one byte of signer or signature material.
function redactSignerMaterial(value) {
  if (typeof value !== "string") return value;
  return value.replace(SECRET_HEX, "0x[redacted]");
}

class QuoteSignerError extends Error {
  constructor(message) {
    super(redactSignerMaterial(String(message)));
    this.name = "QuoteSignerError";
    this.code = "QUOTE_SIGNER_UNAVAILABLE";
    this.statusCode = 503;
  }
}

function assertSigningInterface(value) {
  if (!value || typeof value.signTypedData !== "function") {
    throw new TypeError("quote signer must be a private key or an object exposing signTypedData");
  }
  let address;
  try {
    address = getAddress(String(value.address));
  } catch {
    throw new TypeError("quote signer address is invalid");
  }
  return { address, signTypedData: (domain, types, message) => value.signTypedData(domain, types, message) };
}

// `signer` is either a raw key (dev/self-hosted secret file) or an injected
// signing interface (KMS/HSM). Neither the key nor the wrapped Wallet is ever
// stored on the returned object, so it cannot be reached by property access,
// enumeration, JSON serialization, or util.inspect.
function createQuoteSigner({ signer, chainId, splitter } = {}) {
  const domain = createQuoteDomain({ chainId, verifyingContract: splitter });
  let backend;
  if (typeof signer === "string") {
    if (!PRIVATE_KEY.test(signer)) throw new TypeError("quote signer key must be a 32-byte hex private key");
    let wallet;
    try {
      wallet = new Wallet(signer);
    } catch {
      throw new TypeError("quote signer key is invalid");
    }
    backend = assertSigningInterface({
      address: wallet.address,
      signTypedData: (typedDomain, types, message) => wallet.signTypedData(typedDomain, types, message),
    });
  } else {
    backend = assertSigningInterface(signer);
  }

  const types = Object.freeze({ [QUOTE_PRIMARY_TYPE]: QUOTE_TYPES });

  async function signQuote(message) {
    let typed;
    try {
      typed = createQuoteTypedData(buildQuoteMessage(message), domain);
    } catch (error) {
      throw new QuoteSignerError(`refusing to sign an invalid quote: ${error.message}`);
    }
    let signature;
    try {
      signature = await backend.signTypedData(typed.domain, types, typed.message);
    } catch (error) {
      throw new QuoteSignerError(`quote signing failed: ${error?.message ?? "unknown error"}`);
    }
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      throw new QuoteSignerError("quote signer returned an invalid signature");
    }
    return signature;
  }

  const description = `GavelGateQuoteSigner<${backend.address}>`;
  const instance = {
    address: backend.address,
    domain,
    signQuote,
    toJSON: () => description,
    toString: () => description,
    [util.inspect.custom]: () => description,
  };
  return Object.freeze(instance);
}

// The signer secret is a Gate-service runtime secret only: it belongs in the
// deployment secret store, never in the root app .env, the browser bundle, the
// CLI config, Postgres, or any log line.
function createQuoteSignerFromEnv(env = {}, { chainId, splitter } = {}) {
  const key = env.GAVEL_GATE_QUOTE_SIGNER;
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("GAVEL_GATE_QUOTE_SIGNER is required in the Gate service runtime secret store");
  }
  if (!PRIVATE_KEY.test(key)) throw new TypeError("GAVEL_GATE_QUOTE_SIGNER must be a 32-byte hex private key");
  const signer = createQuoteSigner({ signer: key, chainId, splitter });
  const declared = env.GAVEL_GATE_QUOTE_SIGNER_ADDRESS;
  if (declared !== undefined) {
    let expected;
    try {
      expected = getAddress(String(declared));
    } catch {
      throw new TypeError("GAVEL_GATE_QUOTE_SIGNER_ADDRESS is invalid");
    }
    if (expected !== signer.address) {
      throw new TypeError("GAVEL_GATE_QUOTE_SIGNER does not match GAVEL_GATE_QUOTE_SIGNER_ADDRESS");
    }
  }
  return signer;
}

module.exports = { QuoteSignerError, createQuoteSigner, createQuoteSignerFromEnv, redactSignerMaterial };
