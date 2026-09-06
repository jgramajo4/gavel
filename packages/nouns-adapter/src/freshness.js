const { Interface, id, toBeHex, zeroPadValue } = require("ethers");
const { blockRanges, resolveLogBlockBatchSize } = require("../../core/src/rpc/block-range");

const PROPOSAL_EVENT_ABI = [
  "event ProposalCreated(uint256 id,address proposer,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,uint256 startBlock,uint256 endBlock,string description)",
  "event ProposalUpdated(uint256 indexed id,address indexed proposer,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,string description,string updateMessage)",
  "event ProposalTransactionsUpdated(uint256 indexed id,address indexed proposer,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,string updateMessage)",
  "event ProposalDescriptionUpdated(uint256 indexed id,address indexed proposer,string description,string updateMessage)",
];
const proposalEvents = new Interface(PROPOSAL_EVENT_ABI);
const UPDATE_EVENTS = ["ProposalUpdated", "ProposalTransactionsUpdated", "ProposalDescriptionUpdated"];

function logOrder(left, right) {
  return Number(left.blockNumber) - Number(right.blockNumber) || Number(left.index ?? left.logIndex ?? 0) - Number(right.index ?? right.logIndex ?? 0);
}

function actionArrays(args) {
  return {
    // Positional access avoids collisions with Array/Result methods such as `values`.
    targets: Array.from(args[2] || []),
    values: Array.from(args[3] || []).map(String),
    signatures: Array.from(args[4] || []).map(String),
    calldatas: Array.from(args[5] || []).map((value) => String(value).toLowerCase()),
  };
}

async function canonicalProposalVersion(provider, governanceAddress, proposalId, createdBlock, checkedAtBlock, options = {}) {
  const creationLogs = await provider.getLogs({
    address: governanceAddress,
    fromBlock: Number(createdBlock),
    toBlock: Number(createdBlock),
    topics: [proposalEvents.getEvent("ProposalCreated").topicHash],
  });
  const created = creationLogs.map((log) => ({ log, parsed: proposalEvents.parseLog(log) }))
    .find(({ parsed }) => String(parsed.args.id) === String(proposalId));
  if (!created) throw new Error(`Canonical ProposalCreated event not found for proposal ${proposalId}`);

  const proposalTopic = zeroPadValue(toBeHex(proposalId), 32);
  // The update window spans the whole life of the proposal, which for a Nouns
  // voting period already outgrows the ~10,000-block `eth_getLogs` ceiling common
  // to hosted RPC plans. It is walked in the same bounded spans as the indexer so
  // vote preparation stays portable across providers; the events are re-sorted
  // below, so splitting the window cannot change the result.
  const batchSize = resolveLogBlockBatchSize({ explicit: options.blockBatchSize, names: ["INDEXER_BLOCK_BATCH_SIZE"], env: options.env });
  const updateLogs = [];
  for (const range of blockRanges(Number(createdBlock), Number(checkedAtBlock), batchSize)) {
    updateLogs.push(...await provider.getLogs({
      address: governanceAddress,
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
      topics: [UPDATE_EVENTS.map((name) => proposalEvents.getEvent(name).topicHash), proposalTopic],
    }));
  }
  const events = [created, ...updateLogs.map((log) => ({ log, parsed: proposalEvents.parseLog(log) }))]
    .sort((left, right) => logOrder(left.log, right.log));
  let description = String(created.parsed.args.description);
  let actions = actionArrays(created.parsed.args);
  let version = 1;
  for (const entry of events.slice(1)) {
    if (entry.parsed.name === "ProposalUpdated") {
      description = String(entry.parsed.args.description);
      actions = actionArrays(entry.parsed.args);
    } else if (entry.parsed.name === "ProposalTransactionsUpdated") {
      actions = actionArrays(entry.parsed.args);
    } else if (entry.parsed.name === "ProposalDescriptionUpdated") {
      description = String(entry.parsed.args.description);
    }
    version += 1;
  }
  const latest = events[events.length - 1];
  return {
    version,
    description,
    actions,
    latestEvent: latest.parsed.name,
    latestBlock: String(latest.log.blockNumber),
    latestLogIndex: Number(latest.log.index ?? latest.log.logIndex ?? 0),
    eventCount: events.length,
    eventDigest: id(events.map((entry) => `${entry.log.transactionHash || ""}:${entry.log.index ?? entry.log.logIndex ?? 0}`).join("|")),
  };
}

module.exports = { PROPOSAL_EVENT_ABI, canonicalProposalVersion, proposalEvents };
