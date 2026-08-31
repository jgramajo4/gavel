const { AbiCoder, Interface, formatEther, getAddress, id } = require("ethers");

const { normalizedProposalSchema } = require("../../core/schema/governance");
const { proposalSecurityReportSchema } = require("../../core/schema/security");
const {
  detectUntrustedInstructions,
  parseEthClaims,
  parseRecipientClaims,
} = require("../../core/security/content");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const RISK_ORDER = Object.freeze({ CLEAR: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 });
const REVIEW_SEVERITIES = new Set(["WARNING", "DANGER", "CRITICAL"]);

const TARGET_LABELS = Object.freeze({
  "0xb1a32fc9f9d8b2cf86c068cae13108809547ef71": "Nouns treasury (timelock)",
  "0x9c8ff314c9bc7f6e59a9d9225fb22946427edc03": "Nouns token",
  "0xd97bcd9f47cee35c0a9ec1dc40c1269afc9e8e1d": "Nouns Payer (USDC)",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "WETH",
  [ZERO_ADDRESS]: "Zero address",
});

const KNOWN_SIGNATURES = Object.freeze([
  "delegate(address)",
  "delegateBySig(address,uint256,uint256,uint8,bytes32,bytes32)",
  "transfer(address,uint256)",
  "transferFrom(address,address,uint256)",
  "safeTransferFrom(address,address,uint256)",
  "safeTransferFrom(address,address,uint256,bytes)",
  "approve(address,uint256)",
  "setApprovalForAll(address,bool)",
  "pause()",
  "unpause()",
  "withdraw()",
  "deposit()",
  "mint(address,uint256)",
  "burn(uint256)",
  "sendOrRegisterDebt(address,uint256)",
  "createStream(address,uint256,address,uint256,uint256,uint8,address)",
  "setPendingAdmin(address)",
  "acceptAdmin()",
  "setReservePrice(uint192)",
  "transferOwnership(address)",
  "renounceOwnership()",
  "upgradeTo(address)",
  "upgradeToAndCall(address,bytes)",
  "changeAdmin(address)",
]);

const SELECTORS = new Map(KNOWN_SIGNATURES.map((signature) => [id(signature).slice(0, 10).toLowerCase(), signature]));
const PARAMETER_NAMES = Object.freeze({
  "transfer(address,uint256)": ["to", "amount"],
  "transferFrom(address,address,uint256)": ["from", "to", "amount"],
  "safeTransferFrom(address,address,uint256)": ["from", "to", "tokenId"],
  "safeTransferFrom(address,address,uint256,bytes)": ["from", "to", "tokenId", "data"],
  "approve(address,uint256)": ["spender", "amount"],
  "setApprovalForAll(address,bool)": ["operator", "approved"],
  "sendOrRegisterDebt(address,uint256)": ["recipient", "amount"],
  "delegate(address)": ["delegatee"],
  "transferOwnership(address)": ["newOwner"],
  "upgradeTo(address)": ["implementation"],
  "upgradeToAndCall(address,bytes)": ["implementation", "data"],
  "changeAdmin(address)": ["newAdmin"],
  "setPendingAdmin(address)": ["newPendingAdmin"],
});

function jsonValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return getAddress(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object" && typeof value.toArray === "function") return value.toArray().map(jsonValue);
  return value;
}

function flag(code, severity, actionIndex, message) {
  return { code, severity, actionIndex, message };
}

function highestRisk(...levels) {
  return levels.reduce((highest, level) => (RISK_ORDER[level] > RISK_ORDER[highest] ? level : highest), "CLEAR");
}

function decodeAction(action) {
  const hasData = action.calldata !== "0x";
  if (!action.signature && !hasData) {
    return {
      signature: null,
      selector: null,
      status: "NOT_APPLICABLE",
      args: [],
      kind: BigInt(action.valueWei) > 0n ? "NATIVE_TRANSFER" : "NO_OP",
    };
  }

  let signature = action.signature || null;
  let selector = hasData && action.calldata.length >= 10 ? action.calldata.slice(0, 10).toLowerCase() : null;
  let rawArguments = action.calldata;
  if (!signature) {
    signature = SELECTORS.get(selector) || null;
    if (!signature) return { signature: null, selector, status: "UNKNOWN_SELECTOR", args: [], kind: "UNKNOWN_CALL" };
    rawArguments = `0x${action.calldata.slice(10)}`;
  } else {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*\(.*\)$/.test(signature)) {
      return { signature, selector, status: "DECODE_FAILED", args: [], kind: "UNKNOWN_CALL" };
    }
    const expectedSelector = id(signature).slice(0, 10).toLowerCase();
    if (selector === expectedSelector) rawArguments = `0x${action.calldata.slice(10)}`;
    selector = expectedSelector;
  }

  try {
    const iface = new Interface([`function ${signature}`]);
    const fragment = iface.getFunction(signature);
    const values = AbiCoder.defaultAbiCoder().decode(fragment.inputs, rawArguments);
    const names = PARAMETER_NAMES[signature] || fragment.inputs.map((input, index) => input.name || `arg${index}`);
    const args = fragment.inputs.map((input, index) => ({
      name: names[index] || `arg${index}`,
      type: input.format("sighash"),
      value: jsonValue(values[index]),
    }));
    return { signature, selector, status: "DECODED", args, kind: "CONTRACT_CALL" };
  } catch {
    return { signature, selector, status: "DECODE_FAILED", args: [], kind: "UNKNOWN_CALL" };
  }
}

