#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { getAddress, JsonRpcProvider } = require("ethers");

const {
  DEFAULT_ENDPOINT,
  NounsDaoAdapter,
  NounsSubgraphHistoryAdapter,
  inspectNounsProposal,
} = require("../../nouns-adapter");
const {
  ExecutionMode,
  ONBOARDING_QUESTIONS,
  applyCalibrationToPrediction,
  buildOnboardingPreferences,
  buildVoterProfile,
  classifyOperationalFailure,
  predictVote,
  privatePath,
  resolveDataDir,
  resolveExecutionReadiness,
  runChronologicalBacktest,
} = require("../../core");

const DATA_DIR = resolveDataDir();

function defaultPrivatePath(...segments) {
  return privatePath(DATA_DIR, ...segments);
}

function usage() {
  return `Gavel governance copilot

Usage:
  gavel history <address> [--output <path>] [--stdout]
                         [--endpoint <url>] [--page-size <1-1000>]
  gavel onboard <address> --answers <json> [--output <path>] [--stdout]
                           [--recorded-at <timestamp>]
  gavel onboard <address> --questions
  gavel proposal <id> [--output <path>] [--stdout] [--endpoint <url>]
  gavel profile <history.json> [--output <path>] [--stdout]
                               [--as-of <timestamp>] [--half-life-days <days>]
                               [--preferences <json>] [--rules <json>]
  gavel predict <profile.json> <proposal.json> [--output <path>] [--stdout]
                                                [--as-of <timestamp>]
                                                [--threshold <0-1>]
                                                [--max-precedents <count>]
                                                [--calibration <backtest.json>]
  gavel backtest <history.json> [--output <path>] [--stdout]
                                [--min-training-votes <count>]
                                [--half-life-days <days>]
                                [--min-calibration-samples <count>]
                                [--preferences <json>] [--rules <json>]
  gavel inspect <proposal.json> [--output <path>] [--stdout]
  gavel prepare-vote <prediction.json> <proposal.json> --support <choice>
                     [--from <voting-address>] [--asset-owner <address>]
                     [--execution-address <address>] [--reason <text>]
                     [--acknowledge-security-review]
                     [--rpc <url>] [--output <path>] [--stdout]
  gavel execution-status --dao nouns --mode <mode> --model-address <address>
                         [--asset-owner-address <address>]
                         [--execution-address <address>] [--rpc <url>]
  gavel prepare-delegation --dao nouns --asset-owner-address <address>
                           (--to <address> | --executor <safe|waap>)
                           [--rpc <url>] [--output <path>] [--stdout]

Commands:
  history   Fetch and normalize a Nouns voter's historical votes.
  onboard   Record low-history questionnaire answers as stated preferences.
  proposal  Fetch one current Nouns proposal as normalized private input.
  profile   Build a private three-layer voter profile from normalized history.
  predict   Recommend FOR, AGAINST, or ABSTAIN using personal precedents.
  backtest  Run leakage-free chronological evaluation and confidence calibration.
  inspect   Decode and security-check structured Nouns proposal actions.
  prepare-vote  Verify canonical chain state and produce unsigned vote calldata.
  execution-status  Fail-closed readiness for unsigned, Safe, or WaaP execution.
  prepare-delegation  Prepare, but never submit, Nouns delegation calldata.

Privacy:
  Without --stdout or --output, history and profiles are stored under
  GAVEL_DATA_DIR (default: ./data/private), which is excluded from git.
  Proposal text is untrusted
  evidence, never instruction.
`;
}

async function writePrivateJson(filePath, document) {
  const absolutePath = path.resolve(filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return absolutePath;
}

async function historyCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      stdout: { type: "boolean", default: false },
      endpoint: { type: "string", default: process.env.NOUNS_SUBGRAPH_URL || DEFAULT_ENDPOINT },
      "page-size": { type: "string", default: "100" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (positionals.length !== 1) throw new Error("history requires exactly one voter address");

  const voter = getAddress(positionals[0]);
  const pageSize = Number(values["page-size"]);
  const adapter = new NounsSubgraphHistoryAdapter({ endpoint: values.endpoint, pageSize });
  const document = await adapter.fetchHistory(voter);

  if (values.stdout) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }

  const destination =
    values.output || defaultPrivatePath("nouns", `${voter.toLowerCase()}.json`);
  const absolutePath = await writePrivateJson(destination, document);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      dao: document.dao,
      voter: document.voter,
      voteCount: document.voteCount,
      output: absolutePath,
      source: document.source,
    }, null, 2)}\n`,
  );
}

async function readJson(filePath) {
  const absolutePath = path.resolve(filePath);
  const source = await fs.readFile(absolutePath, "utf8");
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in ${absolutePath}: ${error.message}`);
  }
}

