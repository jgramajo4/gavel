# WaaP scoped autonomy

WaaP support is an execution abstraction and testable scaffold, not a generic
wallet. `WaapAutonomousExecutor` accepts only an immutable transaction produced
by canonical Gavel validation. It then requires:

- an explicitly registered DAO adapter with `waapAutonomous: true`;
- an adapter-supported governance action;
- matching DAO, chain, execution address, and canonical governor scope;
- a positive policy-hook decision;
- `autonomyAllowed: true` in the immutable prepared intent (advisory
  observed-behavior recommendations set it to false);
- no material mutation by the WaaP client.

`execution-status` separately verifies that the asset owner delegates to the
WaaP execution address and that the address has voting power. Switching from a
Safe address to a different WaaP address reports `redelegationRequired` and
cannot vote until the explicit transition occurs.

No live WaaP broadcaster is bundled in this phase. Add one only against an
official, deterministic, testable client without weakening these gates.