function assessAction(action, decoded) {
  const flags = [];
  const target = action.target.toLowerCase();
  const value = BigInt(action.valueWei);
  if (target === ZERO_ADDRESS && (value > 0n || decoded.kind !== "NO_OP")) {
    flags.push(flag("ZERO_ADDRESS_EXECUTION", "CRITICAL", action.index, "Executable value or calldata targets the zero address."));
  }
  if (["UNKNOWN_SELECTOR", "DECODE_FAILED"].includes(decoded.status)) {
    flags.push(flag("UNVERIFIED_CALL", "WARNING", action.index, "The action could not be decoded; its effects require independent human verification."));
  }

  const name = decoded.signature?.split("(", 1)[0].toLowerCase();
  if (name && /^(selfdestruct|destroy|kill)$/.test(name)) {
    flags.push(flag("DESTRUCTIVE_CONTRACT_CALL", "CRITICAL", action.index, "The call may destroy or irreversibly disable contract code."));
  }
  if (name && /^(upgradeto|upgradetoandcall|changeadmin|setpendingadmin|acceptadmin|transferownership|renounceownership)$/.test(name)) {
    flags.push(flag("PRIVILEGED_CONTROL_CHANGE", "DANGER", action.index, "The call changes contract implementation, administration, or ownership."));
  }
  if (name === "delegate" || name === "delegatebysig") {
    flags.push(flag("GOVERNANCE_DELEGATION_CHANGE", "DANGER", action.index, "The call changes governance delegation authority."));
  }
  if (name === "setapprovalforall") {
    const approved = decoded.args.find((argument) => argument.name === "approved")?.value;
    if (approved === true) flags.push(flag("UNBOUNDED_OPERATOR_APPROVAL", "DANGER", action.index, "The call grants an operator authority over all tokens."));
  }
  if (name === "approve") {
    const amount = decoded.args.find((argument) => argument.name === "amount")?.value;
    if (amount && BigInt(amount) >= 2n ** 255n) {
      flags.push(flag("UNLIMITED_TOKEN_APPROVAL", "DANGER", action.index, "The call grants an effectively unlimited token allowance."));
    }
  }
  if (name && /^(execute|executebatch|call|multicall|delegatecall)$/.test(name)) {
    flags.push(flag("ARBITRARY_EXECUTION_SURFACE", "DANGER", action.index, "The call can wrap or dispatch additional execution that is not fully inspected here."));
  }

  let riskLevel = "CLEAR";
  for (const item of flags) {
    if (item.severity === "CRITICAL") riskLevel = highestRisk(riskLevel, "CRITICAL");
    else if (item.severity === "DANGER") riskLevel = highestRisk(riskLevel, "HIGH");
    else if (item.severity === "WARNING") riskLevel = highestRisk(riskLevel, "MEDIUM");
  }
  if (riskLevel === "CLEAR" && (decoded.kind === "NATIVE_TRANSFER" || value > 0n)) riskLevel = "LOW";
  return { flags, riskLevel };
}

function decodedRecipients(actions) {
  const recipients = [];
  for (const action of actions) {
    if (action.kind === "NATIVE_TRANSFER" && BigInt(action.valueWei) > 0n) recipients.push(action.target.toLowerCase());
    for (const argument of action.decodedArguments) {
      if (["to", "recipient"].includes(argument.name) && typeof argument.value === "string" && /^0x[0-9a-fA-F]{40}$/.test(argument.value)) {
        recipients.push(argument.value.toLowerCase());
      }
    }
  }
  return [...new Set(recipients)];
}