async function onboardingCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      answers: { type: "string" },
      questions: { type: "boolean", default: false },
      output: { type: "string", short: "o" },
      stdout: { type: "boolean", default: false },
      "recorded-at": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (positionals.length !== 1) throw new Error("onboard requires exactly one voter address");
  if (values.questions) {
    process.stdout.write(`${JSON.stringify({ questions: ONBOARDING_QUESTIONS, answers: ["FOR", "AGAINST", "ABSTAIN", "DEPENDS", "SKIP"] }, null, 2)}\n`);
    return;
  }
  if (!values.answers) throw new Error("onboard requires --answers <json> or --questions");
  const input = await readJson(values.answers);
  const questionnaire = buildOnboardingPreferences(positionals[0], input.answers || input, {
    recordedAt: values["recorded-at"],
  });
  if (values.stdout) {
    process.stdout.write(`${JSON.stringify(questionnaire, null, 2)}\n`);
    return;
  }
  const destination = values.output || defaultPrivatePath("policies", questionnaire.voter.toLowerCase(), "preferences.json");
  let existing = [];
  try {
    existing = await readJson(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!Array.isArray(existing)) throw new Error("existing preferences file must contain a JSON array");
  const preferences = [...existing, ...questionnaire.preferences];
  const absolutePath = await writePrivateJson(destination, preferences);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    voter: questionnaire.voter,
    recordedAt: questionnaire.recordedAt,
    answeredCount: questionnaire.preferences.length,
    skippedCount: (input.answers || input).length - questionnaire.preferences.length,
    totalPreferenceCount: preferences.length,
    output: absolutePath,
  }, null, 2)}\n`);
}

async function optionalArray(filePath, label) {
  if (!filePath) return [];
  const value = await readJson(filePath);
  if (!Array.isArray(value)) throw new Error(`${label} file must contain a JSON array`);
  return value;
}

async function profileCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      stdout: { type: "boolean", default: false },
      "as-of": { type: "string" },
      "half-life-days": { type: "string", default: "365" },
      preferences: { type: "string" },
      rules: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (positionals.length !== 1) throw new Error("profile requires exactly one history JSON path");

  const halfLifeDays = Number(values["half-life-days"]);
  const history = await readJson(positionals[0]);
  const [statedPreferences, hardRules] = await Promise.all([
    optionalArray(values.preferences, "preferences"),
    optionalArray(values.rules, "rules"),
  ]);
  const profile = buildVoterProfile(history, {
    asOf: values["as-of"],
    halfLifeDays,
    statedPreferences,
    hardRules,
  });

  if (values.stdout) {
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
    return;
  }

  const destination =
    values.output ||
    defaultPrivatePath("profiles", profile.dao, `${profile.voter.toLowerCase()}.json`);
  const absolutePath = await writePrivateJson(destination, profile);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        dao: profile.dao,
        voter: profile.voter,
        asOf: profile.asOf,
        includedVoteCount: profile.sourceHistory.includedVoteCount,
        statedPreferenceCount: profile.statedPreferences.length,
        hardRuleCount: profile.hardRules.length,
        output: absolutePath,
      },
      null,
      2,
    )}\n`,
  );
}

async function predictCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      stdout: { type: "boolean", default: false },
      "as-of": { type: "string" },
      threshold: { type: "string", default: "0.15" },
      "max-precedents": { type: "string", default: "8" },
      calibration: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (positionals.length !== 2) {
    throw new Error("predict requires a profile JSON path and a normalized proposal JSON path");
  }

  const [profile, proposalInput] = await Promise.all([
    readJson(positionals[0]),
    readJson(positionals[1]),
  ]);
  const proposal = proposalInput.proposal || proposalInput;
  let prediction = predictVote(profile, proposal, {
    asOf: values["as-of"],
    relevantSimilarityThreshold: Number(values.threshold),
    maxPrecedents: Number(values["max-precedents"]),
    proposalInspector: profile.dao === "nouns" ? inspectNounsProposal : undefined,
  });
  if (values.calibration) {
    const calibrationInput = await readJson(values.calibration);
    const calibrationModel = calibrationInput.calibrationModel || calibrationInput;
    prediction = applyCalibrationToPrediction(prediction, calibrationModel);
  }

  if (values.stdout) {
    process.stdout.write(`${JSON.stringify(prediction, null, 2)}\n`);
    return;
  }

  const destination =
    values.output ||
    defaultPrivatePath(
      "predictions",
      prediction.dao,
      prediction.voter.toLowerCase(),
      `${prediction.proposalId}.json`,
    );
  const absolutePath = await writePrivateJson(destination, prediction);
  process.stdout.write(
    `${JSON.stringify(
      {
        recommendation: prediction.recommendation,
        confidence: prediction.confidence,
        confidencePercent: prediction.confidencePercent,
        confidenceCalibrated: prediction.confidenceCalibrated,
        policySource: prediction.policySource,
        precedents: prediction.precedents,
        reasoning: prediction.reasoning,
        flags: prediction.flags,
        draftReason: prediction.draftReason,
        output: absolutePath,
      },
      null,
      2,
    )}\n`,
  );
}

