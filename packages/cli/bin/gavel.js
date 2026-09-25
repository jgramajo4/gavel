#!/usr/bin/env node

const fs = require("node:fs/promises");
const { constants: fsConstants } = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { Wallet, getAddress } = require("ethers");

const {
  DEFAULT_ENDPOINT,
  DEFAULT_ETHEREUM_RPC_URL,
  NounsDaoAdapter,
  NounsSubgraphHistoryAdapter,
  createEthereumProvider,
  resolveEthereumRpcUrl,
  inspectNounsProposal,
} = require("../../nouns-adapter");
const { DAO_CONFIGS, IndexApiClient } = require("../../governance-index");
const { createDaoAdapter: createWiredDaoAdapter } = require("@gavel/daos");
const {
  ExecutionMode,
  ExecutionEngine,
  FileExecutionRecordStore,
  KeystoreSigningIdentity,
  SafeProposalProvider,
  SafeSupervisedExecutionAdapter,
  Support,
  assertCanonicalGovernanceAdapter,
  assertProductionReady,
  profileIdentityReferences,
  createProposalIdentity,
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
  listDaoIds,
  interactiveExecutionAvailability,
  loadGavelConfig,
  resolveIndexApiEndpoint,
  resolveDaoContext,
  assertCanonicalProposalIdentity,
  canonicalProposalIdentity,
  presentProposalResponse,
} = require("../../core");
const { createGateClient, GateClientError, sanitizeHumanText } = require("../gate-client");
const {
  configCommand,
  daosCommand,
  readinessCommand,
  secretsCommand,
  walletCommand,
} = require("../runtime-commands");

const DATA_DIR = resolveDataDir();
// The DAO list is the catalog's, not a constant maintained here. Adding an
// adapter must not mean editing a private array in the CLI.
const SUPPORTED_DAOS = Object.freeze(listDaoIds());

function createDaoAdapter(dao, provider) {
  return createWiredDaoAdapter(dao, { provider });
}

function defaultPrivatePath(...segments) {
  return privatePath(DATA_DIR, ...segments);
}

/**
 * Which DAO this invocation is about.
 *
 * Every DAO-scoped command goes through here, so the policy lives in one
 * place instead of four `default: "nouns"` declarations. An omitted `--dao`
 * resolves only when the user follows exactly one DAO; with several followed
 * it is an error naming them, because `nouns:123` and `ens:123` are different
 * proposals and guessing between them is how a vote lands in the wrong DAO.
 */
async function resolveCommandDao(values) {
  const loaded = await loadGavelConfig({});
  return resolveDaoContext({
    explicitDao: values.dao,
    followedDaos: loaded.config.followedDaos,
  }).dao;
}

/** Resolve the one operational index endpoint from the shared runtime config. */
async function resolveCommandIndexEndpoint() {
  const loaded = await loadGavelConfig({});
  return resolveIndexApiEndpoint(loaded.config, process.env);
}

