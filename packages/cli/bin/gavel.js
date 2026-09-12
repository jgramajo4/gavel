#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { Wallet, getAddress } = require("ethers");

const {
  DEFAULT_ENDPOINT,
  DEFAULT_ETHEREUM_RPC_URL,
  NounsDaoAdapter,
  NounsSubgraphHistoryAdapter,
  createEthereumProvider,
  inspectNounsProposal,
} = require("../../nouns-adapter");
const { EnsDaoAdapter } = require("../../ens-adapter");
const { RailgunDaoAdapter } = require("../../railgun-adapter");
const { IndexApiClient } = require("../../governance-index");
const {
  ExecutionMode,
  Support,
  assertCanonicalGovernanceAdapter,
  assertProductionReady,
  profileIdentityReferences,
  ONBOARDING_QUESTIONS,
  applyBacktestEvaluationToPrediction,
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
const SUPPORTED_DAOS = Object.freeze(["nouns", "ens", "railgun-eth"]);

function createDaoAdapter(dao, provider) {
  if (dao === "nouns") return new NounsDaoAdapter({ provider });
  if (dao === "ens") return new EnsDaoAdapter({ provider });
  if (dao === "railgun-eth") return new RailgunDaoAdapter({ provider });
  throw new Error(`Unsupported DAO: ${dao}. Choose ${SUPPORTED_DAOS.join(", ")}.`);
}

function defaultPrivatePath(...segments) {
  return privatePath(DATA_DIR, ...segments);
}

function usage() {
  return `Gavel governance copilot

Usage:
  gavel history <address> [--dao <nouns|ens|railgun-eth>] [--output <path>] [--stdout]
                         [--endpoint <url>] [--page-size <1-1000>]
                         (--endpoint reads Nouns from a subgraph instead of the index)
  gavel onboard <address> --answers <json> [--output <path>] [--stdout]
                           [--recorded-at <timestamp>]
  gavel onboard <address> --questions
  gavel proposal <id> [--dao <nouns|ens|railgun-eth>] [--output <path>] [--stdout]
                      [--endpoint <url>] [--rpc <url>]
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
                     [--acknowledge-prediction-review]
                     [--acknowledge-security-review]
                     [--rpc <url>] [--output <path>] [--stdout]
                     [--amount <wei>] [--hint <index>]
  gavel execution-status --dao <nouns|ens|railgun-eth> --mode <mode> --model-address <address>
                         [--asset-owner-address <address>]
                         [--execution-address <address>] [--rpc <url>]
  gavel prepare-delegation --dao <nouns|ens> --asset-owner-address <address>
                           (--to <address> | --executor <safe|waap>)
                           [--rpc <url>] [--output <path>] [--stdout]
  gavel execution prepare <prediction.json> <proposal.json> --support <choice>
                          [--execution-address <address>] [--asset-owner <address>]
                          [--reason <text>] [--rpc <url>] [--output <path>] [--stdout]
  gavel execution submit <prediction.json> <proposal.json> --support <choice>
                         --profile <execution-profile.json> [--mode <mode>]
                         [--expect-intent <hash|intent.json>] [--rpc <url>]
  gavel identity create --type safe-proposer --safe <address> [--chain-id <id>]
                        [--label <name>] [--passphrase-env <VAR>]

Commands:
  history   Fetch indexed governance history (Nouns defaults to its subgraph when no index is configured).
  onboard   Record low-history questionnaire answers as stated preferences.
  proposal  Fetch one indexed proposal; ENS is live-verified against its Governor.
  profile   Build a private three-layer voter profile from normalized history.
  predict   Recommend FOR, AGAINST, or ABSTAIN using personal precedents.
  backtest  Run leakage-free chronological evaluation and confidence calibration.
  inspect   Decode and security-check structured Nouns proposal actions.
  prepare-vote  Verify canonical chain state and produce unsigned vote calldata.
  execution-status  Fail-closed readiness for unsigned, Safe, or WaaP execution.
  prepare-delegation  Prepare, but never submit, Nouns or ENS delegation calldata.
  execution prepare   Validate live against the DAO and emit a canonical ValidatedExecutionIntent.
  execution submit    Re-validate live, then hand the intent to a configured execution backend.
  identity create     Create a locally held, encrypted Safe proposal identity.

Execution boundary:
  Execution commands operate only on Gavel-generated intents. There is no
  surface that submits caller-supplied calldata: every action must travel
  natural language -> governance intent -> execution intent -> validation
  -> executor. A stored intent document is an audit artifact, never an
  authorization: submission always re-validates against live chain state.

Network:
  Chain-backed commands use ${DEFAULT_ETHEREUM_RPC_URL} by default.
  Advanced users can override it with ETHEREUM_RPC_URL or --rpc.

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

// `--endpoint` opts Nouns reads out of the index and back onto a subgraph. Its
// value is optional: NOUNS_SUBGRAPH_URL, then the public subgraph, fill it in.
function subgraphEndpoint(value) {
  const endpoint = typeof value === "string" && value !== "" ? value : null;
  return endpoint || process.env.NOUNS_SUBGRAPH_URL || DEFAULT_ENDPOINT;
}

async function historyCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      stdout: { type: "boolean", default: false },
      endpoint: { type: "string" },
      "page-size": { type: "string", default: "100" },
      dao: { type: "string", default: "nouns" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (positionals.length !== 1) throw new Error("history requires exactly one voter address");

  const voter = getAddress(positionals[0]);
  if (!SUPPORTED_DAOS.includes(values.dao)) throw new Error(`Unsupported DAO: ${values.dao}`);
  const pageSize = Number(values["page-size"]);
  // Every DAO reads the index by default. A Nouns voter's history is hundreds of
  // paginated subgraph queries per user, which the index answers once; `--endpoint`
  // is the explicit opt-out back to the subgraph.
  const document = values.dao === "nouns" && values.endpoint
    ? await new NounsSubgraphHistoryAdapter({ endpoint: subgraphEndpoint(values.endpoint), pageSize }).fetchHistory(voter)
    : await new IndexApiClient({ pageSize }).fetchHistory(values.dao, voter);

  if (values.stdout) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }

  const destination =
    values.output || defaultPrivatePath(values.dao, `${voter.toLowerCase()}.json`);
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
    proposalInspector: SUPPORTED_DAOS.includes(profile.dao) ? inspectNounsProposal : undefined,
    allowedSupports: profile.dao === "railgun-eth" ? [Support.FOR, Support.AGAINST] : undefined,
  });
  if (values.calibration) {
    const calibrationInput = await readJson(values.calibration);
    const calibrationModel = calibrationInput.calibrationModel || calibrationInput;
    prediction = applyCalibrationToPrediction(prediction, calibrationModel);
    if (calibrationInput.calibrationModel && calibrationInput.summary) {
      prediction = applyBacktestEvaluationToPrediction(prediction, calibrationInput);
    }
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
        confidenceKind: prediction.confidenceKind,
        predictionReview: prediction.predictionReview,
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
      dao: { type: "string", default: "nouns" },
      output: { type: "string", short: "o" },
      stdout: { type: "boolean", default: false },
      endpoint: { type: "string" },
      rpc: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (positionals.length !== 1 || !/^\d+$/.test(positionals[0])) {
    throw new Error("proposal requires exactly one unsigned proposal ID");
  }
  if (!SUPPORTED_DAOS.includes(values.dao)) throw new Error(`Unsupported DAO: ${values.dao}`);
  let proposal;
  if (values.dao === "ens") {
    // Only `ProposalCreated` carries the complete description and actions, so
    // ENS reads the index and live-verifies what it returns over RPC.
    const client = new IndexApiClient();
    const provider = createEthereumProvider({ rpcUrl: values.rpc });
    proposal = await new EnsDaoAdapter({ provider, proposalLoader: (id) => client.fetchProposal("ens", id) }).fetchProposal(positionals[0]);
  } else if (values.dao === "nouns" && values.endpoint) {
    proposal = await new NounsSubgraphHistoryAdapter({ endpoint: subgraphEndpoint(values.endpoint) }).fetchProposal(positionals[0]);
  } else if (values.dao === "nouns" || process.env.GAVEL_INDEX_API_URL) {
    proposal = await new IndexApiClient().fetchProposal(values.dao, positionals[0]);
  } else {
    // Railgun proposal state is a single live contract read, so it stays on RPC
    // unless an operator points the CLI at an index.
    const provider = createEthereumProvider({ rpcUrl: values.rpc });
    proposal = await createDaoAdapter(values.dao, provider).fetchProposal(positionals[0]);
  }
  if (values.stdout) {
    process.stdout.write(`${JSON.stringify(proposal, null, 2)}\n`);
    return;
  }
  const destination = values.output || defaultPrivatePath("proposals", values.dao, `${proposal.id}.json`);
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
  const destination = values.output || defaultPrivatePath("inspections", proposalInput.dao || "nouns", `${report.proposalId}.json`);
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
      amount: { type: "string" },
      hint: { type: "string" },
      "acknowledge-security-review": { type: "boolean", default: false },
      "acknowledge-prediction-review": { type: "boolean", default: false },
      rpc: { type: "string" },
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
  const [prediction, proposalInput] = await Promise.all([
    readJson(positionals[0]),
    readJson(positionals[1]),
  ]);
  const provider = createEthereumProvider({ rpcUrl: values.rpc });
  const adapter = createDaoAdapter(prediction.dao, provider);
  const preparation = await adapter.prepareVote({
    prediction,
    proposal: proposalInput.proposal || proposalInput,
    selectedSupport: values.support,
    votingAddress: values["execution-address"] || values.from,
    executionAddress: values["execution-address"] || values.from,
    assetOwnerAddress: values["asset-owner"],
    reason: values.reason,
    amount: values.amount,
    hint: values.hint,
    acknowledgeSecurityReview: values["acknowledge-security-review"],
    acknowledgePredictionReview: values["acknowledge-prediction-review"],
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
          delegation: preparation.verification.delegation || preparation.verification.votingKey,
          simulation: preparation.verification.simulation,
          blockers: preparation.blockers,
          flags: preparation.flags,
          security: preparation.security,
          predictionReview: preparation.predictionReview,
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
      rpc: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (positionals.length !== 0) throw new Error("execution-status accepts no positional arguments");
  if (!SUPPORTED_DAOS.includes(values.dao)) throw new Error(`Unsupported DAO: ${values.dao}`);
  if (!values["model-address"]) throw new Error("execution-status requires --model-address or GAVEL_MODEL_ADDRESS");
  const mode = normalizeMode(values.mode);
  const executionAddress = configuredExecutionAddress(mode, values, values["model-address"]);
  if (!executionAddress) throw new Error(`No execution address configured for ${mode}`);
  const provider = createEthereumProvider({ rpcUrl: values.rpc });
  const adapter = createDaoAdapter(values.dao, provider);
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
      rpc: { type: "string" },
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
  if (!SUPPORTED_DAOS.includes(values.dao)) throw new Error(`Unsupported DAO: ${values.dao}`);
  if (values.dao === "railgun-eth") {
    throw new Error("Railgun delegation is per stake ID and is not available through prepare-delegation; configure staking delegation separately.");
  }
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
  const provider = createEthereumProvider({ rpcUrl: values.rpc });
  const adapter = createDaoAdapter(values.dao, provider);
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

/**
 * `gavel execution prepare` -- run live governance validation and emit the
 * canonical ValidatedExecutionIntent.
 *
 * It takes the same inputs as `prepare-vote` (a prediction and a normalized
 * proposal) and runs the DAO adapter against a provider, because that is the
 * only thing that makes a validated intent a statement about chain state.
 *
 * It deliberately does NOT accept a stored preparation document. Lifting one
 * was a hole: a `READY_TO_SIGN` JSON could be edited to encode a different
 * proposal id behind the same valid selector, and the seal would be stamped
 * over the attacker's calldata without anything re-reading the chain.
 */
async function executionPrepareCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      support: { type: "string" },
      from: { type: "string" },
      "asset-owner": { type: "string" },
      "execution-address": { type: "string" },
      reason: { type: "string" },
      amount: { type: "string" },
      hint: { type: "string" },
      "acknowledge-security-review": { type: "boolean", default: false },
      "acknowledge-prediction-review": { type: "boolean", default: false },
      rpc: { type: "string" },
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
    throw new Error("execution prepare requires prediction and normalized proposal JSON paths");
  }
  if (!values.support) {
    throw new Error("execution prepare requires --support AGAINST, FOR, or ABSTAIN as explicit confirmation");
  }

  const [prediction, proposalInput] = await Promise.all([
    readJson(positionals[0]),
    readJson(positionals[1]),
  ]);
  const proposal = proposalInput.proposal || proposalInput;
  const provider = createEthereumProvider({ rpcUrl: values.rpc });
  const adapter = assertCanonicalGovernanceAdapter(createDaoAdapter(prediction.dao, provider));

  // Live validation. `prepareValidatedIntent` calls the adapter's own
  // `prepareVote()` against the provider and mints only from that result.
  const { preparation, validated, blockers } = await adapter.prepareValidatedIntent({
    prediction,
    proposal,
    selectedSupport: values.support,
    votingAddress: values["execution-address"] || values.from,
    executionAddress: values["execution-address"] || values.from,
    assetOwnerAddress: values["asset-owner"],
    reason: values.reason,
    amount: values.amount,
    hint: values.hint,
    acknowledgeSecurityReview: values["acknowledge-security-review"],
    acknowledgePredictionReview: values["acknowledge-prediction-review"],
  });

  if (!validated) {
    process.stdout.write(
      `${JSON.stringify({ status: preparation.status, dao: preparation.dao, proposalId: preparation.proposalId, blockers }, null, 2)}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const document = validated.toJSON();
  if (values.stdout) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }
  const destination =
    values.output ||
    defaultPrivatePath("intents", validated.dao, `${validated.intent.source.proposalId}-${validated.intentHash.slice(2, 14)}.json`);
  const absolutePath = await writePrivateJson(destination, document);
  process.stdout.write(
    `${JSON.stringify(
      {
        intentHash: validated.intentHash,
        voteIntentHash: validated.intent.source.voteIntentHash,
        dao: validated.dao,
        proposalId: validated.intent.source.proposalId,
        support: validated.intent.source.support,
        actor: validated.actor,
        target: validated.intent.target,
        selector: validated.validation.selector,
        proposalState: validated.validation.proposalState,
        autonomyAllowed: validated.validation.autonomyAllowed,
        deadline: validated.validation.deadline,
        semantics: validated.validation.semantics,
        output: absolutePath,
        note:
          "This document is an audit artifact, not an authorization. `gavel execution submit` " +
          "re-runs live validation rather than trusting it.",
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * `gavel execution submit` -- re-validate live, then hand the intent to a
 * configured execution backend.
 *
 * It takes the governance inputs, not a stored intent document. A document is
 * an audit artifact: re-entering the boundary means re-validating against a
 * live adapter, so submitting from JSON would mean trusting whatever that JSON
 * says. `--expect-intent` pins the run to a previously reviewed intent hash,
 * which is how a human approval is carried forward without the document itself
 * becoming the authorization.
 *
 * No live Safe Transaction Service or autonomous broadcaster is bundled, so
 * this stops at the point where a backend would be invoked.
 */
async function executionSubmitCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      support: { type: "string" },
      from: { type: "string" },
      "asset-owner": { type: "string" },
      "execution-address": { type: "string" },
      reason: { type: "string" },
      mode: { type: "string" },
      profile: { type: "string" },
      "expect-intent": { type: "string" },
      "acknowledge-security-review": { type: "boolean", default: false },
      "acknowledge-prediction-review": { type: "boolean", default: false },
      rpc: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (positionals.length !== 2) {
    throw new Error("execution submit requires prediction and normalized proposal JSON paths");
  }
  if (!values.support) throw new Error("execution submit requires --support as explicit confirmation");
  if (!values.profile) {
    throw new Error(
      "execution submit requires --profile naming an execution profile. Mode selection is explicit: " +
        "see docs/architecture/execution.md for the profile format.",
    );
  }

  const profile = assertProductionReady(await readJson(values.profile));
  const mode = normalizeMode(values.mode || profile.mode);
  if (mode !== profile.mode) {
    throw new Error(`--mode ${mode} does not match the profile mode ${profile.mode}`);
  }

  const [prediction, proposalInput] = await Promise.all([
    readJson(positionals[0]),
    readJson(positionals[1]),
  ]);
  const provider = createEthereumProvider({ rpcUrl: values.rpc });
  const adapter = assertCanonicalGovernanceAdapter(createDaoAdapter(prediction.dao, provider));
  const { validated, blockers } = await adapter.prepareValidatedIntent({
    prediction,
    proposal: proposalInput.proposal || proposalInput,
    selectedSupport: values.support,
    votingAddress: values["execution-address"] || values.from,
    executionAddress: values["execution-address"] || values.from,
    assetOwnerAddress: values["asset-owner"],
    reason: values.reason,
    acknowledgeSecurityReview: values["acknowledge-security-review"],
    acknowledgePredictionReview: values["acknowledge-prediction-review"],
  });
  if (!validated) {
    throw new Error(`Live validation refused this vote: ${blockers.map((blocker) => blocker.code).join(", ")}`);
  }

  // A reviewed intent hash pins the run: if live revalidation produces a
  // different action than the human approved, stop rather than submit it.
  if (values["expect-intent"]) {
    const expected = /^0x[0-9a-f]{64}$/.test(values["expect-intent"])
      ? values["expect-intent"]
      : (await readJson(values["expect-intent"])).intentHash;
    if (expected !== validated.intentHash) {
      throw new Error(
        `Live revalidation produced intent ${validated.intentHash}, not the reviewed ${expected}. ` +
          "The governance action changed; review it again rather than submitting this one.",
      );
    }
  }

  throw new Error(
    `No execution backend is registered for ${mode} in this build. Live validation passed ` +
      `(intent ${validated.intentHash}, identities: ` +
      `${profileIdentityReferences(profile).map((entry) => `${entry.role}=${entry.reference}`).join(", ") || "none"}). ` +
      `Register a ${mode} adapter with the ExecutionEngine to submit, or use \`gavel prepare-vote\` ` +
      "output for out-of-band signing.",
  );
}

