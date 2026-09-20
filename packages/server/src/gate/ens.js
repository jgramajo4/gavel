"use strict";

/**
 * Server-side ENS reverse resolution for the public Gate projection.
 *
 * Why this lives on the server at all:
 *
 *  - The public projection's `ens` field was previously a pass-through of the
 *    enrolling wallet's own `publicDisplay.ens`. No client in this repository
 *    ever sends that field, so every production profile served no name, and the
 *    browser fallback in `apps/gate-web/src/ens.tsx` only runs when the
 *    operator publishes `VITE_ENS_RPC_URL` into the bundle. With neither in
 *    place a Gate renders as a bare shortened address for every viewer.
 *  - Resolving once here gives every client the same name — the directory, a
 *    Bankr advocate reading `/v1/gates`, and the CLI — without asking any of
 *    them to hold a mainnet RPC endpoint.
 *
 * What this is NOT: identity. Nothing resolved here is used for authorization,
 * a route, a request body, quote material, or any other security decision. A
 * name is a label drawn next to the canonical checksummed address. The address
 * is what every signature, path, and payment keeps carrying.
 *
 * `lookupAddress` performs the reverse record *and* the forward check, so a
 * name is returned only when `name -> address` agrees with `address -> name`.
 * A reverse record on its own is attacker-controlled text.
 *
 * Contract accounts (a Safe is the case that motivated this) resolve through
 * exactly the same `<address>.addr.reverse` node as an EOA. The common reason a
 * Safe shows no name is that it never set a primary name — that requires a
 * transaction from the Safe itself, and setting only the forward record is not
 * enough. That case is a genuine `unnamed`, and rendering the shortened address
 * is the correct answer, not a bug to paper over with self-declared text.
 */

/**
 * A conservative shape gate on the resolved label, identical to the browser's.
 *
 * Even a forward-verified name is a string an outsider chose. Restricting the
 * rendered set to lowercase ASCII labels keeps homoglyph and bidi-override
 * tricks out of a surface whose whole job is telling a payer who they are about
 * to pay.
 */
const RENDERABLE_ENS = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A resolved name is stable enough to hold for an hour; a miss for as long. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;
/** An RPC failure is not a fact about the name, so it is held only briefly. */
const DEFAULT_ERROR_TTL_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 2_000;
/** Bounds the cache so a directory scan cannot grow it without limit. */
const DEFAULT_MAX_ENTRIES = 2_000;

const UNAVAILABLE = Object.freeze({ status: "unavailable", name: null });
const UNNAMED = Object.freeze({ status: "unnamed", name: null });

function isRenderableEnsName(name) {
  return typeof name === "string" && name.length <= 100 && RENDERABLE_ENS.test(name);
}

function named(name) {
  return Object.freeze({ status: "named", name });
}

async function withTimeout(read, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("ENS lookup timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds a caching reverse resolver over an Ethereum mainnet provider, or
 * `null` when none is supplied.
 *
 * `resolve(wallet)` never rejects and never throws: ENS is display, so every
 * failure degrades to `unavailable` and the caller falls back to the address.
 * The three outcomes are distinguished on purpose —
 *
 *   `named`       the lookup ran and verified a name
 *   `unnamed`     the lookup ran and this address has no primary name
 *   `unavailable` the lookup could not run (no provider, RPC error, timeout)
 *
 * — because only the first two are facts the projection may act on.
 */
function createEnsNameResolver({
  provider,
  ttlMs = DEFAULT_TTL_MS,
  errorTtlMs = DEFAULT_ERROR_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => Date.now(),
} = {}) {
  if (!provider || typeof provider.lookupAddress !== "function") return null;

  // address -> { expiresAt, value } for settled lookups, and address -> promise
  // for one in flight, so a directory page asking for the same wallet twice
  // costs one request.
  const settled = new Map();
  const inFlight = new Map();

  function remember(key, value) {
    if (settled.size >= maxEntries) {
      // Oldest insertion first; Map preserves it. One eviction per insert keeps
      // the cache bounded without a sweep.
      const oldest = settled.keys().next();
      if (!oldest.done) settled.delete(oldest.value);
    }
    settled.set(key, {
      value,
      expiresAt: Number(now()) + (value.status === "unavailable" ? errorTtlMs : ttlMs),
    });
    return value;
  }

  return Object.freeze({
    async resolve(wallet) {
      if (typeof wallet !== "string" || !ADDRESS.test(wallet)) return UNAVAILABLE;
      const key = wallet.toLowerCase();

      const cached = settled.get(key);
      if (cached && cached.expiresAt > Number(now())) return cached.value;
      if (cached) settled.delete(key);

      const pending = inFlight.get(key);
      if (pending) return pending;

      const lookup = withTimeout(() => provider.lookupAddress(key), timeoutMs)
        .then((name) => remember(key, isRenderableEnsName(name) ? named(name) : UNNAMED))
        // A resolution failure is a display miss, never an error a caller sees.
        .catch(() => remember(key, UNAVAILABLE))
        .finally(() => inFlight.delete(key));

      inFlight.set(key, lookup);
      return lookup;
    },
  });
}

module.exports = {
  DEFAULT_ERROR_TTL_MS,
  DEFAULT_TTL_MS,
  RENDERABLE_ENS,
  createEnsNameResolver,
  isRenderableEnsName,
};
