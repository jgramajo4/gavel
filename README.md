# Gavel

Gavel is a private, history-first governance copilot. It learns how a voter has
actually governed, finds relevant precedents in their own record, recommends
`FOR`, `AGAINST`, or `ABSTAIN` on new proposals, explains the recommendation,
and can prepare a vote transaction for review.

Gavel is one monorepo and one canonical governance engine. Nouns, ENS, and
Railgun Ethereum are DAO adapters; Bankr and Hermes are thin runtime integrations. Any compatible
agent or shell can use the same machine-readable `gavel` CLI.

```text
DAO API / Ethereum chain
       |
       v
 packages/*-adapter ---------> normalized private history
                              |
                              v
 observed behavior + stated preferences + hard rules
                              |
                              v
 precedents -> prediction -> confidence -> proposal security -> draft reason
                              |
                              v
                validated governance transaction
                              |
                              v
                 unsigned / Safe / scoped WaaP
```


## Status

The canonical packages are `packages/core`, `packages/nouns-adapter`,
`packages/ens-adapter`, `packages/railgun-adapter`, and `packages/cli`. The root
`bin/gavel.js` and `nouns-dao/` Bankr skill remain as
verified compatibility entry points. `packages/server` remains a reserved boundary. `packages/tui` now contains the
first read-only migration slice from the former standalone TUI.

See [`docs/architecture/MONOREPO_AUDIT_AND_PLAN.md`](docs/architecture/MONOREPO_AUDIT_AND_PLAN.md)
for the pre-change audit and staged migration map.

## Public website

The static Gavel landing page lives in [`website/`](website/). See its
[preview, design, validation, and deployment notes](website/README.md).

## Requirements

- Node.js 20 or newer
- Network access to Ethereum JSON-RPC; Nouns history also uses its governance subgraph

```bash
npm install
npm test
```

## Self-hosted governance index

Running an index is optional. Clients read the public index at `https://index.0773h.com` unless `GAVEL_INDEX_API_URL` overrides it, so this section is for operators who want their own.

`packages/governance-index` provides the PostgreSQL backfill/sync worker and read-only API. See its [deployment and operations guide](packages/governance-index/README.md). A local indexed deployment can serve every DAO to the regular CLI:

```bash
cp .env.example .env
set -a; . ./.env; set +a
npm run indexer -- migrate
npm run indexer -- backfill --dao nouns
npm run indexer -- sync --all
```

In another shell, export the same file before starting the API or using the regular CLI:

```bash
set -a; . ./.env; set +a
npm run indexer -- serve
GAVEL_INDEX_API_URL=http://localhost:8080 gavel history 0x0000000000000000000000000000000000000001 --dao ens
```

Docker Compose loads `.env` automatically, publishes only the API, and keeps PostgreSQL private. Railgun indexing starts at the verified Voting creation block `15505853`; `RAILGUN_FROM_BLOCK` is an optional override. Tally and delegation ingestion are not implemented.

## Choose how to run Gavel

The runtime changes how people interact with Gavel, but not how governance is
analyzed or validated. All supported runtimes should call the canonical CLI and
keep private state in a runtime-owned `GAVEL_DATA_DIR`.

