# Supported DAOs

Use the canonical CLI DAO identifiers below. Keep histories and profiles separate
by DAO; do not merge votes merely because the same wallet appears in more than
one governance system.

| DAO | CLI ID | Voting model | Current Gavel scope |
| --- | --- | --- | --- |
| Nouns DAO | `nouns` | Nouns Governor | History, proposal analysis, vote preparation, delegation |
| ENS DAO | `ens` | OpenZeppelin Governor on Ethereum | Indexed history and RPC-verified proposals, analysis, vote preparation, delegation |
| Railgun Governance (Ethereum) | `railgun-eth` | Custom Voting + Staking | Live proposal reads, indexed history, analysis, binary vote preparation |

## ENS

ENS has two venues. The executable venue is the Governor at
`0x323A76393544d5ecca80cd6ef2A560C6a395b7E3`; Snapshot space `ens.eth`
contains social votes and elections. Keep their proposal IDs and vote histories
separate. Gavel's transaction preparation supports the executable Governor
venue. Do not coerce Snapshot Copeland elections into FOR/AGAINST/ABSTAIN.

ENS Governor history and proposal metadata come from a Gavel governance index,
the public one by default; there is no public ENS subgraph path in the CLI.

ENS token balance is not voting power. The voting address needs checkpointed
delegated ENS at the proposal snapshot block. `prepare-delegation --dao ens`
creates unsigned `delegate(address)` calldata.

## Railgun

Gavel's `railgun-eth` adapter is only for the canonical Ethereum Voting contract
at `0xc480F68A3dcC3EdD82134FAB45C14A0FcF1dA3CC`. Polygon and BSC governance are
different DAOs and are not aliases for this adapter.

Railgun votes are `FOR` (Yay) or `AGAINST` (Nay). There is no abstain choice and
no onchain reason. Voting power comes from locked RAIL and is read from the
proposal's staking snapshot interval. The adapter computes the required snapshot
hint and defaults to the account's full remaining voting power; pass `--amount`
only when the user explicitly chooses a partial amount. A voting key may submit
for the staking account, but it must match the contract's configured key.

Railgun sponsorship is not a vote and must not be added to a voter profile.
Delegation is per stake ID, so the generic `prepare-delegation` command refuses
Railgun rather than guessing a stake.
