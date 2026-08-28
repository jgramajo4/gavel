# Nouns rewards administration

These are builder-only operations for Gavel's Nouns client attribution. They are
not voter features and must not be routed from the normal Gavel skill UX.

Both commands require:

```text
GAVEL_ADMIN_MODE=1
ETHEREUM_RPC_URL=<ethereum mainnet RPC>
AGENT_PRIVATE_KEY=<authorized builder signer>
```

The tools verify `chainId === 1` before creating a contract call.

```bash
node tools/admin/nouns-rewards/update.js \
  --last-proposal-id 456 \
  --voting-client-ids 38

node tools/admin/nouns-rewards/withdraw.js \
  --to 0xBuilderAddress \
  --amount-eth 0.5
```

Eligible user-initiated Nouns transactions continue to receive client ID `38`
automatically in the execution adapter. Users neither configure nor claim the
resulting builder rewards.
