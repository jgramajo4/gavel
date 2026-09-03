const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_ETHEREUM_RPC_URL,
  resolveEthereumRpcUrl,
} = require("../packages/nouns-adapter");
const {
  DEFAULT_ETHEREUM_RPC_URL: LEGACY_DEFAULT_RPC,
  getRpcUrl: resolveLegacyRpcUrl,
} = require("../nouns-dao/scripts/_utils");

test("uses a public Ethereum RPC by default with explicit override precedence", () => {
  assert.equal(DEFAULT_ETHEREUM_RPC_URL, "https://eth.drpc.org");
  assert.equal(resolveEthereumRpcUrl({ env: {} }), DEFAULT_ETHEREUM_RPC_URL);
  assert.equal(
    resolveEthereumRpcUrl({ env: { ETHEREUM_RPC_URL: "https://provider.example" } }),
    "https://provider.example",
  );
  assert.equal(
    resolveEthereumRpcUrl({
      rpcUrl: "https://command-line.example",
      env: { ETHEREUM_RPC_URL: "https://provider.example" },
    }),
    "https://command-line.example",
  );
});

test("legacy Bankr scripts share the canonical public RPC default", () => {
  assert.equal(LEGACY_DEFAULT_RPC, DEFAULT_ETHEREUM_RPC_URL);
  assert.equal(resolveLegacyRpcUrl({}), DEFAULT_ETHEREUM_RPC_URL);
  assert.equal(
    resolveLegacyRpcUrl({ ETHEREUM_RPC_URL: "https://bankr-override.example" }),
    "https://bankr-override.example",
  );
});