/** Railgun proposal reads opt into the index only through explicit configuration. */
async function resolveExplicitCommandIndexEndpoint(options = {}) {
  const loaded = await loadGavelConfig({});
  const runtime = loaded.config.runtime;
  if (runtime.indexApiUrl !== null) {
    const resolved = resolveIndexApiEndpoint(loaded.config, process.env);
    return resolved.url ? resolved : null;
  }
  if (runtime.indexApiUrlVariable) {
    const value = process.env[runtime.indexApiUrlVariable]?.trim();
    if (!value && options.ignoreMissingVariable) return null;
    return resolveIndexApiEndpoint(loaded.config, process.env);
  }
  if (process.env.GAVEL_INDEX_API_URL !== undefined) {
    const resolved = resolveIndexApiEndpoint(loaded.config, process.env);
    return resolved.url ? resolved : null;
  }
  return null;
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
  gavel present <proposal.json> <prediction.json> [--explanation <plain-text-path>]
                                                     [--output <path>] [--stdout]
  gavel analyze-present <proposal-id> --dao <dao> --profile <profile.json>
                          [--explanation <plain-text-path>] [--calibration <backtest.json>]
                          [--output <path>] [--stdout]
  gavel present-batch <manifest.json> [--output <path>] [--stdout]
  gavel analyze-present-batch <manifest.json> [--output <path>] [--stdout]
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
                          [--dao <id>] (asserts the documents' DAO; never retargets)
                          [--execution-address <address>] [--asset-owner <address>]
                          [--reason <text>] [--rpc <url>] [--output <path>] [--stdout]
  gavel execution submit <prediction.json> <proposal.json> --support <choice>
                         --profile <execution-profile.json> [--mode <mode>]
                         [--expect-intent <hash|intent.json>] [--rpc <url>]
  gavel identity create --type safe-proposer --safe <address> [--chain-id <id>]
                        [--label <name>] [--passphrase-env <VAR>]
  gavel safe delegate status --safe <address> [--chain-id <id>] [--identity <local:label>]
                             [--rpc <url>] [--safe-api-url <url>]
  gavel safe delegate setup --safe <address> [--chain-id <id>] [--identity <local:label>]
                            [--rpc <url>] [--safe-api-url <url>]
  gavel daos list [--json]
  gavel daos capabilities [--dao <id>] [--json]
  gavel daos follow <dao>... [--json]
  gavel daos unfollow <dao>... [--json]
  gavel wallet status [--json]
  gavel readiness [--json]
  gavel secrets status [--json]
  gavel config show [--json]
  gavel config path
  gavel config migrate [--json]
  gavel gate profile [--json]
  gavel gate inbox [--json]
  gavel gate inbox show <id> [--json]
  gavel gate inbox archive <id>

Commands:
  history   Fetch indexed governance history (Nouns defaults to its subgraph when no index is configured).
  onboard   Record low-history questionnaire answers as stated preferences.
  proposal  Fetch one indexed proposal; ENS is live-verified against its Governor.
  profile   Build a private three-layer voter profile from normalized history.
  predict   Recommend FOR, AGAINST, or ABSTAIN using personal precedents.
  present   Render supplied artifacts for offline inspection; does not authenticate their origin.
  analyze-present  Fetch canonical proposal, predict from private profile, and render in one operation.
  backtest  Run leakage-free chronological evaluation and confidence calibration.
  inspect   Decode and security-check structured Nouns proposal actions.
  prepare-vote  Verify canonical chain state and produce unsigned vote calldata.
  execution-status  Fail-closed readiness for unsigned, Safe, or WaaP execution.
  prepare-delegation  Prepare, but never submit, Nouns or ENS delegation calldata.
  execution prepare   Validate live against the DAO and emit a canonical ValidatedExecutionIntent.
  execution submit    Re-validate live, then hand the intent to a configured execution backend.
  identity create     Create a locally held, encrypted Safe proposal identity.
  daos      List, inspect and follow governance systems. The TUI reads the same catalog.
  wallet    Report the wallet connection type, governance identity and roles. Never a secret.
  readiness Runtime and per-DAO readiness: monitor, analyze, vote, separately.
  secrets   Report each secret's source and status. Never its value.
  config    Show, locate or migrate the Gavel client configuration.
  gate profile        Fetch the authenticated Gate public profile projection.
  gate inbox          List, show, or archive the authenticated private Gate inbox.

Execution boundary:
  Execution commands operate only on Gavel-generated intents. There is no
  surface that submits caller-supplied calldata: every action must travel
  natural language -> governance intent -> execution intent -> validation
  -> executor. A stored intent document is an audit artifact, never an
  authorization: submission always re-validates against live chain state.

DAO selection:
  --dao names the governance system a command acts on. Omit it only when you
  follow exactly one DAO: with several followed, Gavel refuses rather than
  guessing, because proposal IDs are per-DAO and nouns:123 is not ens:123.

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

async function writePrivateJson(filePath, document, { secureDirectory = false } = {}) {
  const absolutePath = path.resolve(filePath);
  const directory = path.dirname(absolutePath);
  await fs.mkdir(directory, { recursive: true, mode: secureDirectory ? 0o700 : 0o755 });
  if (secureDirectory) await fs.chmod(directory, 0o700);
  await fs.writeFile(absolutePath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(absolutePath, 0o600);
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
      dao: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (positionals.length !== 1) throw new Error("history requires exactly one voter address");

  const voter = getAddress(positionals[0]);
  const dao = await resolveCommandDao(values);
  const pageSize = Number(values["page-size"]);
  // Every DAO reads the index by default. A Nouns voter's history is hundreds of
  // paginated subgraph queries per user, which the index answers once; `--endpoint`
  // is the explicit opt-out back to the subgraph.
  let document;
  if (dao === "nouns" && values.endpoint) {
    document = await new NounsSubgraphHistoryAdapter({ endpoint: subgraphEndpoint(values.endpoint), pageSize }).fetchHistory(voter);
  } else {
    const indexEndpoint = await resolveCommandIndexEndpoint();
    if (indexEndpoint.url) {
      document = await new IndexApiClient({ baseUrl: indexEndpoint.url, pageSize }).fetchHistory(dao, voter);
    } else if (dao === "nouns") {
      document = await new NounsSubgraphHistoryAdapter({ endpoint: subgraphEndpoint(), pageSize }).fetchHistory(voter);
    } else {
      throw new Error(`${dao} history requires a configured governance index endpoint`);
    }
  }

  if (values.stdout) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }

  const destination =
    values.output || defaultPrivatePath(dao, `${voter.toLowerCase()}.json`);
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
        identity: prediction.identity,
        proposalContentHash: prediction.proposalContentHash,
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
      dao: { type: "string" },
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
  const dao = await resolveCommandDao(values);
  let proposal;
  if (dao === "ens") {
    // Only `ProposalCreated` carries the complete description and actions, so
    // ENS reads the index and live-verifies what it returns over RPC.
    const indexEndpoint = await resolveCommandIndexEndpoint();
    if (!indexEndpoint.url) throw new Error("ENS proposal lookup requires a configured governance index endpoint");
    const client = new IndexApiClient({ baseUrl: indexEndpoint.url });
    const provider = createEthereumProvider({ rpcUrl: values.rpc });
    proposal = await new EnsDaoAdapter({ provider, proposalLoader: (id) => client.fetchProposal("ens", id) }).fetchProposal(positionals[0]);
  } else if (dao === "nouns" && values.endpoint) {
    proposal = await new NounsSubgraphHistoryAdapter({ endpoint: subgraphEndpoint(values.endpoint) }).fetchProposal(positionals[0]);
  } else if (dao === "nouns") {
    const indexEndpoint = await resolveCommandIndexEndpoint();
    proposal = indexEndpoint.url
      ? await new IndexApiClient({ baseUrl: indexEndpoint.url }).fetchProposal(dao, positionals[0])
      : await new NounsSubgraphHistoryAdapter({ endpoint: subgraphEndpoint() }).fetchProposal(positionals[0]);
  } else if (dao === "railgun-eth") {
    // Railgun proposal state is a single live contract read, so it stays on RPC
    // unless an operator explicitly points the CLI at an index.
    const indexEndpoint = await resolveExplicitCommandIndexEndpoint({ ignoreMissingVariable: true });
    if (indexEndpoint) {
      proposal = await new IndexApiClient({ baseUrl: indexEndpoint.url }).fetchProposal(dao, positionals[0]);
    } else {
      const provider = createEthereumProvider({ rpcUrl: values.rpc });
      proposal = await createDaoAdapter(dao, provider).fetchProposal(positionals[0]);
    }
  }
  const config = DAO_CONFIGS[dao];
  const expectedIdentity = canonicalProposalIdentity({
    dao,
    chainId: config.chainId,
    governorAddress: config.currentGovernor,
    proposalId: positionals[0],
  });
  if (proposal.identity) {
    assertCanonicalProposalIdentity(proposal.identity, expectedIdentity);
  }
  assertCanonicalProposalIdentity({
    dao: proposal.dao ?? expectedIdentity.dao,
    chainId: proposal.chainId ?? expectedIdentity.chainId,
    governorAddress: proposal.identity?.governorAddress ?? expectedIdentity.governorAddress,
    proposalId: proposal.id,
  }, expectedIdentity);
  proposal = { ...proposal, identity: expectedIdentity };
  if (values.stdout) {
    process.stdout.write(`${JSON.stringify(proposal, null, 2)}\n`);
    return;
  }
  // Stored under the DAO, so `nouns:123` and `ens:123` are two files.
  const destination = values.output || defaultPrivatePath("proposals", dao, `${proposal.id}.json`);
  const absolutePath = await writePrivateJson(destination, proposal);
  process.stdout.write(`${JSON.stringify({ ok: true, dao, proposalId: proposal.id, contentHash: proposal.contentHash, state: proposal.state, actionCount: proposal.actions.length, output: absolutePath }, null, 2)}\n`);
}

async function analyzePresentCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dao: { type: "string" },
      profile: { type: "string" },
      explanation: { type: "string" },
      calibration: { type: "string" },
      output: { type: "string", short: "o" },
      stdout: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) { process.stdout.write(usage()); return; }
  if (positionals.length !== 1 || !values.dao || !values.profile) {
    throw new Error("analyze-present requires a proposal ID, --dao and --profile");
  }
  const presentation = await analyzeCanonicalResponse({
    dao: values.dao,
    proposalId: positionals[0],
    profilePath: values.profile,
    explanationPath: values.explanation,
    calibrationPath: values.calibration,
  });
  await writePresentation(presentation.markdown, values);
}

