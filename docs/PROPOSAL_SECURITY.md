# Proposal security

Phase 6 adds a deterministic inspection boundary between untrusted governance
content and Gavel's voter model. Proposal titles and descriptions are evidence
only. They can never create system instructions, preferences, hard rules, or
transaction intent.

```text
untrusted title / description ----> injection and explicit-claim checks
                                           |
structured executable actions ---> decode + target + danger inspection
                                           |
                                           v
                                proposal security report
                                           |
                         prediction flags / future execution gate
```

Run the inspector without a voter profile:

```bash
npm run gavel -- inspect examples/normalized-proposal.json -- --stdout
```

Without `--stdout`, reports are private by default under
`data/private/inspections/nouns/`. `predict` also embeds the same report in its
structured output. A security flag does not rewrite the personalized voter
recommendation; it requires review before transaction preparation.

## Trust boundary

- Proposal prose is classified as `UNTRUSTED_GOVERNANCE_CONTENT` and always has
  instruction handling `NEVER_FOLLOW`.
- Structured targets, values, signatures, and calldata are inspected separately
  from prose.
- The current normalized input is not independently proven to have come from the
  chain. Reports therefore say `STRUCTURED_INPUT_NOT_CHAIN_VERIFIED` rather than
  claiming onchain verification. Direct RPC verification belongs in the vote
  preparation gate.
- An undecodable action is a reason for human review, never evidence that the
  executable action contradicts prose.
- A zero-address, zero-value, empty-calldata Nouns signaling placeholder is
  recognized as a no-op rather than a mismatch.

## Action inspection

The Nouns adapter decodes argument-only calldata when the subgraph supplies a
function signature. For raw calldata, it recognizes a conservative selector
registry covering common transfers, approvals, delegation, payer, streaming,
administration, and upgrade calls. Decoded arguments remain structured and full
addresses are preserved.

The inspector currently flags:

- unknown selectors and failed ABI decoding;
- non-no-op execution against the zero address;
- unlimited ERC-20 allowances and all-token operator approvals;
- implementation, admin, and ownership changes;
- governance delegation changes;
- destructive calls and generic execution/delegatecall surfaces;
- suspected instructions addressed to Gavel, an agent, or an automated reviewer.

Structural inspection risk is reported as `CLEAR`, `LOW`, `MEDIUM`, `HIGH`, or `CRITICAL`. Warning,
danger, and critical flags set `requiresHumanReview`.

## Prose/action mismatches

Mismatch detection is deliberately narrow to reduce false accusations. It only
compares explicit, machine-readable claims, currently:

- an explicitly labeled total ETH payment/request against direct native-transfer value; and
- an explicitly named payment recipient address against decoded recipients.

A contradiction is reported only when every action relevant to the comparison
was decoded. A prose promise that is merely not enforced onchain is not labeled
a mismatch. Token-asset comparisons are reserved in the schema but are not yet
emitted until token metadata can be independently verified.

## Limitations

- This is static inspection, not transaction simulation.
- `CLEAR` means this limited inspection detected no structural issue. It is not
  a claim of economic safety, contract safety, or proposal quality.
- Target labels are a small local registry, not proof of contract identity.
- Proxy storage state, implementation code, nested calls, and dynamic external
  effects require direct chain reads or simulation.
- Natural-language mismatch checks intentionally miss ambiguous prose rather
  than overstate certainty.
- Phase 8 must fail closed on `requiresHumanReview` before preparing a vote and
  must re-fetch the proposal by content hash from a canonical chain source.

The design adapts the useful nounsbot principles that calldata is authoritative,
untrusted text is quarantined, unknown calls escalate, and non-enforcement is not
automatically a contradiction. It does not copy nounsbot's constitutional voting
policy because Gavel's recommendation remains personalized to each voter.

## Real-history validation snapshot

The inspector was run offline across the same 761-proposal Nouncil history used
for Phase 5. It inspected 1,363 actions, decoded 957, and classified 7 as unknown.
Twenty proposals required review across overlapping danger categories, including
9 conservative prose/action mismatch candidates. These counts validate coverage,
not safety: every flagged result still needs a human or chain-aware simulation,
and an unflagged structured input is not yet proof of safe execution.
