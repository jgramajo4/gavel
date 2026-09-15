# Gavel Gate Splitter (experimental)

Minimal immutable splitter for Base native USDC settlement. This contract is experimental and unaudited. Do not enable checkout until the deployment and real-native-USDC acceptance gates in `docs/GAVEL_GATE_TECHNICAL_SPEC.md` are complete.

## Properties

- Immutable Base native-USDC address, Gavel recipient, and quote signer.
- EIP-712 quote domain: `GavelGateSplitter`, version `1`, deployment chain ID, exact splitter address.
- Pulls only through EIP-3009 `receiveWithAuthorization`; `transferWithAuthorization` is forbidden.
- Routes the full attention amount to the quoted voter and exactly `250000` USDC atomic units to Gavel.
- No owner, roles, setters, pause, upgrade, fallback, receive, refund, rescue, withdrawal, or sweep path.
- Directly transferred token dust is ignored by settlement accounting and permanently stranded.

The test token is test-only. Its signatures demonstrate the expected `USD Coin` / version `2` EIP-3009 domain and distinct authorization type hashes, but do not prove compatibility with production native USDC.

## Verify

From this directory, with Foundry on `PATH`:

```sh
forge test -vvv
forge test --match-contract GavelGateSplitterInvariantTest -vvv
forge fmt --check
forge build --sizes
```

From the repository root:

```sh
npm test
git diff --check
git status --short
```

If Slither is already installed:

```sh
slither src/GavelGateSplitter.sol
```

No Slither config is committed because no deterministic override is needed.

## Deploy to Base

The deployment script hard-codes canonical Base native USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) and requires chain ID `8453`. It validates runtime code, `name()`, `version()`, and `DOMAIN_SEPARATOR()` before broadcasting. Supply public configuration explicitly; supply the broadcaster through Foundry's normal wallet options rather than source or environment files committed to Git.

```sh
export GAVEL_RECIPIENT=0x...
export QUOTE_SIGNER=0x...
forge script script/DeployGavelGateSplitter.s.sol:DeployGavelGateSplitter \
  --rpc-url "$BASE_RPC_URL" --broadcast --verify
```

Signer rotation requires a new deployment and draining the old deployment; there is no mutable signer or migration path in the contract.