function detectMismatches(proposal, actions) {
  if (actions.some((action) => ["UNKNOWN_SELECTOR", "DECODE_FAILED"].includes(action.decodeStatus))) return [];
  const mismatches = [];
  const valueActions = actions.filter((action) => BigInt(action.valueWei) > 0n);
  const nativeValueWei = valueActions.reduce((sum, action) => sum + BigInt(action.valueWei), 0n);
  const directNativePaymentsOnly = valueActions.every((action) => action.kind === "NATIVE_TRANSFER");
  const ethClaims = parseEthClaims(proposal.description);
  const comparableEthClaims = ethClaims.filter((claim) => claim.scope === "TOTAL");
  const uniqueEthClaims = [...new Map(comparableEthClaims.map((claim) => [claim.amount, claim])).values()];
  if (uniqueEthClaims.length === 1 && nativeValueWei > 0n && directNativePaymentsOnly) {
    const actual = Number(formatEther(nativeValueWei));
    const expected = uniqueEthClaims[0].amount;
    if (Math.abs(actual - expected) > Math.max(0.000001, expected * 0.000001)) {
      mismatches.push({
        code: "NATIVE_VALUE_MISMATCH",
        severity: "DANGER",
        message: "The explicit ETH amount in proposal prose differs from the executable native value.",
        proseClaim: uniqueEthClaims[0].text,
        executableFact: `${formatEther(nativeValueWei)} ETH`,
      });
    }
  }

  const claimedRecipients = parseRecipientClaims(proposal.description);
  const actualRecipients = decodedRecipients(actions);
  if (claimedRecipients.length === 1 && actualRecipients.length > 0 && !actualRecipients.includes(claimedRecipients[0])) {
    mismatches.push({
      code: "RECIPIENT_MISMATCH",
      severity: "DANGER",
      message: "The explicitly named payment recipient is absent from decoded executable recipients.",
      proseClaim: claimedRecipients[0],
      executableFact: actualRecipients.join(", "),
    });
  }
  return mismatches;
}

function inspectNounsProposal(proposalInput) {
  const proposal = normalizedProposalSchema.parse(proposalInput);
  const instructionPatterns = detectUntrustedInstructions(proposal.title, proposal.description);
  const globalFlags = instructionPatterns.length > 0
    ? [flag("PROMPT_INJECTION_SUSPECTED", "DANGER", null, "Proposal content contains instructions apparently addressed to an automated system; they were treated only as untrusted data.")]
    : [];

  const seenIndexes = new Set();
  const actions = proposal.actions.map((action) => {
    if (seenIndexes.has(action.index)) {
      globalFlags.push(flag("DUPLICATE_ACTION_INDEX", "CRITICAL", action.index, "Multiple actions share the same index."));
    }
    seenIndexes.add(action.index);
    const decoded = decodeAction(action);
    const assessment = assessAction(action, decoded);
    return {
      index: action.index,
      target: action.target,
      targetLabel: TARGET_LABELS[action.target.toLowerCase()] || null,
      valueWei: action.valueWei,
      kind: decoded.kind,
      decodeStatus: decoded.status,
      selector: decoded.selector,
      functionSignature: decoded.signature,
      decodedArguments: decoded.args,
      riskLevel: assessment.riskLevel,
      flags: assessment.flags,
    };
  });
  const mismatches = detectMismatches(proposal, actions);
  for (const mismatch of mismatches) {
    globalFlags.push(flag("PROSE_ACTION_MISMATCH", mismatch.severity, null, mismatch.message));
  }
  const flags = [...globalFlags, ...actions.flatMap((action) => action.flags)];
  const actionRisk = actions.reduce((risk, action) => highestRisk(risk, action.riskLevel), "CLEAR");
  const globalRisk = flags.reduce((risk, item) => {
    if (item.severity === "CRITICAL") return highestRisk(risk, "CRITICAL");
    if (item.severity === "DANGER") return highestRisk(risk, "HIGH");
    if (item.severity === "WARNING") return highestRisk(risk, "MEDIUM");
    return risk;
  }, "CLEAR");
  const riskLevel = highestRisk(actionRisk, globalRisk);
  return proposalSecurityReportSchema.parse({
    schemaVersion: "1.0.0",
    proposalId: proposal.id,
    proposalContentHash: proposal.contentHash,
    contentPolicy: {
      classification: "UNTRUSTED_GOVERNANCE_CONTENT",
      instructionHandling: "NEVER_FOLLOW",
      detectedInstructionPatterns: instructionPatterns,
    },
    sourceVerification: "STRUCTURED_INPUT_NOT_CHAIN_VERIFIED",
    actions,
    mismatches,
    flags,
    summary: {
      riskLevel,
      requiresHumanReview: flags.some((item) => REVIEW_SEVERITIES.has(item.severity)),
      actionCount: actions.length,
      decodedActionCount: actions.filter((action) => action.decodeStatus === "DECODED").length,
      unknownActionCount: actions.filter((action) => ["UNKNOWN_SELECTOR", "DECODE_FAILED"].includes(action.decodeStatus)).length,
      mismatchCount: mismatches.length,
    },
  });
}

module.exports = { inspectNounsProposal };
