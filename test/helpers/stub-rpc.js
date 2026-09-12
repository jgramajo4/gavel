"use strict";

/**
 * A minimal JSON-RPC server answering the calls a Nouns vote preparation makes.
 *
 * The CLI builds its own provider from `--rpc`, so a test cannot inject a mock
 * adapter. Standing up a real endpoint is what lets a CLI test prove that
 * `gavel execution prepare` actually reads chain state -- which is the property
 * whose absence let a doctored preparation JSON be stamped as validated.
 */

const http = require("node:http");
const { Interface, id } = require("ethers");

const GOVERNANCE_ADDRESS = "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d";
const NOUNS_TOKEN_ADDRESS = "0x9C8fF314C9Bc7F6e59A9d9225Fb22946427eDC03";

const proposalEvents = new Interface([
  "event ProposalCreated(uint256 id,address proposer,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,uint256 startBlock,uint256 endBlock,string description)",
]);

const governance = new Interface([
  "function state(uint256 proposalId) view returns (uint8)",
  "function proposals(uint256 proposalId) view returns (uint256 id,address proposer,uint256 proposalThreshold,uint256 quorumVotes,uint256 eta,uint256 startBlock,uint256 endBlock,uint256 forVotes,uint256 againstVotes,uint256 abstainVotes,bool canceled,bool vetoed,bool executed,uint256 totalSupply,uint256 creationBlock)",
  "function getActions(uint256 proposalId) view returns (address[] targets,uint256[] values,string[] signatures,bytes[] calldatas)",
  "function getReceipt(uint256 proposalId,address voter) view returns (bool hasVoted,uint8 support,uint96 votes)",
  "function castRefundableVoteWithReason(uint256 proposalId,uint8 support,string reason,uint32 clientId)",
]);
const token = new Interface([
  "function getPriorVotes(address account,uint256 blockNumber) view returns (uint96)",
  "function getCurrentVotes(address account) view returns (uint96)",
  "function delegates(address delegator) view returns (address)",
]);

/**
 * @param {object} options
 * @param {string} options.voter        the address the vote is cast from
 * @param {string} options.actionTarget the proposal's single action target
 * @param {number} [options.state]      canonical proposal state code (1 = ACTIVE)
 */
function stubProvider(options) {
  const proposalState = options.state ?? 1;
  const delegatee = options.delegatee || options.voter;

  function answer(method, params) {
    switch (method) {
      case "eth_chainId":
        return `0x${(options.chainId ?? 1).toString(16)}`;
      case "eth_blockNumber":
        return "0x96"; // 150
      case "eth_getCode":
        return "0x6000";
      case "eth_estimateGas":
        return "0x1e240";
      case "eth_getLogs": {
        // The freshness verifier reads canonical ProposalCreated events and
        // then any update events. `withCreationLog: false` returns nothing,
        // which makes the adapter block rather than guess -- a legitimate
        // outcome a CLI test asserts on.
        if (options.withCreationLog === false) return [];
        const filter = params[0] || {};
        const wantsCreation =
          Array.isArray(filter.topics) &&
          typeof filter.topics[0] === "string" &&
          filter.topics[0] === proposalEvents.getEvent("ProposalCreated").topicHash;
        if (!wantsCreation) return []; // no update events
        const encoded = proposalEvents.encodeEventLog("ProposalCreated", [
          42n,
          options.proposer,
          [options.actionTarget],
          [0n],
          ["ping()"],
          ["0x"],
          100n,
          200n,
          options.description ?? "Untrusted proposal prose",
        ]);
        return [
          {
            address: GOVERNANCE_ADDRESS,
            topics: encoded.topics,
            data: encoded.data,
            blockNumber: "0x5a", // 90, the proposal's creation block
            blockHash: `0x${"11".repeat(32)}`,
            transactionHash: `0x${"22".repeat(32)}`,
            transactionIndex: "0x0",
            logIndex: "0x0",
            removed: false,
          },
        ];
      }
      case "eth_call": {
        const { to, data } = params[0];
        const target = String(to).toLowerCase();
        if (target === GOVERNANCE_ADDRESS.toLowerCase()) {
          const selector = data.slice(0, 10);
          if (selector === governance.getFunction("state").selector) {
            return governance.encodeFunctionResult("state", [proposalState]);
          }
          if (selector === governance.getFunction("proposals").selector) {
            return governance.encodeFunctionResult("proposals", [
              42n, options.proposer, 0n, 10n, 0n, 100n, 200n, 2n, 1n, 0n, false, false, false, 100n, 90n,
            ]);
          }
          if (selector === governance.getFunction("getActions").selector) {
            return governance.encodeFunctionResult("getActions", [
              [options.actionTarget], [0n], ["ping()"], ["0x"],
            ]);
          }
          if (selector === governance.getFunction("getReceipt").selector) {
            return governance.encodeFunctionResult("getReceipt", [false, 0, 0n]);
          }
          // The vote simulation itself.
          if (selector === governance.getFunction("castRefundableVoteWithReason").selector) return "0x";
        }
        if (target === NOUNS_TOKEN_ADDRESS.toLowerCase()) {
          const selector = data.slice(0, 10);
          if (selector === token.getFunction("getPriorVotes").selector) {
            return token.encodeFunctionResult("getPriorVotes", [3n]);
          }
          if (selector === token.getFunction("getCurrentVotes").selector) {
            return token.encodeFunctionResult("getCurrentVotes", [3n]);
          }
          if (selector === token.getFunction("delegates").selector) {
            return token.encodeFunctionResult("delegates", [delegatee]);
          }
        }
        return "0x";
      }
      default:
        return null;
    }
  }

  const calls = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = JSON.parse(body || "{}");
      const batch = Array.isArray(payload) ? payload : [payload];
      const results = batch.map((entry) => {
        calls.push(entry.method);
        return { jsonrpc: "2.0", id: entry.id, result: answer(entry.method, entry.params || []) };
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(Array.isArray(payload) ? results : results[0]));
    });
  });

  return {
    calls,
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { GOVERNANCE_ADDRESS, NOUNS_TOKEN_ADDRESS, stubProvider, PROPOSAL_CREATED_TOPIC: id("ProposalCreated(uint256,address,address[],uint256[],string[],bytes[],uint256,uint256,string)") };