| Method | Best for | Current status | Transaction boundary |
| --- | --- | --- | --- |
| [Bankr](#bankr) | A conversational governance copilot | Supported through the `nouns-dao` compatibility skill | Unsigned preparation by default; legacy signing scripts are separate |
| [Hermes Agent](#hermes-agent) | A self-hosted conversational agent | Supported through a first-use bootstrapping skill | Unsigned, Safe-supervised, or explicitly scoped WaaP integration |
| [BYOH](#byoh-bring-your-own-harness) | Any agent framework, shell, scheduler, or local application | Supported through the JSON CLI | Unsigned, Safe-supervised, or explicitly scoped WaaP integration |
| [TUI](#terminal-ui-tui) | Interactive proposal browsing in a real terminal | Phase 1 source is imported into `packages/tui` | Read-only while canonical wallet handoff is implemented |
| [Headless / Railway](#headless-on-railway) | Scheduled ingestion, analysis, and JSON-producing jobs | CLI jobs are supported; an HTTP service is not yet shipped | Use unsigned output or an external supported executor |

Whichever method you choose, start with read-only history, profile, proposal,
prediction, and inspection commands. Preparing a transaction does not authorize
its submission.

### Supported DAOs

| DAO | CLI ID | Support |
| --- | --- | --- |
| Nouns DAO | `nouns` | History, proposal reads, prediction, vote preparation, delegation |
| ENS DAO | `ens` | Indexed Governor history and RPC-verified proposals, prediction, vote preparation, delegation |
| Railgun Governance (Ethereum) | `railgun-eth` | Live proposal reads, indexed history, binary vote preparation with staking snapshot hints |

ENS Governor and Snapshot records remain separate; Gavel prepares executable ENS
Governor votes only. Railgun supports FOR/Yay and AGAINST/Nay, has no abstain or
reason field, and treats sponsorship as distinct from voting. Polygon and BSC
Railgun governance are not included in `railgun-eth`.

### Shared configuration

Inject configuration through the host's secret or environment-variable system;
do not commit a populated `.env` file.

| Variable | Required when | Meaning |
| --- | --- | --- |
| `GAVEL_DATA_DIR` | Recommended for every persistent runtime | Private histories, profiles, policies, proposals, predictions, and prepared transactions |
| `NOUNS_SUBGRAPH_URL` | Optional | Override the default Nouns governance subgraph |
| `GAVEL_INDEX_API_URL` | Optional override | Private or self-hosted governance index; defaults to the public `https://index.0773h.com`, and when set applies to Nouns too. No credentials in this URL |
| `GAVEL_INDEX_MAX_STALENESS_SECONDS` | Optional | Reject an indexed read once its newest checkpoint is older than this; defaults to `3600` |
| `ETHEREUM_RPC_URL` | Optional advanced override | Ethereum mainnet JSON-RPC endpoint; defaults to `https://eth.drpc.org` |
| `GAVEL_MODEL_ADDRESS` | Optional default for execution checks | Address associated with the model or agent identity; it need not own voting assets |
| `GAVEL_ASSET_OWNER_ADDRESS` | Delegated voting | Address that owns the Noun or voting power |
| `GAVEL_SAFE_ADDRESS` | Safe-supervised execution | Safe that must receive delegated voting power and propose the validated vote |
| `GAVEL_WAAP_ADDRESS` | WaaP-autonomous execution | Policy-controlled execution address that must receive delegated voting power |

`AGENT_PRIVATE_KEY` is only for the explicitly legacy scripts under
`nouns-dao/scripts/`. The canonical CLI, core, and executor boundaries do not
read it.

### Bankr

Bankr supplies the conversation and tool runtime; Gavel remains the governance
engine. Install or expose [`nouns-dao/`](nouns-dao/) as the Gavel skill. Bankr
`execute_cli` containers are ephemeral, so each workflow clones the repository
inside its current sandbox rather than relying on `/cli/gavel` to survive:

```text
Install or update the Gavel skill from:
https://github.com/jgramajo4/gavel/tree/main/nouns-dao
```

Paste the same instruction into Bankr to update an existing installation; Bankr
replaces the skill with the same name. Start a new conversation afterward.
Updating the skill does not overwrite Gavel Private Files.

```bash
git clone --branch main --single-branch https://github.com/jgramajo4/gavel.git gavel
cd gavel
npm ci
npm test
```

Gavel needs no Bankr-provided RPC for the basic workflow. It defaults to the
public `https://eth.drpc.org` endpoint. Advanced users can set
`ETHEREUM_RPC_URL` in Bankr's secure environment settings for higher limits,
different privacy requirements, or a dedicated provider.

No private key is required for the canonical Gavel workflow.

People can then use natural-language requests such as:

- “Onboard me with voter address `0x…`.”
- “Sync my Nouns voting history and explain what you learned.”
- “Analyze this normalized ENS Governor proposal using my ENS profile.”
- “Fetch Railgun proposal 27 and prepare my remaining Yay voting power.”
- “Analyze proposal 123 using my profile.”
- “Prepare a FOR vote for review; do not submit it.”
- “Check whether my Safe is ready to vote.”

The skill routes those requests to the canonical command form:

```bash
cd gavel && node bin/gavel.js <command>
```

For returning voters, the Bankr skill stages private inputs from
`/gavel/data/private/` with `filesFromUserFs`. It writes results to a fresh
sandbox directory and explicitly exports each file back with `publishArtifacts`.
An ordinary sandbox write is not durable. The skill requires both zero command
exits and successful artifact metadata, then verifies restoration from a new
task. Bankr Agent Profiles and project updates are public and must not store
private Gavel profiles. See the complete
[`Bankr runtime guide`](nouns-dao/references/bankr-runtime.md) and
[`private profile storage policy`](docs/storage/PROFILE_STORAGE.md).

### Hermes Agent

Hermes users install one skill and then start a Gavel conversation:

```bash
hermes skills install https://raw.githubusercontent.com/jgramajo4/gavel/main/integrations/hermes/SKILL.md --yes
```

Existing installations can check and apply Gavel skill updates with:

```bash
hermes skills check
hermes skills update
```

Start a new Hermes session or use `/reset` after updating. The refreshed skill
installs its new immutable Gavel runtime without overwriting private voter data.

```text
/gavel-governance Initialize my persistent Gavel profile for Nouns voter 0x...
```

On first use, the skill's bundled runner verifies Git, npm, and Node.js 20+,
installs an exact pinned Gavel commit with its locked dependencies beneath
`HERMES_HOME`, creates a separate private data directory, and runs the requested
command. Later requests reuse that runtime and data. Users do not clone this
repository, run `npm ci`, set `GAVEL_DATA_DIR`, or globally link `gavel` for a
normal installation.

ENS and Railgun workflows need no index configuration: they read the public
index by default. An operator running their own index exports
`GAVEL_INDEX_API_URL` in the environment that launches Hermes, and the runner
passes it through to the pinned runtime.

Container operators still need to persist `HERMES_HOME` or `GAVEL_DATA_DIR` on
a private volume. Bankr Files, Hermes storage, and Railway volumes are currently
independent; profile migration requires an explicit private file transfer until
Gavel ships a portable export/import workflow. See
[`integrations/hermes/references/runtime.md`](integrations/hermes/references/runtime.md).

### BYOH: bring your own harness

BYOH means any agent framework or program can orchestrate Gavel without importing
Bankr-specific code. Install Node.js 20+, clone the repository, run `npm ci`, and
invoke `gavel` as a subprocess. Successful commands emit JSON summaries; add
`--stdout` when the caller needs the complete artifact on standard output and set
`GAVEL_STRUCTURED_ERRORS=1` when it needs machine-readable errors.

A complete explicit-file workflow looks like this in a POSIX shell:

```bash
export GAVEL_DATA_DIR="$PWD/private/alice"
export VOTER="0xYourVoterAddress"

npm run gavel -- history "$VOTER" --output "$GAVEL_DATA_DIR/history.json"
npm run gavel -- profile "$GAVEL_DATA_DIR/history.json" --output "$GAVEL_DATA_DIR/profile.json"
npm run gavel -- proposal 123 --output "$GAVEL_DATA_DIR/proposal-123.json"
npm run gavel -- predict "$GAVEL_DATA_DIR/profile.json" "$GAVEL_DATA_DIR/proposal-123.json" --output "$GAVEL_DATA_DIR/prediction-123.json"
npm run gavel -- inspect "$GAVEL_DATA_DIR/proposal-123.json" --stdout
npm run gavel -- prepare-vote "$GAVEL_DATA_DIR/prediction-123.json" "$GAVEL_DATA_DIR/proposal-123.json" --support FOR --reason "Confirmed reason" --acknowledge-prediction-review --stdout
```

That example runs against Nouns, which uses its public subgraph. ENS and Railgun
have no public subgraph and read a governance index instead — by default the
public one, with no configuration, no shared secret, and no network setup:

```bash
npm run gavel -- history "$VOTER" --dao ens --output "$GAVEL_DATA_DIR/history.json"
npm run gavel -- proposal 123 --dao ens --output "$GAVEL_DATA_DIR/proposal-123.json"
```

> **Open item:** the public endpoint at `https://index.0773h.com` is being
> stood up separately from the client change. Until it is serving, these
> zero-config reads are unavailable and need the override below.

`GAVEL_INDEX_API_URL` selects a private or self-hosted index instead, and then
also routes Nouns reads through it. Put no credentials in that URL: the client
sends no authentication and has no header or token mechanism, so a private index
must sit behind a network boundary that authenticates for it.

```bash
export GAVEL_INDEX_API_URL="http://127.0.0.1:18080"
```

Every indexed read gates on checkpoint freshness first: an index with no
checkpoint, a reported sync error, or a newest checkpoint older than
`GAVEL_INDEX_MAX_STALENESS_SECONDS` fails the command instead of returning a
partial history. Treat that failure as a hard stop; an empty indexed history is
not evidence that a voter has never voted.

The public `https://eth.drpc.org` endpoint is used automatically for the
chain-backed commands. Set `ETHEREUM_RPC_URL` or pass `--rpc` only when the host
needs a dedicated provider, higher limits, or different privacy properties.
Public endpoint availability is not guaranteed; Gavel fails closed on RPC
uncertainty. Archive-heavy proposal validation may require a dedicated provider
override.

An orchestrator must treat a nonzero exit, `BLOCKED`, or uncertain RPC result as
a hard stop. It must also keep recommendation, human review, preparation, and
submission as separate steps. See [`docs/runtimes/generic-cli.md`](docs/runtimes/generic-cli.md)
for the stable interface contract.

For delegated execution, check readiness before preparing a vote:

```bash
npm run gavel -- execution-status \
  --dao nouns \
  --mode safe-supervised \
  --model-address 0xMODEL \
  --asset-owner-address 0xOWNER \
  --execution-address 0xSAFE
```

If `redelegationRequired` is true, prepare—but do not submit—the delegation
transaction with `npm run gavel -- prepare-delegation`. Safe mode only proposes
the exact validated transaction for human owner approval. WaaP mode additionally
requires an autonomy-enabled DAO adapter, an allowlisted action, matching address
and chain scope, and a positive policy decision. No live WaaP broadcaster is
bundled.

### Terminal UI (TUI)

`packages/tui` contains the first migration slice of the standalone
[`jgramajo4/Gavel-TUI`](https://github.com/jgramajo4/Gavel-TUI) application,
pinned to source commit `39ddf1e8fbb2f378b0b62c44df206dcfa4900466`.
The Ink screens, keyboard navigation, polling, formatting, and legacy data
modules are now available in the monorepo for incremental replacement.

This phase is intentionally read-only. The migrated configuration never loads
`GAVEL_PRIVATE_KEY`, so the legacy vote, delegation, and attestation action
modules cannot obtain a signer through the application bootstrap. Do not
re-enable that environment-key path. Replace those actions with canonical
Gavel preparation and an explicit local wallet handoff.

Run the imported interface from a real terminal:

```bash
npm ci
npm run tui:typecheck
npm run tui
```

Set `GAVEL_INDEX_API_URL` to read the proposal list from a private or
self-hosted governance index instead of the public Nouns subgraph; the TUI then
applies the same checkpoint-freshness gate as the CLI and reports a stalled
index rather than showing a short list. The delegate view still reads the
subgraph, because delegation ingestion is not implemented in the index.

The TUI still contains transitional PASS/FAIL prediction, subgraph, ABI, and
proposal-state modules. They are migration inputs, not canonical Gavel domain
logic. Follow [the TUI migration checklist](docs/architecture/TUI_MIGRATION.md)
as each module is replaced by `@gavel/core`, `@gavel/nouns-adapter`, or the
stable JSON CLI.

### Headless on Railway

For the private copilot workflow, use a one-shot or scheduled CLI worker; do
not deploy the TUI because it requires an interactive TTY. The separate
self-hosted governance index does ship `gavel-indexer serve`, a read-only HTTP
API, and liveness/operational health checks as documented above. The
[`packages/server`](packages/server/) boundary remains intentionally empty and
is unrelated to that index API.

To deploy a headless job:

1. Create a Railway service from your GitHub fork of this repository.
2. Set the build command to `npm ci`.
3. Add a persistent volume mounted at `/data`.
4. Add service variables:

   ```text
   GAVEL_DATA_DIR=/data/gavel
   # Optional advanced override: ETHEREUM_RPC_URL=<ethereum-mainnet-rpc>
   NOUNS_SUBGRAPH_URL=https://www.nouns.camp/subgraphs/nouns
   GAVEL_STRUCTURED_ERRORS=1
   ```

5. Set a start command that performs one bounded operation and exits. For
   example, a scheduled history refresh is:

   ```bash
   npm run gavel -- history 0xYourVoterAddress
   ```

6. Configure the service as a Railway Cron Job if it should run on a schedule.
   Create separate jobs or a small BYOH orchestrator for multi-step workflows;
   do not encode transaction submission into an unattended shell chain.

Railway mounts volumes only when the service starts, so state-producing Gavel
commands belong in the start command, not a build or pre-deploy command. Mounting
at `/data` and setting `GAVEL_DATA_DIR=/data/gavel` keeps private artifacts away
from Railway's ephemeral application filesystem. See Railway's official guides
for [services](https://docs.railway.com/services),
[start commands](https://docs.railway.com/builds/build-and-start-commands),
[volumes](https://docs.railway.com/volumes),
[variables](https://docs.railway.com/variables), and
[cron jobs](https://docs.railway.com/cron-jobs).

The first future HTTP deployment should use `packages/server` and the same core,
adapter, storage, and execution boundaries. Until that server exists, exposing a
public Railway domain does not make the CLI an API.

## Historical vote ingestion

```bash
npm run gavel -- history 0xYourVoterAddress
```

By default, Gavel writes the normalized record under
`data/private/nouns/<address>.json`. Set `GAVEL_DATA_DIR` to let a host runtime
choose a durable private location; no Bankr path is hard-coded in core. To
choose one output file directly:

```bash
npm run gavel -- history 0xYourVoterAddress --output ./history.json
```

Use `--stdout` to emit the complete JSON document without writing a file:

```bash
npm run gavel -- history 0xYourVoterAddress --stdout
```

The default source is `https://www.nouns.camp/subgraphs/nouns`. Override it with
`NOUNS_SUBGRAPH_URL` or `--endpoint`.

## Private voter profile

Build a profile from a normalized history file:

```bash
npm run gavel -- profile data/private/nouns/0xyourvoteraddress.json
```

Gavel defaults to an explicit 365-day exponential half-life and records the
formula and evidence cutoff in the output. Add private, user-maintained policy
inputs with `--preferences <json>` and `--rules <json>`. Example formats live in
[`examples/`](examples/); the full methodology is documented in
[`docs/PROFILE_MODEL.md`](docs/PROFILE_MODEL.md).

Profiles are written to `data/private/profiles/<dao>/<address>.json` unless
`--output` or `--stdout` is supplied. Observed history is never edited by user
corrections. Policy precedence is:

```text
matching hard rule > newest matching stated preference > observed behavior
```

For a new or low-history voter, record the short onboarding questionnaire as
explicit stated preferences, never as learned behavior:

```bash
node bin/gavel.js onboard 0xYourVoterAddress --questions
node bin/gavel.js onboard 0xYourVoterAddress --answers examples/onboarding-answers.json
```

Answers support `DEPENDS` and `SKIP`, preserve optional qualifications, and are
stored with timestamped questionnaire provenance under `data/private/policies/`.

## Current proposal retrieval

Fetch and normalize a current Nouns proposal by ID before inspecting or
predicting it:

```bash
npm run gavel -- proposal 123
```

The default private output is `data/private/proposals/nouns/123.json`. Use
`--stdout`, `--output`, or `--endpoint` with the same semantics as history
ingestion. Proposal prose remains quarantined as untrusted data.

## Proposal prediction

Analyze a normalized proposal using the private profile:

```bash
npm run gavel -- predict \
  data/private/profiles/nouns/0xyourvoteraddress.json \
  examples/normalized-proposal.json
```

The result contains `FOR`, `AGAINST`, or `ABSTAIN`, an explicitly labeled
heuristic score (or calibrated correctness estimate), personal historical
precedents, evidence-based explanations, a first-class `predictionReview`
decision, and a clearly marked draft reason. Observed-behavior recommendations
are advisory and cannot enter autonomous execution. The full methodology and its
limits are documented in [`docs/PREDICTION_ENGINE.md`](docs/PREDICTION_ENGINE.md).
A leakage-free real-history holdout is recorded in
[`docs/PREDICTION_EXAMPLE.md`](docs/PREDICTION_EXAMPLE.md).

Predictions are private by default and do not prepare, sign, or broadcast votes.

## Review-first vote preparation

After reviewing a prediction, explicitly confirm its support choice and prepare
an unsigned Nouns transaction:

```bash
npm run gavel -- prepare-vote \
  data/private/predictions/nouns/0xyourvoteraddress/123.json \
  data/private/proposals/nouns/123.json \
  --support FOR \
  --reason "Confirmed voting reason" \
  --acknowledge-prediction-review
```

This read-only gate uses the public default RPC, or `ETHEREUM_RPC_URL`/`--rpc`
when overridden, but no private key. It verifies the
canonical contracts, proposal version/description events, exact proposal actions and voting window, active state,
duplicate-vote status, snapshot voting power, security review, and transaction
simulation. A failed gate returns `BLOCKED` with no transaction. A passing gate
returns unsigned calldata for a separate wallet approval flow; it never signs or
broadcasts. See [`docs/PREPARE_VOTE.md`](docs/PREPARE_VOTE.md).

For a separate delegated voting wallet, `--from 0xVotingAddress` remains a
compatibility alias. New integrations should use `--asset-owner` and
`--execution-address`. Gavel keeps `modelAddress`, `assetOwnerAddress`,
`currentDelegateAddress`, `executionAddress`, and `requiredDelegateAddress`
explicit and distinct.

## Execution readiness and delegation

Runtime and wallet are independent choices. Check the selected execution mode
before preparation or submission:

```bash
gavel execution-status --dao nouns --mode safe-supervised --model-address 0xMODEL
gavel execution-status --dao nouns --mode waap-autonomous --model-address 0xMODEL
```

The JSON response reports current/required delegates, voting power,
`redelegationRequired`, and `canVote`. RPC uncertainty fails closed. Prepare an
explicit unsigned delegation change with:

```bash
gavel prepare-delegation --dao nouns --asset-owner-address 0xCOLD --to 0xNEWDELEGATE
```

Safe execution uses a proposer-only client and preserves human approval. Gavel
does not create or select a Safe, and no Safe owner key is required. WaaP
execution is available only when the registered DAO
adapter explicitly enables autonomy, the action is allowlisted, delegation and
address roles match, and a policy hook approves the immutable prepared intent.
Live WaaP broadcast is intentionally left to an official deterministic client.
See [`docs/execution/safe.md`](docs/execution/safe.md) and
[`docs/execution/waap.md`](docs/execution/waap.md).

## Proposal security

Inspect a normalized proposal independently of any voter profile:

```bash
npm run gavel -- inspect examples/normalized-proposal.json -- --stdout
```

Gavel quarantines proposal prose as untrusted data, decodes structured Nouns
actions where possible, structurally inspects targets and privileged calls, and flags unknown
or dangerous execution. Conservative mismatch checks compare explicit ETH amount
and recipient claims against decoded actions. Prediction output embeds the same
security report, while keeping security review separate from the personalized
voter recommendation. See [`docs/PROPOSAL_SECURITY.md`](docs/PROPOSAL_SECURITY.md).

## Historical backtesting

Run expanding-window chronological evaluation on a normalized voter history:

```bash
npm run gavel -- backtest data/private/nouns/0xyourvoteraddress.json
```

The report includes overall and class-specific accuracy, confidence buckets,
category/year slices, Brier scores, failure modes, and a minimum-sample-gated
calibration model. Training uses strictly earlier blocks, excludes same-block
votes, and redacts ingestion-time outcomes and tallies. The complete methodology
is documented in [`docs/BACKTESTING.md`](docs/BACKTESTING.md).
The first full Nouncil result—including the finding that the current predictor
does not beat its majority-class baseline—is documented in
[`docs/BACKTEST_EXAMPLE.md`](docs/BACKTEST_EXAMPLE.md).

An eligible model can calibrate a later prediction. Passing the complete report
also attaches its baseline comparison to `predictionReview`:

```bash
npm run gavel -- predict profile.json proposal.json --calibration backtest.json
```

## Privacy

Historical votes are public, but the normalized record and all future derived
profiles are private by default. Do not commit `data/private/`. Gavel never mixes
one voter's model with another voter.

## Current boundaries

- The ingestion adapter trusts the subgraph for discovery and rich proposal
  metadata. Vote preparation independently verifies executable actions, voting
  window, state, receipt, and voting power against canonical contracts.
- Proposal content is stored as untrusted evidence. It is never interpreted as
  Gavel instructions. Static action inspection does not replace direct chain
  verification or transaction simulation.
- The numeric confidence field is explicitly labeled by `confidenceKind`. It is
  a heuristic score unless a chronological backtest bucket meets its minimum
  evidence count. Calibration does not by itself authorize autonomy.
- Observed-behavior recommendations are advisory, require explicit review before
  vote preparation, and are blocked from WaaP autonomy.
- Unknown arbitrary calldata is flagged for human review. Preparation requires
  explicit review acknowledgement, and critical findings remain blocked.
- Canonical preparation produces immutable validated calldata. Unsigned mode
  stops there; Safe can propose for human approval, while WaaP remains adapter-
  and policy-scoped.
- The Phase 9 gate status and reproducible evidence are maintained in
  [`docs/PHASE9_LAUNCH_READINESS.md`](docs/PHASE9_LAUNCH_READINESS.md).

Set `GAVEL_STRUCTURED_ERRORS=1` for privacy-scrubbed JSON operational failures.

## Legacy Nouns tools

The Bankr entry point in [`nouns-dao/SKILL.md`](nouns-dao/SKILL.md) now routes
natural voter intents through Gavel's personalized onboarding, profile,
proposal-analysis, correction, backtest, daily briefing, vote-review, and
delegation workflows. The older chain scripts remain documented in
[`nouns-dao/README.md`](nouns-dao/README.md) as secondary developer tools while
their reusable interactions move behind the Nouns adapter. Direct-broadcast
scripts are not the default Gavel user experience.

## License

Gavel is licensed under GPL-3.0. The audited TUI is GPL-3.0-or-later; current
runtime dependencies are permissively licensed and no consolidation conflict
was identified.
