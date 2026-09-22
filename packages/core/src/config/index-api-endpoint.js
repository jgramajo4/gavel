const DEFAULT_INDEX_API_URL = "https://index.0773h.com";
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

const IndexApiEndpointStatus = Object.freeze({
  CONFIGURED: "configured",
  DISABLED: "disabled",
});

class IndexApiEndpointError extends Error {
  constructor(code, message, metadata) {
    super(message);
    this.name = "IndexApiEndpointError";
    this.code = code;
    this.metadata = Object.freeze({ ...metadata });
  }
}

function assertHttpUrl(value, label, metadata) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new IndexApiEndpointError(
      "INDEX_API_URL_INVALID",
      `${label} must contain an HTTP(S) URL.`,
      metadata,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new IndexApiEndpointError(
      "INDEX_API_URL_INVALID",
      `${label} must contain an HTTP(S) URL.`,
      metadata,
    );
  }
}

function endpoint(url, metadata) {
  const resolved = { metadata: Object.freeze({ ...metadata }) };
  Object.defineProperty(resolved, "url", {
    value: url,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(resolved);
}

/** Resolve the operational index endpoint while keeping its value non-serializable. */
function resolveIndexApiEndpoint(config = {}, env = process.env) {
  const runtime = config.runtime || config;
  if (runtime.indexApiUrl !== null && runtime.indexApiUrl !== undefined) {
    const value = String(runtime.indexApiUrl).trim();
    const metadata = {
      source: "config",
      variable: null,
      status: value === "" ? IndexApiEndpointStatus.DISABLED : IndexApiEndpointStatus.CONFIGURED,
    };
    if (value !== "") assertHttpUrl(value, "runtime.indexApiUrl", metadata);
    if (value !== "") {
      const parsed = new URL(value);
      if (parsed.username || parsed.password || parsed.search) {
        throw new IndexApiEndpointError(
          "INDEX_URL_CARRIES_CREDENTIALS",
          "runtime.indexApiUrl must not carry userinfo or query parameters. Name an environment variable instead.",
          metadata,
        );
      }
    }
    return endpoint(value, metadata);
  }

  const variable = runtime.indexApiUrlVariable;
  if (variable) {
    if (!ENVIRONMENT_VARIABLE_PATTERN.test(variable)) {
      throw new IndexApiEndpointError(
        "INDEX_API_URL_VARIABLE_INVALID",
        "runtime.indexApiUrlVariable must be an uppercase environment variable name.",
        { source: "environment", variable: null, status: "invalid" },
      );
    }
    const value = String(env[variable] ?? "").trim();
    if (value === "") {
      const metadata = { source: "environment", variable, status: "missing" };
      throw new IndexApiEndpointError(
        "INDEX_API_URL_VARIABLE_MISSING",
        `runtime.indexApiUrlVariable names ${variable}, but that variable is missing or empty. Set it to an HTTP(S) URL or remove the reference.`,
        metadata,
      );
    }
    const metadata = { source: "environment", variable, status: IndexApiEndpointStatus.CONFIGURED };
    assertHttpUrl(value, variable, metadata);
    return endpoint(value, metadata);
  }

  if (env.GAVEL_INDEX_API_URL !== undefined) {
    const value = String(env.GAVEL_INDEX_API_URL).trim();
    const metadata = {
      source: "environment",
      variable: "GAVEL_INDEX_API_URL",
      status: value === "" ? IndexApiEndpointStatus.DISABLED : IndexApiEndpointStatus.CONFIGURED,
    };
    if (value !== "") assertHttpUrl(value, "GAVEL_INDEX_API_URL", metadata);
    return endpoint(value, metadata);
  }

  return endpoint(DEFAULT_INDEX_API_URL, {
    source: "default",
    variable: null,
    status: IndexApiEndpointStatus.CONFIGURED,
  });
}

module.exports = {
  DEFAULT_INDEX_API_URL,
  IndexApiEndpointError,
  IndexApiEndpointStatus,
  resolveIndexApiEndpoint,
};
