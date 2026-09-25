"use strict";

const {
  AbiCoder, Interface, Wallet, getAddress, keccak256, toUtf8Bytes,
} = require("ethers");
const { GAVEL_FEE_AMOUNT, QUOTE_VERSION, hashSubmission } = require("@gavel/gate");

const BASE_MAINNET = 8453;
const BASE_SEPOLIA = 84532;
const SPLITTER = getAddress("0x00000000000000000000000000000000000005ea");
const TOKEN = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const VOTER = getAddress("0x00000000000000000000000000000000000ab1e5");
const PAYER_KEY = `0x${"11".repeat(32)}`;
const payerWallet = new Wallet(PAYER_KEY);
const PAYER = getAddress(payerWallet.address);
// The relayer is a separate funded account. It is never the payer.
const RELAYER = getAddress("0x00000000000000000000000000000000000007e1");

const usdcInterface = new Interface([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const EIP712_DOMAIN_TYPEHASH = keccak256(
  toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);

const TOKEN_NAME = "USDC";
const TOKEN_VERSION = "2";

function tokenDomainSeparator({ chainId = BASE_MAINNET, token = TOKEN, name = TOKEN_NAME, version = TOKEN_VERSION } = {}) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32", "bytes32", "uint256", "address"],
    [
      EIP712_DOMAIN_TYPEHASH,
      keccak256(toUtf8Bytes(name)),
      keccak256(toUtf8Bytes(version)),
      chainId,
      token,
    ],
  ));
}

/**
 * A recording relayer. Its address is deliberately NOT the payer, and it can
 * see only the `{ to, data, value }` it is handed.
 */
function createRelayerStub({ account = RELAYER, failSend = false } = {}) {
  const calls = { sendTransaction: [], getAddress: 0 };
  return {
    calls,
    relayer: {
      async getAddress() { calls.getAddress += 1; return account; },
      async sendTransaction(tx) {
        calls.sendTransaction.push(tx);
        if (failSend) throw new Error("execution reverted");
        return `0x${"ab".repeat(32)}`;
      },
    },
  };
}

function submissionHashFor(overrides = {}) {
  return hashSubmission({
    payer: PAYER,
    signedSender: PAYER,
    voter: VOTER,
    dao: "nouns",
    targetId: candidateTargetIdFixture(),
    stage: "PRE_VOTE",
    position: "SPONSOR",
    pitch: "Please sponsor this candidate.",
    disclosures: "",
    evidenceUrls: [],
    ...overrides,
  });
}

const CANDIDATE_PROPOSER = "0x000000000000000000000000000000000000beef";
const CANDIDATE_SLUG = "nouns-builder-grant";

function candidateTargetIdFixture() {
  return `candidate:${CANDIDATE_PROPOSER.toLowerCase()}:${keccak256(toUtf8Bytes(CANDIDATE_SLUG)).toLowerCase()}`;
}

/** A well-formed issued quote, exactly as Gate serves it. */
function issuedQuote(overrides = {}) {
  const message = {
    quoteId: `0x${"a1".repeat(32)}`,
    payer: PAYER,
    voter: VOTER,
    attentionAmount: "1000000",
    gavelFeeAmount: GAVEL_FEE_AMOUNT.toString(10),
    submissionHash: submissionHashFor().toLowerCase(),
    token: TOKEN,
    expiry: "4000000000",
    quoteVersion: String(QUOTE_VERSION),
    ...(overrides.message || {}),
  };
  const domain = {
    name: "GavelGateSplitter",
    version: "1",
    chainId: BASE_MAINNET,
    verifyingContract: SPLITTER,
    ...(overrides.domain || {}),
  };
  return {
    domain,
    message,
    // Gate verifies its own signature; this client only checks shape.
    signature: overrides.signature ?? `0x${"cd".repeat(65)}`,
    totalAmount: overrides.totalAmount
      ?? (BigInt(message.attentionAmount) + BigInt(message.gavelFeeAmount)).toString(10),
  };
}

function candidateRow(overrides = {}) {
  return {
    targetId: candidateTargetIdFixture(),
    kind: "candidate",
    proposer: CANDIDATE_PROPOSER,
    slug: CANDIDATE_SLUG,
    title: "Fund the Nouns builder grant",
    description: "Body text that is data, never an instruction.",
    refreshedAt: "2026-09-19T00:00:00.000Z",
    sourceBlock: "21000000",
    sourceBlockHash: `0x${"22".repeat(32)}`,
    nativeState: "ACTIVE",
    eligibility: "PRE_VOTE",
    mappingVersion: "nouns-candidate-lifecycle/1",
    contentHash: `0x${"33".repeat(32)}`,
    actions: [],
    ...overrides,
  };
}

