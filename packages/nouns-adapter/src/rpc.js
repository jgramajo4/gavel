const { JsonRpcProvider } = require("ethers");

const DEFAULT_ETHEREUM_RPC_URL = "https://eth.drpc.org";

function resolveEthereumRpcUrl(options = {}) {
  const env = options.env || process.env;
  return options.rpcUrl || env.ETHEREUM_RPC_URL || DEFAULT_ETHEREUM_RPC_URL;
}

function createEthereumProvider(options = {}) {
  const rpcUrl = resolveEthereumRpcUrl(options);
  return new JsonRpcProvider(rpcUrl, 1, {
    staticNetwork: false,
    // dRPC's keyless tier accepts only small batches. Sequential requests also
    // make fail-closed validation errors attributable to one canonical read.
    batchMaxCount: 1,
  });
}

module.exports = {
  DEFAULT_ETHEREUM_RPC_URL,
  createEthereumProvider,
  resolveEthereumRpcUrl,
};
