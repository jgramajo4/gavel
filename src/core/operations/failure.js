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

function classifyOperationalFailure(command, error) {
  const message = safeOperationMessage(error);
  const lowered = message.toLowerCase();
  let category = "SOFTWARE_DEFECT";
  let retryable = false;
  if (/timeout|http 5\d\d|rpc|network|fetch|socket|econn|rate limit|canonical version could not be verified/.test(lowered)) {
    category = "RETRYABLE_INFRASTRUCTURE";
    retryable = true;
  } else if (/stale|mismatch|already present|earlier than|older than/.test(lowered)) {
    category = "STALE_DATA";
  } else if (/blocked|unsafe|critical|simulation failed|no voting power|already voted/.test(lowered)) {
    category = "SAFETY_BLOCK";
  } else if (/requires|must be|exactly one|invalid|unknown|not found/.test(lowered)) {
    category = "USER_CORRECTION_REQUIRED";
  } else if (/unsupported|not implemented/.test(lowered)) {
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
