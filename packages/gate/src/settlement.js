const crypto = require("node:crypto");
const { Interface, id } = require("ethers");

const QUOTE_SETTLED_EVENT_ABI = "event QuoteSettled(bytes32 indexed quoteId,address indexed payer,address indexed voter,uint256 attentionAmount,address gavelRecipient,uint256 gavelFeeAmount,address token,bytes32 submissionHash)";
const QUOTE_SETTLED_EVENT_SIGNATURE = "QuoteSettled(bytes32,address,address,uint256,address,uint256,address,bytes32)";
const QUOTE_SETTLED_TOPIC = id(QUOTE_SETTLED_EVENT_SIGNATURE);
const DEFAULT_CONFIRMATION_DEPTH = 1;
const DEFAULT_SCANNER_OVERLAP = 64;
const iface = new Interface([QUOTE_SETTLED_EVENT_ABI]);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function canonicalAddress(value, name = "address") {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new TypeError(`${name} must be an address`);
  return value.toLowerCase();
}

function canonicalBytes32(value, name = "bytes32") {
  if (typeof value !== "string" || !BYTES32.test(value)) throw new TypeError(`${name} must be bytes32`);
  return value.toLowerCase();
}

function positiveInteger(value, name, fallback) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 1) throw new TypeError(`${name} must be a positive integer`);
  return candidate;
}

function decodeQuoteSettledLog(log, { splitter } = {}) {
  const expectedSplitter = canonicalAddress(splitter, "splitter");
  if (!log || canonicalAddress(log.address, "log address") !== expectedSplitter) {
    throw new Error("QuoteSettled log is not from the configured splitter");
  }
  if (!Array.isArray(log.topics) || log.topics.length !== 4
      || canonicalBytes32(log.topics[0], "event topic") !== QUOTE_SETTLED_TOPIC.toLowerCase()
      || typeof log.data !== "string" || !/^0x[0-9a-fA-F]{320}$/.test(log.data)) {
    throw new Error("QuoteSettled log is not in canonical exact form");
  }
  let parsed;
  try { parsed = iface.parseLog({ topics: log.topics, data: log.data }); } catch {
    throw new Error("QuoteSettled log is malformed");
  }
  if (!parsed || parsed.name !== "QuoteSettled") throw new Error("unrelated settlement log");
  return Object.freeze({
    quoteId: canonicalBytes32(parsed.args.quoteId, "quoteId"),
    payer: canonicalAddress(parsed.args.payer, "payer"),
    voter: canonicalAddress(parsed.args.voter, "voter"),
    attentionAmount: parsed.args.attentionAmount.toString(),
    gavelRecipient: canonicalAddress(parsed.args.gavelRecipient, "gavelRecipient"),
    gavelFeeAmount: parsed.args.gavelFeeAmount.toString(),
    token: canonicalAddress(parsed.args.token, "token"),
    submissionHash: canonicalBytes32(parsed.args.submissionHash, "submissionHash"),
  });
}

function safeHead(latestBlock, confirmationDepth = DEFAULT_CONFIRMATION_DEPTH) {
  const latest = BigInt(latestBlock);
  const depth = BigInt(positiveInteger(confirmationDepth, "confirmationDepth", DEFAULT_CONFIRMATION_DEPTH));
  return latest + 1n < depth ? -1n : latest - depth + 1n;
}

function scannerWindow({ deploymentBlock, nextRangeFrom, safeThrough, overlap = DEFAULT_SCANNER_OVERLAP } = {}) {
  const deployment = BigInt(deploymentBlock);
  const next = BigInt(nextRangeFrom);
  const through = BigInt(safeThrough);
  const trailing = BigInt(positiveInteger(overlap, "overlap", DEFAULT_SCANNER_OVERLAP));
  if (deployment < 0n || next < deployment) throw new TypeError("invalid scanner cursor");
  if (through < deployment) return null;
  return Object.freeze({ fromBlock: next - trailing > deployment ? next - trailing : deployment, throughBlock: through });
}

function settlementIdentity({ chainId, splitter, quoteId } = {}) {
  const key = `${BigInt(chainId)}:${canonicalAddress(splitter, "splitter")}:${canonicalBytes32(quoteId, "quoteId")}`;
  const digest = crypto.createHash("sha256").update(key).digest("hex");
  return Object.freeze({ inboxId: `inbox-${digest}`, notificationId: `notice-${digest}`, monitorId: `monitor-${digest}` });
}

module.exports = {
  DEFAULT_CONFIRMATION_DEPTH,
  DEFAULT_SCANNER_OVERLAP,
  QUOTE_SETTLED_EVENT_ABI,
  QUOTE_SETTLED_EVENT_SIGNATURE,
  QUOTE_SETTLED_TOPIC,
  decodeQuoteSettledLog,
  safeHead,
  scannerWindow,
  settlementIdentity,
};
