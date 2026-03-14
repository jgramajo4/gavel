const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const NOUNS_TOKEN_ADDRESS = "0x9C8fF314C9Bc7F6e59A9d9225Fb22946427eDC03";

function loadAbi() {
  const abiPath = path.resolve(__dirname, "..", "references", "nouns-token-abi.json");
  return JSON.parse(fs.readFileSync(abiPath, "utf8"));
}

function decodeTokenUri(tokenUri) {
  if (!tokenUri) {
    throw new Error("tokenURI is empty");
  }

  const dataPrefix = "data:application/json;base64,";
  if (tokenUri.startsWith(dataPrefix)) {
    const base64 = tokenUri.slice(dataPrefix.length);
    const json = Buffer.from(base64, "base64").toString("utf8");
    return JSON.parse(json);
  }

  if (tokenUri.startsWith("data:application/json,")) {
    const json = decodeURIComponent(tokenUri.split(",")[1]);
    return JSON.parse(json);
  }

  return { tokenUri };
}

async function main() {
  const rpcUrl = process.env.ETHEREUM_RPC_URL;
  const nounId = process.env.NOUN_ID;

  if (!rpcUrl) {
    throw new Error("Missing ETHEREUM_RPC_URL env var");
  }
  if (!nounId) {
    throw new Error("Missing NOUN_ID env var");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const abi = loadAbi();
  const contract = new ethers.Contract(NOUNS_TOKEN_ADDRESS, abi, provider);

  const tokenUri = await contract.tokenURI(nounId);
  const metadata = decodeTokenUri(tokenUri);

  const output = {
    nounId: String(nounId),
    tokenUri,
    metadata,
  };

  process.stdout.write(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