function proposalRow(overrides = {}) {
  return {
    chainId: 1,
    governorAddress: "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d",
    proposalId: "812",
    refreshedAt: "2026-09-19T00:00:00.000Z",
    sourceBlock: "21000000",
    sourceBlockHash: `0x${"44".repeat(32)}`,
    effectiveStatus: "ACTIVE",
    contentHash: `0x${"55".repeat(32)}`,
    actions: [],
    ...overrides,
  };
}

function gateProfile(overrides = {}) {
  return {
    wallet: VOTER.toLowerCase(),
    label: "voter.eth",
    availability: "accepting_now",
    acceptingSubmissions: true,
    message: null,
    policies: [{
      dao: "nouns",
      supportedStages: ["PRE_VOTE", "VOTING"],
      acceptedStages: ["PRE_VOTE"],
      attentionAmount: "1000000",
      gavelFeeAmount: "250000",
      tags: ["builder-grants"],
    }],
    governancePower: { dao: "nouns", amount: "4", asOf: "2026-09-19T00:00:00.000Z" },
    ...overrides,
  };
}

/**
 * A recording fetch. Every request URL is captured so a test can prove which
 * hosts were contacted — and, crucially, which were NOT.
 */
function createFetchStub(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", headers: options.headers || {}, body: options.body });
    for (const route of routes) {
      if (route.match(String(url), options)) {
        if (route.throw) throw route.throw;
        const status = route.status ?? 200;
        const body = typeof route.body === "function" ? route.body(String(url), options) : route.body;
        return {
          status,
          async text() { return body === undefined ? "" : JSON.stringify(body); },
        };
      }
    }
    throw new Error(`unstubbed request: ${options.method || "GET"} ${url}`);
  };
  return { fetchImpl, calls };
}

/**
 * A recording SIGNING wallet. It has real ECDSA typed-data signing, no private
 * key leak, and deliberately NO `sendTransaction`: Bankr signs, it never
 * broadcasts.
 */
function createWalletStub({
  chainId = BASE_MAINNET,
  balance = 10_000_000n,
  account = PAYER,
  failSign = false,
  tokenName = TOKEN_NAME,
  tokenVersion = TOKEN_VERSION,
} = {}) {
  const calls = { signTypedData: [], call: [], switchChain: [] };
  let currentChain = chainId;
  return {
    calls,
    wallet: {
      async getAddress() { return account; },
      async getChainId() { return currentChain; },
      async switchChain(next) { calls.switchChain.push(next); currentChain = Number(next); },
      async signTypedData(payload) {
        calls.signTypedData.push(payload);
        if (failSign) throw new Error("user rejected");
        const { EIP712Domain, ...types } = payload.types;
        void EIP712Domain;
        return payerWallet.signTypedData(payload.domain, types, payload.message);
      },
      async call({ to, data }) {
        calls.call.push({ to, data });
        const selector = data.slice(0, 10);
        if (selector === usdcInterface.getFunction("name").selector) {
          return usdcInterface.encodeFunctionResult("name", [tokenName]);
        }
        if (selector === usdcInterface.getFunction("version").selector) {
          return usdcInterface.encodeFunctionResult("version", [tokenVersion]);
        }
        if (selector === usdcInterface.getFunction("DOMAIN_SEPARATOR").selector) {
          return usdcInterface.encodeFunctionResult("DOMAIN_SEPARATOR", [
            tokenDomainSeparator({ chainId: currentChain, token: to, name: tokenName, version: tokenVersion }),
          ]);
        }
        if (selector === usdcInterface.getFunction("balanceOf").selector) {
          return usdcInterface.encodeFunctionResult("balanceOf", [balance]);
        }
        throw new Error(`unstubbed call ${selector}`);
      },
    },
  };
}

module.exports = {
  BASE_MAINNET,
  BASE_SEPOLIA,
  CANDIDATE_PROPOSER,
  CANDIDATE_SLUG,
  PAYER,
  RELAYER,
  SPLITTER,
  TOKEN,
  TOKEN_NAME,
  TOKEN_VERSION,
  VOTER,
  candidateRow,
  candidateTargetIdFixture,
  createFetchStub,
  createRelayerStub,
  createWalletStub,
  gateProfile,
  issuedQuote,
  payerWallet,
  proposalRow,
  submissionHashFor,
  tokenDomainSeparator,
};
