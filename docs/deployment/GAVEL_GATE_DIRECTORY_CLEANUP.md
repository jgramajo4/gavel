# Removing an enrollment from the production Gate directory

> **Read `GAVEL_GATE_DIRECTORY_SCOPING.md` first.** Gate profiles are not
> scoped by environment, so a test Gate visible in production may be a staging
> enrollment leaking through a shared database rather than production test
> data. If it is, the procedure below removes the listing but staging can
> re-publish it at any time; separate the databases instead.

## What the product supports

There is **no operator removal path**. Gate exposes no admin route, no delete
endpoint, and no CLI command that can take a voter out of the directory:

- `GET /v1/gates` and `GET /v1/gates/:wallet` are read-only.
- `PUT /v1/gate/me/profile` is the only write, and it is owner-bound: it
  requires a `dao_profile` WalletSession for **that wallet**, plus a
  `GateEnrollment` typed-data signature whose `wallet` field matches the
  session. A mismatch is a `403`.
- `gavel gate …` in the CLI offers `profile` and `inbox` only.

This is deliberate — no one but a voter can change a voter's listing — and it
means directory cleanup is done **by each enrolled wallet**, not by an
operator acting on it.

## Removing a test enrollment

A profile leaves the public directory when its availability is anything other
than `accepting_now`; `listPublicProfiles` only ever returns `accepting_now`
rows. So the supported removal is a re-enrollment at `closed`.

For each E2E/test wallet, with that wallet connected:

1. Open `/enroll` on the Gate web app.
2. Set **Availability** to `Closed`.
3. Sign the `dao_profile` session challenge and the `GateEnrollment` challenge.

The wallet drops out of `GET /v1/gates` immediately. `closed` is not a
transition into `accepting_now`, so no `BasePayoutControl` proof is requested,
and a contract wallet needs nothing extra.

Verify with:

```bash
curl -s "$GAVEL_GATE_URL/v1/gates?dao=nouns&availability=accepting_now" \
  | jq -r '.items[].wallet'
```

## What must not be touched

`0xC18017a8A8a1Ec36966faA823A135ff51A5F5425` is the real Safe enrollment. Leave
its availability at `accepting_now`. Confirm it is still listed after every
removal above — the verification command is the check.

## Rows, not listings

Setting `closed` withdraws a wallet from the directory; it does not delete the
profile row, its policy, or its history. Deleting rows would mean direct SQL
against the production Gate database under the least-privilege `gavel_gate`
role, which is outside what the application supports and is not required to
clean up the demo path. Do not reach for it to hide a listing that `closed`
already hides.