async function analyzeCanonicalResponse({ dao, proposalId, profilePath, profileInput, explanationPath, explanationText, calibrationPath, calibrationDocument }) {
  const expected = canonicalProposalIdentity({
    dao,
    chainId: DAO_CONFIGS[dao]?.chainId,
    governorAddress: DAO_CONFIGS[dao]?.currentGovernor,
    proposalId,
  });
  const indexEndpoint = await resolveCommandIndexEndpoint();
  if (!indexEndpoint.url) throw new Error("analyze-present requires an enabled canonical governance index");
  // No caller-provided proposal or prediction file crosses this boundary.
  const proposal = await new IndexApiClient({ baseUrl: indexEndpoint.url }).fetchProposal(expected.dao, expected.proposalId);
  assertCanonicalProposalIdentity(proposal.identity, expected);
  const profile = profileInput || await readJson(profilePath);
  if (profile?.dao !== expected.dao || profile?.chainId !== expected.chainId) {
    throw new Error("profile DAO and chain must match the requested proposal");
  }
  let prediction = predictVote(profile, proposal, {
    proposalInspector: expected.dao === "nouns" ? inspectNounsProposal : undefined,
    allowedSupports: expected.dao === "railgun-eth" ? [Support.FOR, Support.AGAINST] : undefined,
  });
  if (calibrationPath || calibrationDocument) {
    const calibrationInput = calibrationDocument || await readJson(calibrationPath);
    prediction = applyCalibrationToPrediction(prediction, calibrationInput.calibrationModel || calibrationInput);
    if (calibrationInput.calibrationModel && calibrationInput.summary) {
      prediction = applyBacktestEvaluationToPrediction(prediction, calibrationInput);
    }
  }
  const explanation = explanationText ?? (explanationPath ? await fs.readFile(path.resolve(explanationPath), "utf8") : "");
  const presentation = presentProposalResponse({ proposal, prediction, explanation });
  assertCanonicalProposalIdentity(presentation.identity, expected);
  return presentation;
}

