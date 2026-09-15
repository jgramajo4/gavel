const assert = require("node:assert/strict");
const test = require("node:test");
const { Interface, id } = require("ethers");
const {
  QUOTE_SETTLED_EVENT_ABI,
  QUOTE_SETTLED_EVENT_SIGNATURE,
  QUOTE_SETTLED_TOPIC,
  decodeQuoteSettledLog,
  safeHead,
  scannerWindow,
  settlementIdentity,
} = require("../src/settlement");

const A = (digit) => `0x${digit.repeat(40)}`;
const H = (digit) => `0x${digit.repeat(64)}`;
const SPLITTER = A("1");
const values = [H("2"), A("3"), A("4"), 1_000_000n, A("5"), 250_000n, A("6"), H("7")];
const iface = new Interface([QUOTE_SETTLED_EVENT_ABI]);
function log(overrides = {}) {
  const encoded = iface.encodeEventLog(iface.getEvent("QuoteSettled"), values);
  return { address: SPLITTER, topics: encoded.topics, data: encoded.data, transactionHash: H("8"), index: 3,
    blockNumber: 20, blockHash: H("9"), ...overrides };
}

test("1. settlement freezes the exact QuoteSettled declaration, signature, and three indexed fields", () => {
  assert.equal(QUOTE_SETTLED_EVENT_SIGNATURE,
    "QuoteSettled(bytes32,address,address,uint256,address,uint256,address,bytes32)");
  assert.equal(QUOTE_SETTLED_TOPIC, id(QUOTE_SETTLED_EVENT_SIGNATURE));
  assert.equal(QUOTE_SETTLED_EVENT_ABI,
    "event QuoteSettled(bytes32 indexed quoteId,address indexed payer,address indexed voter,uint256 attentionAmount,address gavelRecipient,uint256 gavelFeeAmount,address token,bytes32 submissionHash)");
  assert.equal(log().topics.length, 4);
});

test("2. exact logs decode to only the frozen eight event fields", () => {
  const decoded = decodeQuoteSettledLog(log(), { splitter: SPLITTER });
  assert.deepEqual(decoded, {
    quoteId: H("2"), payer: A("3"), voter: A("4"), attentionAmount: "1000000",
    gavelRecipient: A("5"), gavelFeeAmount: "250000", token: A("6"), submissionHash: H("7"),
  });
});

test("3. malformed, unrelated, wrong-splitter, extra-topic, and trailing-data logs fail closed", () => {
  for (const candidate of [
    log({ address: A("a") }),
    log({ topics: [H("f"), ...log().topics.slice(1)] }),
    log({ topics: [...log().topics, H("f")] }),
    log({ data: `${log().data}00` }),
    log({ data: "0x1234" }),
  ]) assert.throws(() => decodeQuoteSettledLog(candidate, { splitter: SPLITTER }), /QuoteSettled|splitter|canonical/i);
});

test("4. confirmation depth defaults to one and scanner overlap defaults to 64", () => {
  assert.equal(safeHead(100n), 100n);
  assert.equal(safeHead(100n, 2), 99n);
  assert.deepEqual(scannerWindow({ deploymentBlock: 5n, nextRangeFrom: 100n, safeThrough: 110n }),
    { fromBlock: 36n, throughBlock: 110n });
  assert.deepEqual(scannerWindow({ deploymentBlock: 5n, nextRangeFrom: 5n, safeThrough: 8n }),
    { fromBlock: 5n, throughBlock: 8n });
});

test("5. settlement side-effect identities are stable across independent pollers", () => {
  const first = settlementIdentity({ chainId: "8453", splitter: SPLITTER, quoteId: H("2") });
  const second = settlementIdentity({ chainId: 8453n, splitter: SPLITTER.toUpperCase().replace("0X", "0x"), quoteId: H("2") });
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first).sort(), ["inboxId", "monitorId", "notificationId"]);
});
