/**
 * Secrets, as status rather than value.
 *
 * Gavel needs credentials -- an RPC key, an inference key, a WalletConnect
 * project id, a Safe proposer passphrase, a WaaP key. None of them belong in
 * Gavel's configuration file, in GAVEL_DATA_DIR, in a status line, in JSON
 * output, in a log or in an error.
 *
 * So configuration never holds a secret. It holds a *reference*: which source
 * supplies it and, for the environment source, which variable name. Resolving
 * one answers exactly one question -- is it configured? -- and the value never
 * leaves the resolver.
 *
 * `redactSecrets()` is the backstop. Reference discipline is the design;
 * redaction is what catches the mistake, and it is applied at every boundary
 * that renders, serializes, logs or diagnoses.
 */

/** Where a secret may come from. Ordered most to least preferred. */
const SecretSource = Object.freeze({
  /** A secret manager or OS keychain the host provides. Reference only. */
  RUNTIME: "runtime",
  /** An encrypted keystore file on disk, unlocked by a passphrase reference. */
  KEYSTORE: "keystore",
  /** An environment variable, named but never read into config. */
  ENVIRONMENT: "environment",
  /** Deliberately absent. A supported, fully functional state. */
  NONE: "none",
});

const SecretStatus = Object.freeze({
  CONFIGURED: "configured",
  MISSING: "missing",
  NOT_REQUIRED: "not-required",
});

/**
 * Every secret Gavel knows how to want.
 *
 * `requiredFor` is the capability that needs it, so a status view can say
 * "missing, and here is what that stops you doing" instead of a bare warning.
 */
const SECRET_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: "ethereum-rpc",
    label: "Ethereum RPC endpoint",
    variable: "ETHEREUM_RPC_URL",
    requiredFor: "Chain reads with a private or authenticated RPC",
    optional: true,
  }),
  Object.freeze({
    id: "index-api",
    label: "Governance index endpoint",
    variable: "GAVEL_INDEX_API_URL",
    requiredFor: "Reading a private or self-hosted governance index",
    optional: true,
  }),
  Object.freeze({
    id: "inference-remote",
    label: "Remote inference endpoint",
    variable: "PREDICTION_URL",
    requiredFor: "Remote-provider inference",
    optional: true,
  }),
  Object.freeze({
    id: "walletconnect-project",
    label: "WalletConnect project id",
    variable: "WALLETCONNECT_PROJECT_ID",
    requiredFor: "Connecting a wallet over WalletConnect",
    optional: true,
  }),
  Object.freeze({
    id: "safe-proposer-passphrase",
    label: "Safe proposer keystore passphrase",
    variable: "GAVEL_SAFE_PASSPHRASE",
    requiredFor: "Unlocking the encrypted Safe proposal identity",
    optional: true,
  }),
  Object.freeze({
    id: "execution-signer",
    label: "Autonomous execution signer",
    variable: "GAVEL_PRIVATE_KEY",
    requiredFor: "Autonomous (WaaP) execution",
    optional: true,
  }),
  Object.freeze({
    id: "gate-token",
    label: "Gate API token",
    variable: "GAVEL_GATE_TOKEN",
    requiredFor: "Authenticated Gate profile and inbox reads",
    optional: true,
  }),
]);

const DESCRIPTORS_BY_ID = new Map(SECRET_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]));

/**
 * Key names whose values are never safe to render. Matched case-insensitively
 * against object keys, and against `VAR=value` shapes inside strings.
 */
const SECRET_KEY_PATTERN =
  /(private[_-]?key|secret|passphrase|password|mnemonic|seed[_-]?phrase|credential|api[_-]?key|access[_-]?token|auth[_-]?token|bearer|session[_-]?key|symkey|sym[_-]?key|signing[_-]?key|token)/i;

/**
 * Key names that hold a secret's *description* rather than its value.
 *
 * These are not skipped -- redaction still recurses into them -- they are only
 * exempt from being blanked wholesale, so `{ secrets: [{ variable, status }] }`
 * survives as the status table it is while any nested `apiKey` inside it is
 * still replaced.
 */
const SECRET_REFERENCE_KEY_PATTERN =
  /^(variable|source|status|secretSource|secretVariable|secrets|secretAudit|secretStatus)$/;

const REDACTED = "[redacted]";
/** URL-safe stand-in, swapped for REDACTED after serialization. */
const REDACTED_TOKEN = "gavelredactedvalue";

/**
 * Value shapes that are secrets wherever they appear: a 32-byte hex key, a
 * BIP-39-length word list. Caught by shape so a secret slipped into a field
 * with an innocent name is still not printed.
 */
const RAW_PRIVATE_KEY_PATTERN = /\b0x?[0-9a-fA-F]{64}\b/;
const MNEMONIC_PATTERN = /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/i;

/** Any http(s) URL, wherever it appears -- in a field, a message, a log line. */
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;

/**
 * Strip credentials out of a URL without trying to guess which parameter
 * names are sensitive.
 *
 * A URL can carry a secret in two places: userinfo (`https://user:pw@host`)
 * and the query string. Maintaining an allowlist of "safe" parameter names is
 * not security -- `?banana=<token>` defeats it -- so *every* query value is
 * replaced and only the parameter names survive. Origin and path are kept,
 * because those are what make the redacted line useful.
 */
function redactUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return text;
  }
  let changed = false;
  if (url.username || url.password) {
    url.username = REDACTED_TOKEN;
    url.password = "";
    changed = true;
  }
  for (const key of [...url.searchParams.keys()]) {
    url.searchParams.set(key, REDACTED_TOKEN);
    changed = true;
  }
  if (!changed) return text;
  return url.toString().replace(new RegExp(REDACTED_TOKEN, "g"), REDACTED);
}

function redactUrlsIn(text) {
  return text.replace(URL_PATTERN, (match) => redactUrl(match));
}

/** Does this URL carry anything that could be a credential? */
function urlCarriesCredentials(value) {
  try {
    const url = new URL(String(value));
    return Boolean(url.username || url.password || [...url.searchParams.keys()].length > 0);
  } catch {
    return false;
  }
}

function looksLikeSecretValue(value) {
  if (typeof value !== "string") return false;
  return RAW_PRIVATE_KEY_PATTERN.test(value) || MNEMONIC_PATTERN.test(value);
}

/**
 * Replace anything secret-shaped in an arbitrary value with `[redacted]`.
 *
 * Applied to config before it is written, to status before it is printed, to
 * diagnostics before they are bundled and to error messages before they are
 * raised. Cycles are tolerated because a diagnostic bundle is exactly where a
 * cyclic object shows up.
 */
function redactSecrets(value, seen = new WeakSet()) {
  if (typeof value === "string") {
    if (looksLikeSecretValue(value)) return REDACTED;
    return redactUrlsIn(value);
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, seen));
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key) && !SECRET_REFERENCE_KEY_PATTERN.test(key)) {
      output[key] = entry === undefined || entry === null ? entry : REDACTED;
      continue;
    }
    output[key] = redactSecrets(entry, seen);
  }
  return output;
}

/** Redact a message before it is logged or thrown. */
function redactMessage(message) {
  return redactUrlsIn(String(message ?? ""))
    .replace(new RegExp(RAW_PRIVATE_KEY_PATTERN.source, "g"), REDACTED)
    .replace(new RegExp(MNEMONIC_PATTERN.source, "gi"), REDACTED)
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSPHRASE|PASSWORD))\s*=\s*\S+/g,
      (_match, name) => `${name}=${REDACTED}`,
    );
}

/**
 * Does this look like a raw secret someone put in configuration?
 *
 * Used by migration to detect a legacy plaintext field. It answers yes/no and
 * never returns, echoes or logs what it inspected.
 */
function isPlaintextSecret(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (text === "") return false;
  return RAW_PRIVATE_KEY_PATTERN.test(text) || MNEMONIC_PATTERN.test(text);
}

function listSecretDescriptors() {
  return SECRET_DESCRIPTORS;
}

function getSecretDescriptor(id) {
  const descriptor = DESCRIPTORS_BY_ID.get(String(id || ""));
  if (!descriptor) throw new Error(`Unknown secret: ${id}`);
  return descriptor;
}

/**
 * Resolve one secret to a status row.
 *
 * The returned row is the *only* thing any caller gets. There is no accessor
 * on it that yields the value: reading the value is the job of the component
 * that uses it, at the moment it uses it, directly from the source.
 */
function resolveSecretStatus(id, options = {}) {
  const descriptor = getSecretDescriptor(id);
  const env = options.env || process.env;
  const variable = options.variable || descriptor.variable;
  const required = options.required === true || descriptor.optional !== true;
  const present = typeof env[variable] === "string" && env[variable].trim() !== "";
  return Object.freeze({
    id: descriptor.id,
    label: descriptor.label,
    source: present ? SecretSource.ENVIRONMENT : SecretSource.NONE,
    variable,
    status: present
      ? SecretStatus.CONFIGURED
      : required
        ? SecretStatus.MISSING
        : SecretStatus.NOT_REQUIRED,
    requiredFor: descriptor.requiredFor,
    required,
  });
}

/**
 * The whole secret audit, as rows. What `gavel secrets status` prints and what
 * the wizard's review step shows. Never contains a value.
 */
function resolveSecretAudit(options = {}) {
  const required = new Set(options.required || []);
  return SECRET_DESCRIPTORS.map((descriptor) =>
    resolveSecretStatus(descriptor.id, {
      env: options.env,
      required: required.has(descriptor.id),
    }),
  );
}

/** One line per secret, for a terminal. `NAME  source  status`. */
function formatSecretStatus(row) {
  return `${row.variable}  source: ${row.source}  status: ${row.status}`;
}

module.exports = {
  REDACTED,
  SECRET_DESCRIPTORS,
  SecretSource,
  SecretStatus,
  formatSecretStatus,
  getSecretDescriptor,
  isPlaintextSecret,
  listSecretDescriptors,
  looksLikeSecretValue,
  redactMessage,
  redactSecrets,
  redactUrl,
  urlCarriesCredentials,
  resolveSecretAudit,
  resolveSecretStatus,
};
