// Raised by the governance index client; matched here without importing it.
const INDEX_STALE_CODE = "GAVEL_INDEX_STALE";
const INDEX_RATE_LIMITED_CODE = "GAVEL_INDEX_RATE_LIMITED";

const STAGES = Object.freeze({
  history: "HISTORY_INGESTION",
  onboard: "PROFILE_CONSTRUCTION",
  profile: "PROFILE_CONSTRUCTION",
  proposal: "PROPOSAL_RETRIEVAL",
  predict: "PREDICTION",
  backtest: "PREDICTION",
  inspect: "PROPOSAL_SECURITY",
  "prepare-vote": "VOTE_PREPARATION",
});

function safeOperationMessage(error) {
  return String(error?.shortMessage || error?.reason || error?.message || error || "unknown failure")
    .replace(/([?&](?:key|token|secret|api_key)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/0x[0-9a-f]{64,}/gi, "[REDACTED_HEX]")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

/** Codes raised by `resolveDaoContext()`. */
const DAO_RESOLUTION_CODES = new Set(["UNKNOWN_DAO", "AMBIGUOUS_DAO", "NO_DAO_CONFIGURED"]);
const INDEX_CONFIG_CODES = new Set([
  "INDEX_API_URL_INVALID",
  "INDEX_API_URL_VARIABLE_INVALID",
  "INDEX_API_URL_VARIABLE_MISSING",
  "INDEX_URL_CARRIES_CREDENTIALS",
]);

function classifyOperationalFailure(command, error) {
  const message = safeOperationMessage(error);
  const lowered = message.toLowerCase();
  let category = "SOFTWARE_DEFECT";
  let retryable = false;
  // A governance index that is stalled, failing, or missing a checkpoint is an
  // operational data problem for the caller, not a defect in Gavel. Match the
  // error code so the wording of each refusal stays free to change.
  // A DAO that could not be resolved -- ambiguous, unknown, or none followed
  // -- is always the caller's to fix, and each carries an actionable message.
  // Matched by code so the wording stays free to change.
  if (DAO_RESOLUTION_CODES.has(error?.code) || INDEX_CONFIG_CODES.has(error?.code)) {
    category = "USER_CORRECTION_REQUIRED";
  } else if (error?.code === INDEX_STALE_CODE) {
    category = "STALE_DATA";
  } else if (error?.code === INDEX_RATE_LIMITED_CODE || /timeout|http 5\d\d|rpc|network|fetch|socket|econn|rate[- ]limit|canonical version could not be verified/.test(lowered)) {
    category = "RETRYABLE_INFRASTRUCTURE";
    retryable = true;
  } else if (/stale|mismatch|already present|earlier than|older than/.test(lowered)) {
    category = "STALE_DATA";
  } else if (/blocked|unsafe|critical|simulation failed|no voting power|already voted/.test(lowered)) {
    category = "SAFETY_BLOCK";
  } else if (/requires|must be|exactly one|invalid|unknown|not found/.test(lowered)) {
    category = "USER_CORRECTION_REQUIRED";
  } else if (error?.code === "EXECUTION_MODE_UNAVAILABLE" || /unsupported|not implemented|not available in this build/.test(lowered)) {
    category = "UNSUPPORTED_INPUT";
  }
  return {
    schemaVersion: "1.0.0",
    event: "GAVEL_OPERATION_FAILED",
    stage: STAGES[command] || "UNKNOWN",
    category,
    retryable,
    message,
  };
}

module.exports = { STAGES, classifyOperationalFailure, safeOperationMessage };
