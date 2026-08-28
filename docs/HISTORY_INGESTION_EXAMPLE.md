# Historical ingestion example

This is a reproducible summary of Gavel's first live Nouns history ingestion.
The complete normalized voter record remains private and is excluded from git.

## Subject

- Delegate: `nouncil.eth`
- Address: `0xcC2688350d29623E2A0844Cc8885F9050F0f6Ed5`
- Source: `https://www.nouns.camp/subgraphs/nouns`
- Subgraph block observed: `25841073`
- Run date: 2026-08-26

## Command

```bash
node bin/gavel.js history 0xcc2688350d29623e2a0844cc8885f9050f0f6ed5 --page-size 50
```

## Result

```json
{
  "votes": 761,
  "writtenReasonsPreserved": 748,
  "proposalActionsNormalized": 1363,
  "dateRange": {
    "firstVote": "2022-03-05T18:30:15.000Z",
    "lastVote": "2026-08-11T17:29:23.000Z"
  },
  "support": {
    "FOR": 495,
    "AGAINST": 167,
    "ABSTAIN": 99
  }
}
```

Each normalized vote includes its onchain reason, raw vote weight, vote block and
timestamp, transaction hash, client ID, content-addressed proposal, executable
actions, current proposal state/derived outcome, and source provenance.

## Privacy and reproducibility

The generated document was written to `data/private/nouns/`, which is gitignored.
Only the aggregate validation summary above is committed. Re-running the command
may produce a later subgraph block and additional votes.
