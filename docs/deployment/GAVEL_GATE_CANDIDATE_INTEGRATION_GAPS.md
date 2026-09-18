# Gavel Gate Candidate integration-gap report

**Branch/base inspected:** `feat/gate-nouns-candidates` at `c34347f528fa4b3fc039ab7630008552454153ad`, equal to `origin/main` when this worktree was created.

**Scope:** read-only baseline before the auth, Gate projection, and Nouns Proposal Candidate integration. No payment transaction, settlement scan, notification send, deployment, or mainnet mutation was performed.

## Executive disposition

Current `main` is **not ready** for the Candidate → quote demo:

1. `/v1/gate/auth/verify` reads `gate.auth_nonces` with `SELECT ... FOR UPDATE`, but the production `gavel_gate` role has only `SELECT`. PostgreSQL therefore rejects verification before signature validation.
2. Gate calls the ordinary public proposal endpoint, whose serializer strips `refreshedAt`, `sourceBlock`, and `sourceBlockHash`; Gate then correctly rejects the response as missing canonical provenance.
3. Nouns `PRE_VOTE` is deliberately rejected by enrollment, policy, lifecycle, store, SQL, and frozen-spec invariants.
4. Proposal Candidates are not fetched or persisted by the governance index.
5. Gate and index proposal IDs are decimal proposal numbers. Candidate identity is instead the on-chain tuple `(proposer, slug)` and must not be disguised as an invented proposal number.

## A. Authentication failure

The HTTP path is:

`POST /v1/gate/auth/verify` → `authService.verifyProof()` → `PostgresGateStore.transaction()` → `getNonceByHash(... FOR UPDATE)`.

The migration grants `gavel_gate` only `SELECT` on `gate.auth_nonces`. PostgreSQL requires table `UPDATE` privilege for a row lock, so production verification fails with SQLSTATE `42501`, surfaced as coarse `401 INVALID_AUTH_PROOF`.

The least-privilege correction is one owner-defined `SECURITY DEFINER` function that conditionally consumes the exact bound WalletSession nonce and inserts its hashed session atomically. It must use a fixed search path, derive session identity from the consumed nonce, expose execute only to `gavel_gate`, and leave the runtime role without direct nonce update or session insert privileges. Concurrent verification must produce exactly one session; insertion failure must roll the nonce consumption back.

The existing mutable Gate migration requires a new accepted terminal checksum and catalog manifest. The previous checksum remains an explicitly recognized upgrade source, not the expected terminal state.

## B. Missing Gate governance projection

PostgreSQL already persists proposal content, actions, effective lifecycle, and source provenance. `PostgresStore.getProposal()` assembles the required Gate fields, but the ordinary public API applies `publicProposal()` / `presentProposal()`, which removes Gate provenance. The server-side Gate index client then fails closed.

Add a separate allowlisted endpoint:

`GET /v1/gate/daos/nouns/targets/:targetId`

For an on-chain proposal it returns only:

```json
{
  "targetId": "proposal:42",
  "kind": "proposal",
  "proposalId": "42",
  "refreshedAt": "2026-09-18T00:00:00.000Z",
  "sourceBlock": "123",
  "sourceBlockHash": "0x...",
  "effectiveStatus": "ACTIVE",
  "contentHash": "0x...",
  "actions": []
}
```

The existing public proposal routes and serializers remain unchanged. Missing hashed source provenance fails closed; Gate must not synthesize block numbers, hashes, or timestamps from local clocks or checkpoints.

`raw_governance_records.block_number` must be refreshed with the same snapshot as `observed_head` and `block_hash`, keeping the persisted provenance tuple coherent.

## C. Canonical Nouns Proposal Candidate source

The source is the Nouns DAO’s on-chain `NounsDAODataProxy`, not a web page:

- proxy: `0xf790A5f59678dd733fb3De93493A91f472ca1365`
- indexed from Ethereum block `17812145`
- events: `ProposalCandidateCreated`, `ProposalCandidateUpdated`, and `ProposalCandidateCanceled`
- the official Nouns subgraph derives `ProposalCandidate`, versions, signatures, cancellation, and matching proposal IDs from those events

Primary sources pinned to Nouns monorepo commit `3779f34e4442cc62f6602bf17460ad334e0208a7`:

- [NounsDAOData contract](https://github.com/nounsDAO/nouns-monorepo/blob/3779f34e4442cc62f6602bf17460ad334e0208a7/packages/nouns-contracts/contracts/governance/data/NounsDAOData.sol)
- [NounsDAOData events](https://github.com/nounsDAO/nouns-monorepo/blob/3779f34e4442cc62f6602bf17460ad334e0208a7/packages/nouns-contracts/contracts/governance/data/NounsDAODataEvents.sol)
- [official subgraph mapping](https://github.com/nounsDAO/nouns-monorepo/blob/3779f34e4442cc62f6602bf17460ad334e0208a7/packages/nouns-subgraph/src/nouns-dao-data.ts)
- [official subgraph schema](https://github.com/nounsDAO/nouns-monorepo/blob/3779f34e4442cc62f6602bf17460ad334e0208a7/packages/nouns-subgraph/schema.graphql)
- [mainnet source configuration](https://github.com/nounsDAO/nouns-monorepo/blob/3779f34e4442cc62f6602bf17460ad334e0208a7/packages/nouns-subgraph/config/mainnet.json)

The current Gavel Nouns source already queries the official-event-derived subgraph at a pinned finalized snapshot and verifies `_meta.block.number/hash`. Candidate ingestion should reuse that mechanism and persist the exact snapshot block/hash plus index ingestion time.

## D. Candidate identity and lifecycle contract

A stable Candidate target ID is:

```text
candidate:<lowercase proposer address>:<lowercase 0x-prefixed keccak256(UTF-8 slug)>
```

The original proposer and slug remain canonical facts. The slug hash is used in the key because `NounsDAOData` itself keys candidate uniqueness by proposer plus `keccak256(bytes(slug))`. Do not force the identity into the decimal `proposalId` field and do not use the subgraph’s concatenated display ID as a protocol key.

Proposal targets use `proposal:<canonical decimal proposalId>`. Gate’s submission hash continues to bind the exact target identifier in the existing ordered position; no alternate unbound identifier is introduced.

Candidate lifecycle mapping version advances deliberately:

- latest valid candidate version, not canceled, `proposalIdToUpdate == 0`, and with no matching on-chain proposal → `PRE_VOTE`
- canceled/withdrawn candidate → `CLOSED`
- candidate already matched/promoted to an on-chain proposal → `CLOSED` as a Candidate target; the real proposal independently follows the existing `ACTIVE → VOTING` rule
- proposal-update candidates (`proposalIdToUpdate > 0`) → `CLOSED` for the sponsorship product
- malformed/incomplete source data or missing trustworthy snapshot provenance → unavailable/fail closed, never eligible

Expired or absent sponsorship signatures do not by themselves close the Candidate: the on-chain Candidate remains a valid sponsorship target until canceled or promoted. Gate does not claim that a particular signature is valid or sufficient unless a separate signature-verification feature is implemented.

## E. Product and safety semantics

This change deliberately amends the frozen MVP contract to support the already-reserved `PRE_VOTE` abstraction for Nouns Candidates:

- Nouns profiles may opt into either or both `PRE_VOTE` and `VOTING`.
- A Candidate submission must use `PRE_VOTE` and be labeled as a sponsorship request.
- Candidate canonical actions are display/quote snapshot data, not an instruction to prepare, sign, or broadcast an on-chain vote transaction.
- Existing active-proposal `VOTING` behavior remains unchanged.
- Settlement and inbox lifecycle remain stage-agnostic except that retained/current lifecycle constraints must accept `PRE_VOTE` issuance and later `PRE_VOTE | CLOSED | UNKNOWN` state.
- No scanner, splitter, AgentMail, settlement, or mainnet behavior changes are in scope.

Required spec amendments are limited to the product boundary, lifecycle mapping, enrollment/policy rules, canonical target identity, proposal snapshot outline, inbox lifecycle constraint, test matrix, and MVP/post-MVP table.

## F. Required verification

Focused verification must cover:

1. real PostgreSQL auth success under `SET ROLE gavel_gate`;
2. nonce single use, replay rejection, wrong wallet/role/signature rejection, concurrent verification, and rollback on session collision;
3. exact function/table privileges with no broad nonce update grant;
4. existing public proposal API unchanged;
5. exact Gate target projection and fail-closed missing provenance;
6. Candidate create/update/cancel/promotion mapping with stable identity and snapshot provenance;
7. `PRE_VOTE` enrollment and policy persistence;
8. Candidate quote success only when both canonical eligibility and profile policy accept `PRE_VOTE`;
9. rejection of canceled, promoted, update-only, malformed, stale, and provenance-less Candidates;
10. no Candidate path constructs or implies an on-chain vote transaction.

The task explicitly excludes a payment E2E and broad repo-wide validation. Only directly related Gate/index suites and required disposable-PostgreSQL tests should run unless a targeted failure exposes a dependency.