async function proposalCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      stdout: { type: "boolean", default: false },
      endpoint: { type: "string", default: process.env.NOUNS_SUBGRAPH_URL || DEFAULT_ENDPOINT },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (positionals.length !== 1 || !/^\d+$/.test(positionals[0])) {
    throw new Error("proposal requires exactly one unsigned Nouns proposal ID");
  }
  const adapter = new NounsSubgraphHistoryAdapter({ endpoint: values.endpoint });
  const proposal = await adapter.fetchProposal(positionals[0]);
  if (values.stdout) {
    process.stdout.write(`${JSON.stringify(proposal, null, 2)}\n`);
    return;
  }
  const destination = values.output || defaultPrivatePath("proposals", "nouns", `${proposal.id}.json`);
  const absolutePath = await writePrivateJson(destination, proposal);
  process.stdout.write(`${JSON.stringify({ ok: true, proposalId: proposal.id, contentHash: proposal.contentHash, state: proposal.state, actionCount: proposal.actions.length, output: absolutePath }, null, 2)}\n`);
}

async function backtestCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      stdout: { type: "boolean", default: false },
      "min-training-votes": { type: "string", default: "25" },
      "half-life-days": { type: "string", default: "365" },
      threshold: { type: "string", default: "0.15" },
      "max-precedents": { type: "string", default: "8" },
      "high-confidence": { type: "string", default: "0.9" },
      "calibration-prior": { type: "string", default: "10" },
      "min-calibration-samples": { type: "string", default: "20" },
      preferences: { type: "string" },
      rules: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (positionals.length !== 1) throw new Error("backtest requires exactly one history JSON path");

  const history = await readJson(positionals[0]);
  const [statedPreferences, hardRules] = await Promise.all([
    optionalArray(values.preferences, "preferences"),
    optionalArray(values.rules, "rules"),
  ]);
  const report = runChronologicalBacktest(history, {
    minTrainingVotes: Number(values["min-training-votes"]),
    halfLifeDays: Number(values["half-life-days"]),
    relevantSimilarityThreshold: Number(values.threshold),
    maxPrecedents: Number(values["max-precedents"]),
    highConfidenceThreshold: Number(values["high-confidence"]),
    calibrationPriorStrength: Number(values["calibration-prior"]),
    minCalibrationSamples: Number(values["min-calibration-samples"]),
    statedPreferences,
    hardRules,
  });

  if (values.stdout) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const destination =
    values.output ||
    defaultPrivatePath("backtests", report.dao, `${report.voter.toLowerCase()}.json`);
  const absolutePath = await writePrivateJson(destination, report);
  process.stdout.write(
    `${JSON.stringify(
      {
        voter: report.voter,
        predictions: report.summary.predictionCount,
        correct: report.summary.correctCount,
        accuracy: report.summary.accuracy,
        majorityClass: report.summary.majorityClass,
        majorityClassAccuracy: report.summary.majorityClassAccuracy,
        accuracyLiftOverMajority: report.summary.accuracyLiftOverMajority,
        balancedAccuracy: report.summary.balancedAccuracy,
        rawBrierScore: report.summary.rawBrierScore,
        onlineCalibratedBrierScore: report.summary.onlineCalibratedBrierScore,
        rawExpectedCalibrationError: report.summary.rawExpectedCalibrationError,
        highConfidence: report.summary.highConfidence,
        perClass: report.perClass,
        byCategory: report.byCategory,
        byYear: report.byYear,
        confidenceBuckets: report.confidenceBuckets,
        failureModes: report.failureModes,
        calibrationModelId: report.calibrationModel.modelId,
        output: absolutePath,
      },
      null,
      2,
    )}\n`,
  );
}

