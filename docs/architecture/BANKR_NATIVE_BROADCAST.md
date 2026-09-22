# Bankr native settlement broadcast assessment

## Verdict

**Unsupported for Gate settlement; keep the separate funded relayer.**

This verdict applies to the current Bankr Wallet API and skill model reviewed for this integration. Revisit it only if Bankr documents an API that submits an already prepared and signed raw Base transaction byte-for-byte with durable idempotency.

## Capabilities reviewed

Bankr exposes two relevant capabilities:

1. EIP-712 signing through its Wallet API. Gavel uses this to obtain the payer's ordinary 65-byte EIP-3009 authorization for Base native USDC.
2. Wallet transaction submission/arbitrary contract calls. Bankr accepts transaction intent fields and has its wallet construct and submit a transaction.

The second capability is not the primitive Gate needs. The required primitive must accept the exact prepared transaction—not reconstruct a similar call—and preserve all of these bindings:

- Base mainnet chain ID `8453`;
- exact Gate splitter destination;
- exact `settle` calldata rebuilt from Gate's signed quote;
- zero ETH value;
- no arbitrary-call substitution;
- deterministic transaction hash before broadcast;
- durable restart/concurrency idempotency;
- Gate-side settlement verification remains authoritative.

Bankr's documented submission surface does not establish byte-for-byte raw-transaction submission, a deterministic pre-broadcast hash controlled by Gavel, or an idempotency/reconciliation contract strong enough for crash-after-broadcast recovery. Calling its arbitrary-transaction endpoint would therefore widen authority and duplicate Gate's validation rather than remove risk.

## Retained architecture

```text
Bankr signs the payer's EIP-3009 authorization
    -> Gate loads its own owner-bound quote
    -> Gate rebuilds and validates exact settlement calldata
    -> Gate simulates and signs { chainId: 8453, to: splitter, data, value: 0 }
    -> Gate durably stores signed bytes + deterministic hash
    -> dedicated gas-only relayer broadcasts those exact bytes
    -> Gate scanner independently verifies the canonical QuoteSettled event
```

Bankr never receives relayer credentials and cannot supply `to`, `data`, or `value` to the relay endpoint. The relayer never receives discretionary transaction fields from Bankr.

## Security implications

Keeping the relayer costs one narrowly funded wallet but preserves a smaller and auditable authority boundary. It also gives Gate durable deduplication across process restarts and concurrent calls. A Bankr-native semantic contract call would save that wallet while losing exact-transaction and retry guarantees; that is a bad trade.

EIP-7702 does not change the conclusion. Any payer with non-empty Base code—including a valid `0xef0100 || delegate` designator—is rejected. Base native USDC routes such accounts through ERC-1271, while Bankr currently supplies an ordinary payer-key 65-byte EIP-3009 signature. No compatibility is assumed.

## Reconsideration criteria

Native Bankr broadcast may be reconsidered only with documentation and tests proving all of the following:

- raw signed transaction bytes are submitted unchanged;
- expected chain, destination, calldata, and zero value are independently asserted;
- the resulting hash is deterministic before the first network send;
- an idempotency key survives Bankr process/service retries;
- ambiguous send failures support hash recovery without constructing a replacement;
- Gate still verifies settlement from canonical Base receipts/logs.

Until then, the separate Gate relayer remains the production architecture.
