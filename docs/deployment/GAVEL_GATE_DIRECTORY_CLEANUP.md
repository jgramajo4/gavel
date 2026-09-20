# Gate directory cleanup after an environment split

There is no operator or admin route that deletes a Gate profile.

`PUT /v1/gate/me/profile` is owner-bound. Closed profiles remain in the
product; they drop out of the default `accepting_now` public listing when
that wallet re-enrolls at `closed` availability (or a later owner-bound
update the product already allows). Direct SQL deletion of `gate.profiles`
is not a supported cleanup path: it can orphan quotes, reservations, and
inbox rows.

## After the databases are split

Confirm production's directory contains only legitimate production
enrollments, and that staging test wallets are not visible there.

```sh
curl -sS https://api-mainnet.0773h.com/v1/gate/daos/nouns/gates
```

Compare the wallets to the known production enrollments. Staging E2E/test
Gates must not appear.

On the production database (read-only):

```sql
SELECT wallet, availability, updated_at
FROM gate.profiles
ORDER BY updated_at DESC;
```

If a staging test wallet is still listed on production:

1. Prefer the supported voter-owned close: authenticate as that wallet with a
   `dao_profile` session and set availability to `closed`.
2. Re-check the public directory until that wallet is absent from
   `accepting_now` listings.
3. Do not add an operator-delete capability unless there is a real
   operational requirement that the owner-bound close cannot satisfy.
4. Do not `DELETE FROM gate.profiles`.
5. Do not `DELETE FROM gate.splitter_deployments`.

Leave the real production Safe enrollment untouched unless that voter asks
to close it.