async function inspectCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      stdout: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (positionals.length !== 1) throw new Error("inspect requires exactly one normalized proposal JSON path");
  const proposalInput = await readJson(positionals[0]);
  const report = inspectNounsProposal(proposalInput.proposal || proposalInput);
  if (values.stdout) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const destination = values.output || defaultPrivatePath("inspections", "nouns", `${report.proposalId}.json`);
  const absolutePath = await writePrivateJson(destination, report);
  process.stdout.write(`${JSON.stringify({ ...report.summary, flags: report.flags, mismatches: report.mismatches, output: absolutePath }, null, 2)}\n`);
}

async function prepareVoteCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      support: { type: "string" },
      from: { type: "string" },
      "asset-owner": { type: "string" },
      "execution-address": { type: "string" },
      reason: { type: "string" },
      "acknowledge-security-review": { type: "boolean", default: false },
      rpc: { type: "string", default: process.env.ETHEREUM_RPC_URL },
      output: { type: "string", short: "o" },
      stdout: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (positionals.length !== 2) {
    throw new Error("prepare-vote requires prediction and normalized proposal JSON paths");
  }
  if (!values.support) {
    throw new Error("prepare-vote requires --support AGAINST, FOR, or ABSTAIN as explicit confirmation");
  }
  if (!values.rpc) {
    throw new Error("prepare-vote requires --rpc or ETHEREUM_RPC_URL");
  }
  const [prediction, proposalInput] = await Promise.all([
    readJson(positionals[0]),
    readJson(positionals[1]),
  ]);
  const provider = new JsonRpcProvider(values.rpc, 1, { staticNetwork: false });
  const adapter = new NounsDaoAdapter({ provider });
  const preparation = await adapter.prepareVote({
    prediction,
    proposal: proposalInput.proposal || proposalInput,
    selectedSupport: values.support,
    votingAddress: values["execution-address"] || values.from,
    executionAddress: values["execution-address"] || values.from,
    assetOwnerAddress: values["asset-owner"],
    reason: values.reason,
    acknowledgeSecurityReview: values["acknowledge-security-review"],
  });
  if (values.stdout) {
    process.stdout.write(`${JSON.stringify(preparation, null, 2)}\n`);
  } else {
    const destination =
      values.output ||
      defaultPrivatePath(
        "preparations",
        preparation.dao,
        preparation.modelVoter.toLowerCase(),
        `${preparation.proposalId}.json`,
      );
    const absolutePath = await writePrivateJson(destination, preparation);
    process.stdout.write(
      `${JSON.stringify(
        {
          status: preparation.status,
          proposalId: preparation.proposalId,
          modelVoter: preparation.modelVoter,
          votingAddress: preparation.votingAddress,
          addressRoles: preparation.addressRoles,
          recommendation: preparation.recommendation,
          selectedSupport: preparation.selectedSupport,
          confidencePercent: preparation.confidencePercent,
          proposalState: preparation.verification.proposalState.label,
          votingPower: preparation.verification.votingPower.votes,
          delegation: preparation.verification.delegation,
          simulation: preparation.verification.simulation,
          blockers: preparation.blockers,
          flags: preparation.flags,
          security: preparation.security,
          transactionPrepared: preparation.transaction !== null,
          output: absolutePath,
        },
        null,
        2,
      )}\n`,
    );
  }
  if (preparation.status === "BLOCKED") process.exitCode = 2;
}

function normalizeMode(value) {
  const mode = String(value || ExecutionMode.UNSIGNED).toLowerCase();
  if (mode === "safe") return ExecutionMode.SAFE_SUPERVISED;
  if (mode === "waap") return ExecutionMode.WAAP_AUTONOMOUS;
  if (!Object.values(ExecutionMode).includes(mode)) {
    throw new Error("mode must be unsigned, safe-supervised, or waap-autonomous");
  }
  return mode;
}

function configuredExecutionAddress(mode, values, modelAddress) {
  if (values["execution-address"]) return values["execution-address"];
  if (mode === ExecutionMode.SAFE_SUPERVISED) return values["safe-address"] || process.env.GAVEL_SAFE_ADDRESS;
  if (mode === ExecutionMode.WAAP_AUTONOMOUS) return values["waap-address"] || process.env.GAVEL_WAAP_ADDRESS;
  return modelAddress;
}

