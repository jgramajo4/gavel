const path = require("node:path");

function resolveDataDir(options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const configured = typeof env.GAVEL_DATA_DIR === "string" ? env.GAVEL_DATA_DIR.trim() : "";
  return path.resolve(cwd, configured || path.join("data", "private"));
}

function privatePath(dataDir, ...segments) {
  const root = path.resolve(dataDir);
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Private-state path escapes GAVEL_DATA_DIR");
  }
  return resolved;
}

module.exports = { resolveDataDir, privatePath };
