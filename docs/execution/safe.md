# Safe supervised execution

Safe mode binds a canonically validated Gavel transaction to a configured Safe
address and chain. `SafeSupervisedExecutor` passes the exact target, calldata,
value, proposal ID, support, reason, DAO adapter, and intent hash to an injected
Safe proposer client. If the client echoes different material, Gavel fails
closed.

The client needs proposer/delegate capability only. Gavel does not request or
store a Safe owner private key. A successful submission is `PROPOSED`; status
may progress through `AWAITING_APPROVAL`, `READY_TO_EXECUTE`, and `EXECUTED`, or
end in `REJECTED`, `EXPIRED`, `FAILED`, or `BLOCKED`. Human Safe owners retain
the authorization boundary.

Run `gavel execution-status --mode safe-supervised` first. The cold asset owner
must currently delegate Nouns voting power to the Safe execution address.