async function executionStatusCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dao: { type: "string", default: "nouns" },
      mode: { type: "string", default: ExecutionMode.UNSIGNED },
      "model-address": { type: "string", default: process.env.GAVEL_MODEL_ADDRESS },
      "asset-owner-address": { type: "string", default: process.env.GAVEL_ASSET_OWNER_ADDRESS },
      "execution-address": { type: "string" },
      "safe-address": { type: "string" },
      "waap-address": { type: "string" },
      rpc: { type: "string", default: process.env.ETHEREUM_RPC_URL },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (positionals.length !== 0) throw new Error("execution-status accepts no positional arguments");
  if (values.dao !== "nouns") throw new Error(`Unsupported DAO: ${values.dao}`);
  if (!values["model-address"]) throw new Error("execution-status requires --model-address or GAVEL_MODEL_ADDRESS");
  if (!values.rpc) throw new Error("execution-status requires --rpc or ETHEREUM_RPC_URL");
  const mode = normalizeMode(values.mode);
  const executionAddress = configuredExecutionAddress(mode, values, values["model-address"]);
  if (!executionAddress) throw new Error(`No execution address configured for ${mode}`);
  const provider = new JsonRpcProvider(values.rpc, 1, { staticNetwork: false });
  const adapter = new NounsDaoAdapter({ provider });
  const status = await resolveExecutionReadiness({
    adapter,
    mode,
    modelAddress: values["model-address"],
    assetOwnerAddress: values["asset-owner-address"],
    executionAddress,
  });
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  if (!status.canVote) process.exitCode = 2;
}

async function prepareDelegationCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dao: { type: "string", default: "nouns" },
      to: { type: "string" },
      executor: { type: "string" },
      "asset-owner-address": { type: "string", default: process.env.GAVEL_ASSET_OWNER_ADDRESS },
      "model-address": { type: "string", default: process.env.GAVEL_MODEL_ADDRESS },
      "safe-address": { type: "string" },
      "waap-address": { type: "string" },
      rpc: { type: "string", default: process.env.ETHEREUM_RPC_URL },
      output: { type: "string", short: "o" },
      stdout: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (positionals.length !== 0) throw new Error("prepare-delegation accepts no positional arguments");
  if (values.dao !== "nouns") throw new Error(`Unsupported DAO: ${values.dao}`);
  if (!values.rpc) throw new Error("prepare-delegation requires --rpc or ETHEREUM_RPC_URL");
  const assetOwnerAddress = values["asset-owner-address"] || values["model-address"];
  if (!assetOwnerAddress) {
    throw new Error("prepare-delegation requires --asset-owner-address (or an explicit model-address fallback)");
  }
  let requiredDelegateAddress = values.to;
  if (!requiredDelegateAddress && values.executor) {
    const mode = normalizeMode(values.executor);
    requiredDelegateAddress = configuredExecutionAddress(mode, values, values["model-address"]);
  }
  if (!requiredDelegateAddress) {
    throw new Error("prepare-delegation requires --to or --executor with a configured Safe/WaaP address");
  }
  const provider = new JsonRpcProvider(values.rpc, 1, { staticNetwork: false });
  const adapter = new NounsDaoAdapter({ provider });
  const preparation = await adapter.prepareDelegation({ assetOwnerAddress, requiredDelegateAddress });
  if (values.stdout) {
    process.stdout.write(`${JSON.stringify(preparation, null, 2)}\n`);
    return;
  }
  const destination = values.output || defaultPrivatePath(
    "delegations",
    preparation.dao,
    `${preparation.assetOwnerAddress.toLowerCase()}.json`,
  );
  const absolutePath = await writePrivateJson(destination, preparation);
  process.stdout.write(`${JSON.stringify({ ...preparation, output: absolutePath }, null, 2)}\n`);
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (command === "history") return historyCommand(argv);
  if (command === "onboard") return onboardingCommand(argv);
  if (command === "proposal") return proposalCommand(argv);
  if (command === "profile") return profileCommand(argv);
  if (command === "predict") return predictCommand(argv);
  if (command === "backtest") return backtestCommand(argv);
  if (command === "inspect") return inspectCommand(argv);
  if (command === "prepare-vote") return prepareVoteCommand(argv);
  if (command === "execution-status") return executionStatusCommand(argv);
  if (command === "prepare-delegation") return prepareDelegationCommand(argv);
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  const command = process.argv[2];
  const failure = classifyOperationalFailure(command, error);
  if (process.env.GAVEL_STRUCTURED_ERRORS === "1") process.stderr.write(`${JSON.stringify(failure)}\n`);
  else process.stderr.write(`gavel: [${failure.category}] ${failure.message}\n`);
  process.exitCode = 1;
});