/**
 * `gavel identity create --type safe-proposer` -- create a locally held,
 * encrypted Safe proposal identity.
 *
 * This is the BYOH installation flow's first step:
 *
 *   create proposal identity -> show address -> authorize as a Safe delegate
 *   -> verify delegation -> bind identity to the user's Safe
 *
 * The key is generated here and written only in encrypted form, mode 0600,
 * under GAVEL_DATA_DIR. It is a proposal identity: it never becomes a Safe
 * owner, holds no funds, and holds no governance delegation.
 */
async function identityCreateCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      type: { type: "string" },
      safe: { type: "string" },
      "chain-id": { type: "string" },
      label: { type: "string" },
      "passphrase-env": { type: "string" },
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (positionals.length !== 0) throw new Error("identity create accepts no positional arguments");
  if (values.type !== "safe-proposer") {
    throw new Error("identity create currently supports --type safe-proposer");
  }
  if (!values.safe) throw new Error("identity create requires --safe with the Safe address to propose into");
  const safeAddress = getAddress(values.safe);
  const chainId = Number(values["chain-id"] || 1);
  const label = values.label || "safe-proposer-main";
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error("identity label must be alphanumeric with . _ or -");

  const passphraseVariable = values["passphrase-env"] || "GAVEL_IDENTITY_PASSPHRASE";
  const passphrase = process.env[passphraseVariable];
  if (!passphrase || passphrase.length < 12) {
    throw new Error(
      `Set ${passphraseVariable} to a passphrase of at least 12 characters. ` +
        "It encrypts the keystore and is never written to disk.",
    );
  }

  const wallet = Wallet.createRandom();
  const keystore = await wallet.encrypt(passphrase);
  const destination = values.output || defaultPrivatePath("identities", `${label}.json`);
  const absolutePath = await writePrivateJson(destination, {
    version: 1,
    kind: "GAVEL_PROPOSAL_IDENTITY",
    role: "proposal",
    label,
    address: wallet.address,
    scope: { safeAddress, chainId },
    capabilities: ["proposeSafeTransaction"],
    passphraseEnv: passphraseVariable,
    createdAt: new Date().toISOString(),
    keystore: JSON.parse(keystore),
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        role: "proposal",
        reference: `local:${label}`,
        address: wallet.address,
        scope: { safeAddress, chainId },
        capabilities: ["proposeSafeTransaction"],
        output: absolutePath,
        nextSteps: [
          `Add ${wallet.address} as a delegate (not an owner) of Safe ${safeAddress} on chain ${chainId}.`,
          "Verify the delegation, then reference it from an execution profile as " +
            `execution.safe.proposalIdentity: "local:${label}".`,
          "This identity can only propose transactions into the Safe queue. Human Safe owners " +
            "retain authorization, and it can be revoked by removing the delegate without " +
            "touching the Safe's owners.",
        ],
      },
      null,
      2,
    )}\n`,
  );
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
  if (command === "execution") {
    const [subcommand, ...rest] = argv;
    if (subcommand === "prepare") return executionPrepareCommand(rest);
    if (subcommand === "submit") return executionSubmitCommand(rest);
    throw new Error("execution accepts the subcommands prepare and submit");
  }
  if (command === "identity") {
    const [subcommand, ...rest] = argv;
    if (subcommand === "create") return identityCreateCommand(rest);
    throw new Error("identity accepts the subcommand create");
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  const command = process.argv[2];
  const failure = classifyOperationalFailure(command, error);
  if (process.env.GAVEL_STRUCTURED_ERRORS === "1") process.stderr.write(`${JSON.stringify(failure)}\n`);
  else process.stderr.write(`gavel: [${failure.category}] ${failure.message}\n`);
  process.exitCode = 1;
});