async function presentCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      explanation: { type: "string" },
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
    throw new Error("present requires a proposal JSON path and prediction JSON path");
  }
  const [proposal, prediction, explanation] = await Promise.all([
    readJson(positionals[0]),
    readJson(positionals[1]),
    values.explanation ? fs.readFile(path.resolve(values.explanation), "utf8") : "",
  ]);
  const presentation = presentProposalResponse({ proposal, prediction, explanation });
  await writePresentation(presentation.markdown, values);
}

async function writePresentation(markdown, values) {
  if (!values.output || values.stdout) process.stdout.write(`${markdown}\n`);
  if (values.output) {
    const destination = path.resolve(values.output);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.writeFile(destination, `${markdown}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

function batchPathInside(base, candidate) {
  const relative = path.relative(base, candidate);
  return Boolean(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function readBatchArtifact(base, filename, { json = true } = {}) {
  const refused = () => new Error("present-batch artifact must stay within the manifest directory");
  if (path.isAbsolute(filename)) throw refused();
  const candidate = path.resolve(base, filename);
  if (!batchPathInside(base, candidate)) throw refused();
  // Linux file-descriptor identity binds containment to the object actually read.
  // Never trust a pathname checked earlier: an attacker can swap a symlink.
  if (process.platform !== "linux") throw refused();
  const resolved = await fs.realpath(candidate);
  if (!batchPathInside(base, resolved)) throw refused();
  const handle = await fs.open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await fs.realpath(`/proc/self/fd/${handle.fd}`);
    if (!batchPathInside(base, opened) || !(await handle.stat()).isFile()) throw refused();
    const source = await handle.readFile("utf8");
    if (!json) return source;
    try { return JSON.parse(source); }
    catch (error) { throw new Error(`Invalid JSON in ${candidate}: ${error.message}`); }
  } finally { await handle.close(); }
}

async function presentBatchCommand(argv) {
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
  if (positionals.length !== 1) throw new Error("present-batch requires one manifest JSON path");
  const manifestPath = path.resolve(positionals[0]);
  const manifest = await readJson(manifestPath);
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.items)
      || manifest.items.length === 0 || manifest.items.length > 100) {
    throw new Error("present-batch manifest must contain 1-100 schemaVersion 1 items");
  }
  const base = await fs.realpath(path.dirname(manifestPath));
  const presentations = [];
  const identities = new Set();
  for (const item of manifest.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)
        || typeof item.proposal !== "string" || typeof item.prediction !== "string"
        || item.explanation !== undefined && typeof item.explanation !== "string") {
      throw new Error("present-batch items require proposal and prediction paths and an optional explanation path");
    }
    const [proposal, prediction, explanation] = await Promise.all([
      readBatchArtifact(base, item.proposal),
      readBatchArtifact(base, item.prediction),
      item.explanation === undefined ? "" : readBatchArtifact(base, item.explanation, { json: false }),
    ]);
    const presentation = presentProposalResponse({ proposal, prediction, explanation });
    const key = `${presentation.identity.dao}:${presentation.identity.chainId}:${presentation.identity.governorAddress}:${presentation.identity.proposalId}`;
    if (identities.has(key)) throw new Error("present-batch contains a duplicate proposal identity");
    identities.add(key);
    presentations.push(presentation.markdown);
  }
  await writePresentation(presentations.join("\n\n---\n\n"), values);
}

async function analyzePresentBatchCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      stdout: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) { process.stdout.write(usage()); return; }
  if (positionals.length !== 1) throw new Error("analyze-present-batch requires one manifest JSON path");
  const manifestPath = path.resolve(positionals[0]);
  const manifest = await readJson(manifestPath);
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.items)
      || manifest.items.length === 0 || manifest.items.length > 100) {
    throw new Error("analyze-present-batch manifest requires 1-100 schemaVersion 1 items");
  }
  const base = await fs.realpath(path.dirname(manifestPath));
  const identities = new Set();
  const presentations = [];
  for (const item of manifest.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)
        || Object.keys(item).some((key) => !["dao", "proposalId", "profile", "explanation", "calibration"].includes(key))
        || typeof item.dao !== "string" || typeof item.proposalId !== "string"
        || typeof item.profile !== "string"
        || item.explanation !== undefined && typeof item.explanation !== "string"
        || item.calibration !== undefined && typeof item.calibration !== "string") {
      throw new Error("analyze-present-batch items require dao, proposalId and profile path");
    }
    const profileInput = await readBatchArtifact(base, item.profile);
    const explanationText = item.explanation === undefined ? "" : await readBatchArtifact(base, item.explanation, { json: false });
    const calibrationDocument = item.calibration === undefined ? null : await readBatchArtifact(base, item.calibration);
    const presentation = await analyzeCanonicalResponse({
      dao: item.dao, proposalId: item.proposalId, profileInput, explanationText, calibrationDocument,
    });
    const key = JSON.stringify(presentation.identity);
    if (identities.has(key)) throw new Error("analyze-present-batch contains a duplicate proposal identity");
    identities.add(key);
    presentations.push(presentation.markdown);
  }
  await writePresentation(presentations.join("\n\n---\n\n"), values);
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
  // Interactive approval is a real mode with a real adapter, but this build
  // registers no wallet transport, so nothing can submit through it. Refusing
  // by name here -- rather than accepting the flag and failing later with a
  // generic "no backend registered" -- is the difference between a setup
  // error and a surprise at the moment of casting a vote.
  if (mode === ExecutionMode.EOA_SUPERVISED) {
    const availability = interactiveExecutionAvailability();
    if (!availability.available) {
      const error = new Error(availability.reason);
      error.code = "EXECUTION_MODE_UNAVAILABLE";
      throw error;
    }
    return mode;
  }
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
      dao: { type: "string" },
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
  const dao = await resolveCommandDao(values);
  if (!values["model-address"]) throw new Error("execution-status requires --model-address or GAVEL_MODEL_ADDRESS");
  const mode = normalizeMode(values.mode);
  const executionAddress = configuredExecutionAddress(mode, values, values["model-address"]);
  if (!executionAddress) throw new Error(`No execution address configured for ${mode}`);
  const provider = createEthereumProvider({ rpcUrl: values.rpc });
  const adapter = createDaoAdapter(dao, provider);
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
      dao: { type: "string" },
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
  const dao = await resolveCommandDao(values);
  if (dao === "railgun-eth") {
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
  const adapter = createDaoAdapter(dao, provider);
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
      dao: { type: "string" },
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
  // `--dao` is a cross-check, never a selector. The DAO binding belongs to the
  // documents: it was fixed when the proposal was fetched and the prediction
  // was made, and nothing on this command line may retarget an already-bound
  // intent at a different governance system. Passing a DAO that disagrees is
  // refused rather than honoured.
  if (values.dao && String(values.dao).toLowerCase() !== String(prediction.dao || "").toLowerCase()) {
    throw new Error(
      `--dao ${values.dao} does not match the prediction's DAO (${prediction.dao}). ` +
        "A prepared intent stays bound to the DAO it was built for.",
    );
  }
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

async function resolveLocalProposalIdentity(reference, expectedScope) {
  const match = /^local:([A-Za-z0-9._-]+)$/.exec(String(reference || ""));
  if (!match) {
    throw new Error("This CLI currently resolves Safe proposal identities only from local:<label> encrypted keystores");
  }
  const label = match[1];
  const document = await readJson(defaultPrivatePath("identities", `${label}.json`));
  if (
    document.version !== 1 ||
    document.kind !== "GAVEL_PROPOSAL_IDENTITY" ||
    document.role !== "proposal" ||
    document.label !== label ||
    !Array.isArray(document.capabilities) ||
    !document.capabilities.includes("proposeSafeTransaction") ||
    !document.keystore ||
    !document.passphraseEnv
  ) {
    throw new Error(`The local identity ${reference} is not a valid Gavel Safe proposal identity`);
  }

  const safeAddress = getAddress(expectedScope.safeAddress);
  const chainId = Number(expectedScope.chainId);
  if (getAddress(document.scope?.safeAddress || "") !== safeAddress) {
    throw new Error(`The local identity ${reference} is scoped to a different Safe`);
  }
  if (Number(document.scope?.chainId) !== chainId) {
    throw new Error(`The local identity ${reference} is scoped to a different chain`);
  }

  const passphrase = process.env[document.passphraseEnv];
  if (!passphrase) throw new Error(`Set ${document.passphraseEnv} to unlock ${reference}`);
  const encryptedJson = JSON.stringify(document.keystore);
  const unlocked = await Wallet.fromEncryptedJson(encryptedJson, passphrase);
  if (getAddress(unlocked.address) !== getAddress(document.address)) {
    throw new Error(`The encrypted key for ${reference} does not match its stored address`);
  }

  const signer = new KeystoreSigningIdentity({
    keystore: document.keystore,
    address: document.address,
    passphrase: async () => {
      const current = process.env[document.passphraseEnv];
      if (!current) throw new Error(`Set ${document.passphraseEnv} to unlock ${reference}`);
      return current;
    },
    decrypt: (keystore, secret) => Wallet.fromEncryptedJson(JSON.stringify(keystore), secret),
  });
  return createProposalIdentity({ safeAddress, chainId, label, signer });
}

function createSafeProposalProvider(options) {
  return new SafeProposalProvider({
    safeAddress: options.safeAddress,
    chainId: options.chainId,
    proposalIdentity: options.proposalIdentity,
    provider: resolveEthereumRpcUrl({ rpcUrl: options.rpc }),
    txServiceUrl: options.transactionServiceUrl || process.env.GAVEL_SAFE_API_URL,
    apiKey: process.env.GAVEL_SAFE_API_KEY,
  });
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
 * Safe supervised mode is wired to the official Safe SDK provider. Other live
 * execution backends remain deliberately unavailable in this build.
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
  const executionAddress =
    values["execution-address"] ||
    values.from ||
    (mode === ExecutionMode.SAFE_SUPERVISED ? profile.safe.address : undefined);
  const { validated, blockers } = await adapter.prepareValidatedIntent({
    prediction,
    proposal: proposalInput.proposal || proposalInput,
    selectedSupport: values.support,
    votingAddress: executionAddress,
    executionAddress,
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

  if (mode !== ExecutionMode.SAFE_SUPERVISED) {
    throw new Error(
      `No execution backend is registered for ${mode} in this build (identities: ` +
        `${profileIdentityReferences(profile).map((entry) => `${entry.role}=${entry.reference}`).join(", ") || "none"}).`,
    );
  }

  const proposalIdentity = await resolveLocalProposalIdentity(profile.safe.proposalIdentity, {
    safeAddress: profile.safe.address,
    chainId: profile.safe.chainId,
  });
  const proposalProvider = createSafeProposalProvider({
    safeAddress: profile.safe.address,
    chainId: profile.safe.chainId,
    proposalIdentity,
    rpc: values.rpc,
    transactionServiceUrl: profile.safe.transactionServiceUrl,
  });
  const safeAdapter = new SafeSupervisedExecutionAdapter({
    safeAddress: profile.safe.address,
    chainId: profile.safe.chainId,
    proposalIdentity,
    proposalProvider,
  });
  const engine = new ExecutionEngine({
    adapters: [safeAdapter],
    store: new FileExecutionRecordStore(defaultPrivatePath("executions")),
  });
  const blockNumber = await provider.getBlockNumber();
  let result;
  try {
    result = await engine.submit(validated, { mode, blockNumber });
  } catch (error) {
    if (error?.submissionOutcome !== "unknown" || !error.executionRecord) throw error;
    const record = error.executionRecord;
    process.stdout.write(`${JSON.stringify({
      ok: false,
      mode,
      status: "submission-unknown",
      message: "Submission outcome unknown. Retry the same command to reconcile.",
      safe: profile.safe.address,
      safeTxHash: record.providerData.safeTxHash,
      nonce: record.providerData.safeNonce,
      executionRecord: record.id,
      deduplicated: false,
      nextStep: "Retry the same command to reconcile this hash. Do not create another Safe proposal.",
    }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  if (result.reason === "submission-outcome-unknown") {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      mode,
      status: "submission-unknown",
      safe: profile.safe.address,
      safeTxHash: result.record.providerData.safeTxHash,
      nonce: result.record.providerData.safeNonce,
      executionRecord: result.record.id,
      deduplicated: true,
      nextStep: "Retry later to reconcile this hash. Do not create another Safe proposal.",
    }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  let record = result.record;
  if (!result.deduplicated && record.state === "SUBMITTED") {
    record = await engine.status(record.id);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode,
    status: record.state.toLowerCase().replaceAll("_", "-"),
    safe: profile.safe.address,
    safeTxHash: record.providerData.safeTxHash,
    nonce: record.providerData.safeNonce,
    executionRecord: record.id,
    deduplicated: result.deduplicated,
    nextStep: "Review and sign in Safe. Human owners retain the execution threshold.",
  }, null, 2)}\n`);
}

async function safeDelegateCommand(action, argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      safe: { type: "string" },
      "chain-id": { type: "string", default: "1" },
      identity: { type: "string", default: "local:safe-proposer-main" },
      rpc: { type: "string" },
      "safe-api-url": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (positionals.length !== 0) throw new Error(`safe delegate ${action} accepts no positional arguments`);
  if (!values.safe) throw new Error(`safe delegate ${action} requires --safe`);
  const safeAddress = getAddress(values.safe);
  const chainId = Number(values["chain-id"]);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("--chain-id must be a positive integer");
  const proposalIdentity = await resolveLocalProposalIdentity(values.identity, { safeAddress, chainId });
  const provider = createSafeProposalProvider({
    safeAddress,
    chainId,
    proposalIdentity,
    rpc: values.rpc,
    transactionServiceUrl: values["safe-api-url"],
  });
  const authorization = await provider.authorization();

  if (action === "status") {
    process.stdout.write(`${authorization.status}\n`);
    return;
  }

  const guidance = {
    authorized: [
      "The proposal identity is already authorized as a Safe Transaction Service delegate.",
      "No Safe owner authorization action is needed.",
    ],
    "not-authorized": [
      `An existing owner must connect their wallet to official Safe API Kit and call addSafeDelegate({ safeAddress: "${safeAddress}", delegateAddress: "${authorization.proposer}", delegatorAddress: "<connected-owner-address>", label: "gavel", signer: <connected-owner-signer> }).`,
      "The signer and delegatorAddress must be the same current Safe owner; Gavel never receives that signer or owner credential.",
      `Authorize ${authorization.proposer} as a Transaction Service delegate, never as a Safe owner.`,
      "Run this setup command again to verify authorization before submitting an execution.",
    ],
    "owner-conflict": [
      `Remove ${authorization.proposer} from the Safe owner set before using supervised mode.`,
      "Create or select a separate proposal identity, authorize it only as a Transaction Service delegate, then verify again.",
    ],
    "service-unavailable": [
      "Check the RPC and Safe Transaction Service URL, then run this setup command again.",
      "Authorization was not verified; do not submit until status is authorized.",
    ],
  }[authorization.status];
  if (authorization.status === "authorized") {
    await writePrivateJson(defaultPrivatePath("safe", "delegates", `${chainId}-${safeAddress.toLowerCase()}.json`), {
      version: 1,
      safeAddress,
      chainId,
      proposalIdentity: values.identity,
      proposalIdentityAddress: authorization.proposer,
      status: authorization.status,
      verifiedAt: new Date().toISOString(),
    });
  }
  process.stdout.write(`${JSON.stringify({
    safe: safeAddress,
    chainId,
    proposalIdentity: values.identity,
    proposalIdentityAddress: authorization.proposer,
    status: authorization.status,
    completed: authorization.status === "authorized",
    guidance,
  }, null, 2)}\n`);
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
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("identity create --chain-id must be a positive safe integer");
  }
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
  const destination = defaultPrivatePath("identities", `${label}.json`);
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
  }, { secureDirectory: true });

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

async function gateCommand(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    process.stdout.write(usage());
    return;
  }
  const token = typeof process.env.GAVEL_GATE_SESSION === "string" ? process.env.GAVEL_GATE_SESSION.trim() : "";
  if (!token) throw new Error("authentication required: set GAVEL_GATE_SESSION");
  const baseUrl = process.env.GAVEL_GATE_URL || "http://127.0.0.1:8788";
  const client = createGateClient({ baseUrl, token });
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { json: { type: "boolean", default: false } },
  });

  function writeJson(document) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: "gavel.gate/1", ...document }, null, 2)}\n`);
  }

  try {
    if (subcommand === "profile") {
      const profile = await client.profile();
      if (values.json) {
        writeJson({ command: "profile", profile });
        return;
      }
      process.stdout.write(`${profile.wallet || ""}  ${profile.availability || ""}\n`);
      return;
    }
    if (subcommand === "inbox") {
      const action = positionals[0];
      if (action && !["show", "archive"].includes(action)) {
        throw new Error("gate inbox accepts the subcommands show and archive");
      }
      if (action === "show") {
        const item = await client.showInbox(positionals[1]);
        if (values.json) {
          writeJson({ command: "inbox.show", item });
          return;
        }
        process.stdout.write(`${sanitizeHumanText(item.id)}  ${item.archived ? "archived" : "unread"}\n`);
        process.stdout.write(`${sanitizeHumanText(item.pitch)}\n`);
        return;
      }
      if (action === "archive") {
        const result = await client.archiveInbox(positionals[1]);
        process.stdout.write(`${result.id} archived\n`);
        return;
      }
      const listed = await client.listInbox();
      if (values.json) {
        writeJson({ command: "inbox.list", items: listed.items });
        return;
      }
      if (listed.items.length === 0) {
        process.stdout.write("No Gate inbox items.\n");
        return;
      }
      for (const item of listed.items) {
        const proposal = item.canonicalFacts?.proposalId ? `#${item.canonicalFacts.proposalId}` : "";
        process.stdout.write(`${item.id}  ${proposal}  ${item.archived ? "archived" : "unread"}\n`);
      }
      return;
    }
    throw new Error("gate accepts the subcommands profile and inbox");
  } catch (error) {
    if (error instanceof GateClientError) throw new Error(error.message);
    throw error;
  }
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
  if (command === "present") return presentCommand(argv);
  if (command === "analyze-present") return analyzePresentCommand(argv);
  if (command === "present-batch") return presentBatchCommand(argv);
  if (command === "analyze-present-batch") return analyzePresentBatchCommand(argv);
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
  if (command === "safe") {
    const [namespace, subcommand, ...rest] = argv;
    if (namespace !== "delegate" || !["status", "setup"].includes(subcommand)) {
      throw new Error("safe accepts the subcommands delegate status and delegate setup");
    }
    return safeDelegateCommand(subcommand, rest);
  }
  if (command === "daos") return daosCommand(argv);
  if (command === "wallet") return walletCommand(argv);
  if (command === "readiness") return readinessCommand(argv);
  if (command === "secrets") return secretsCommand(argv);
  if (command === "config") return configCommand(argv);
  if (command === "gate") return gateCommand(argv);
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  const command = process.argv[2];
  const failure = classifyOperationalFailure(command, error);
  if (process.env.GAVEL_STRUCTURED_ERRORS === "1") process.stderr.write(`${JSON.stringify(failure)}\n`);
  else process.stderr.write(`gavel: [${failure.category}] ${failure.message}\n`);
  process.exitCode = 1;
});
