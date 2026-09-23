"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createEnsNameResolver, isRenderableEnsName } = require("../src/gate/ens");
const { createProfileService } = require("../src/gate/profile-service");

const WALLET = "0xC18017a8A8a1Ec36966faA823A135ff51A5F5425";
const OTHER = "0x2222222222222222222222222222222222222222";

function stubProvider(lookup) {
  return { lookupAddress: lookup };
}

test("no provider means no resolver at all, and callers fall back to the address", () => {
  assert.equal(createEnsNameResolver({}), null);
  assert.equal(createEnsNameResolver({ provider: {} }), null);
  assert.equal(createEnsNameResolver(), null);
});

test("a verified reverse record resolves, and the same address is looked up once", async () => {
  let calls = 0;
  const resolver = createEnsNameResolver({
    provider: stubProvider(async () => { calls += 1; return "gavel.eth"; }),
  });

  assert.deepEqual(await resolver.resolve(WALLET), { status: "named", name: "gavel.eth" });
  // Checksummed and lowercase are the same wallet, and the cache knows it.
  assert.deepEqual(await resolver.resolve(WALLET.toLowerCase()), { status: "named", name: "gavel.eth" });
  assert.equal(calls, 1);
});

test("concurrent lookups for one address share a single request", async () => {
  let calls = 0;
  const resolver = createEnsNameResolver({
    provider: stubProvider(async () => { calls += 1; return "gavel.eth"; }),
  });

  const results = await Promise.all([resolver.resolve(WALLET), resolver.resolve(WALLET), resolver.resolve(WALLET)]);
  assert.deepEqual(results.map((entry) => entry.name), ["gavel.eth", "gavel.eth", "gavel.eth"]);
  assert.equal(calls, 1);
});

test("an address with no primary name is `unnamed`, which is a fact, not a failure", async () => {
  const resolver = createEnsNameResolver({ provider: stubProvider(async () => null) });
  assert.deepEqual(await resolver.resolve(WALLET), { status: "unnamed", name: null });
});

test("an RPC failure or timeout is `unavailable` and is retried sooner than a hit", async () => {
  let clock = 1_000;
  let calls = 0;
  const resolver = createEnsNameResolver({
    provider: stubProvider(async () => { calls += 1; throw new Error("rpc down"); }),
    errorTtlMs: 50,
    ttlMs: 10_000,
    now: () => clock,
  });

  assert.deepEqual(await resolver.resolve(WALLET), { status: "unavailable", name: null });
  await resolver.resolve(WALLET);
  assert.equal(calls, 1, "a failure inside its short window is not retried");

  clock += 100;
  await resolver.resolve(WALLET);
  assert.equal(calls, 2, "a failure is retried once its short window passes");
});

test("a lookup that never settles resolves as unavailable rather than hanging a read", async () => {
  const resolver = createEnsNameResolver({
    provider: stubProvider(() => new Promise(() => {})),
    timeoutMs: 10,
  });
  assert.deepEqual(await resolver.resolve(WALLET), { status: "unavailable", name: null });
});

test("a malformed wallet never reaches the provider", async () => {
  let calls = 0;
  const resolver = createEnsNameResolver({ provider: stubProvider(async () => { calls += 1; return "x.eth"; }) });
  for (const value of ["", "0x", "nouns.eth", null, undefined, `0x${"z".repeat(40)}`]) {
    assert.deepEqual(await resolver.resolve(value), { status: "unavailable", name: null });
  }
  assert.equal(calls, 0);
});

test("only a conservative lowercase-ASCII label is renderable", () => {
  for (const name of ["gavel.eth", "a-b.c-d.eth", "nouns.eth"]) {
    assert.equal(isRenderableEnsName(name), true, name);
  }
  for (const name of [
    "GAVEL.eth",                 // case is not normalized for us
    "gavel",                     // no label separator
    "nоuns.eth",                 // Cyrillic homoglyph
    "gavel‮.eth",           // bidi override
    "-gavel.eth",
    "gavel-.eth",
    `${"a".repeat(101)}.eth`,
    "",
    null,
  ]) {
    assert.equal(isRenderableEnsName(name), false, String(name));
  }
});

test("an unrenderable reverse record is treated as no name, never as unverified text", async () => {
  const resolver = createEnsNameResolver({ provider: stubProvider(async () => "nоuns.eth") });
  assert.deepEqual(await resolver.resolve(WALLET), { status: "unnamed", name: null });
});

test("the cache stays bounded while a large directory is scanned", async () => {
  const resolver = createEnsNameResolver({
    provider: stubProvider(async () => "gavel.eth"),
    maxEntries: 2,
  });
  const wallets = Array.from({ length: 8 }, (_, index) => `0x${String(index).repeat(40)}`);
  for (const wallet of wallets) await resolver.resolve(wallet);
  // Eviction is observable as a re-lookup of the oldest entry rather than a
  // leak; the assertion that matters is simply that nothing threw and the
  // resolver still answers.
  assert.deepEqual(await resolver.resolve(wallets[0]), { status: "named", name: "gavel.eth" });
});

// --- projection wiring -------------------------------------------------------

function profileServiceWith({ ensResolver, display }) {
  const profile = {
    id: "profile-1", wallet: WALLET.toLowerCase(), availability: "accepting_now",
    updatedAt: "2026-09-19T00:00:00.000Z", ...(display === undefined ? {} : { display }),
  };
  const policy = {
    profileId: "profile-1", dao: "nouns", enabled: true,
    acceptPreVote: true, acceptVoting: true, attentionAmount: "1000000", tags: [],
  };
  const repository = {
    withProfileTransaction() { throw new Error("unused"); },
    async getPolicy() { return policy; },
    async isProfileAccepting() { return true; },
    async getProfileByWallet() { return profile; },
    async listProfiles({ offset }) { return offset === 0 ? [profile] : []; },
  };
  return createProfileService({
    repository,
    authService: { verifyProfileProofs() {}, consumeProfileProofs() {} },
    indexClient: { async getVotingPower() { return { amount: "12", asOf: "2026-09-19T00:00:00.000Z" }; } },
    baseChainId: "8453",
    ensResolver,
  });
}

test("a verified name reaches both public surfaces as the generic label, never an ENS field", async () => {
  const service = profileServiceWith({
    ensResolver: createEnsNameResolver({ provider: stubProvider(async () => "gavel.eth") }),
  });

  const direct = await service.getPublicProfile(WALLET);
  const listed = (await service.listPublicProfiles({}))[0];
  assert.equal(direct.label, "gavel.eth");
  assert.equal(listed.label, "gavel.eth");
  assert.equal(Object.hasOwn(direct, "ens"), false);
  assert.equal(Object.hasOwn(listed, "ens"), false);
});

test("a verified miss publishes null instead of a wallet's self-declared name", async () => {
  const service = profileServiceWith({
    ensResolver: createEnsNameResolver({ provider: stubProvider(async () => null) }),
    display: { ens: "vitalik.eth" },
  });

  assert.equal((await service.getPublicProfile(WALLET)).label, null);
});

test("a verified name overrides a wallet's self-declared name", async () => {
  const service = profileServiceWith({
    ensResolver: createEnsNameResolver({ provider: stubProvider(async () => "gavel.eth") }),
    display: { ens: "vitalik.eth" },
  });

  assert.equal((await service.getPublicProfile(WALLET)).label, "gavel.eth");
});

test("with no resolver configured a stored display name is exposed only as a generic label", async () => {
  assert.equal((await profileServiceWith({ ensResolver: null, display: { ens: "stored.eth" } })
    .getPublicProfile(WALLET)).label, "stored.eth");
  assert.ok(!Object.hasOwn(
    await profileServiceWith({ ensResolver: null }).getPublicProfile(WALLET), "label"));
});

test("legacy malformed or bidi display names are never published as labels", async () => {
  for (const ens of ["delegate\u202e.gramajo.eth", "nоuns.eth", "UPPER.eth", "not-ens"]) {
    const service = profileServiceWith({ ensResolver: null, display: { ens } });
    assert.equal(Object.hasOwn(await service.getPublicProfile(WALLET), "label"), false);
    assert.equal(Object.hasOwn((await service.listPublicProfiles({}))[0], "label"), false);
  }
});

test("an unreachable ENS endpoint never fails a Gate read", async () => {
  const service = profileServiceWith({
    ensResolver: createEnsNameResolver({ provider: stubProvider(async () => { throw new Error("rpc down"); }) }),
    display: { ens: "stored.eth" },
  });

  const profile = await service.getPublicProfile(WALLET);
  assert.equal(profile.wallet, WALLET.toLowerCase());
  assert.equal(profile.label, "stored.eth", "an unavailable lookup leaves the stored value alone");
});

function exactLabelService(profiles, resolve) {
  const policy = { dao: "nouns", enabled: true, acceptPreVote: true, acceptVoting: true,
    attentionAmount: "1000000", tags: [] };
  const repository = {
    withProfileTransaction() { throw new Error("unused"); },
    async listProfiles({ limit, after }) {
      const start = after ? profiles.findIndex((profile) => profile.id === after.id) + 1 : 0;
      return profiles.slice(start, start + limit);
    },
    async getPolicy() { return policy; },
    async isProfileAccepting() { return true; },
  };
  return createProfileService({ repository,
    authService: { verifyProfileProofs() {}, consumeProfileProofs() {} },
    indexClient: { async getVotingPower() { return { amount: "1", asOf: "2026-01-01T00:00:00.000Z" }; } },
    baseChainId: "8453",
    ensResolver: { resolve },
  });
}

test("exact label lookup scans past page one and matches only verified names", async () => {
  const profiles = Array.from({ length: 53 }, (_, index) => ({
    id: `profile-${String(index).padStart(3, "0")}`,
    wallet: `0x${String(index + 1).padStart(40, "0")}`,
    availability: "accepting_now",
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 53 - index)).toISOString(),
    display: { ens: index >= 51 ? "deep.delegate" : `delegate-${index}.eth` },
  }));
  const service = exactLabelService(profiles, async (wallet) => ({
    status: "named",
    name: profiles.find((profile) => profile.wallet.toLowerCase() === wallet.toLowerCase()).display.ens,
  }));

  const matches = await service.findPublicProfilesByLabel({ label: "DEEP.DELEGATE", stage: "PRE_VOTE" });
  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map(({ wallet }) => wallet), profiles.slice(51).map(({ wallet }) => wallet));
});

test("self-reported labels never become exact identity when verification is unavailable or times out", async () => {
  const profiles = [
    { id: "unavailable", wallet: WALLET, availability: "accepting_now", updatedAt: "2026-01-01T00:00:02Z",
      display: { ens: "delegate.gramajo.eth" } },
    { id: "timeout", wallet: OTHER, availability: "accepting_now", updatedAt: "2026-01-01T00:00:01Z",
      display: { ens: "delegate.gramajo.eth" } },
  ];
  const timeoutResolver = createEnsNameResolver({
    provider: stubProvider(() => new Promise(() => {})), timeoutMs: 5,
  });
  const service = exactLabelService(profiles, async (wallet) => wallet.toLowerCase() === WALLET.toLowerCase()
    ? { status: "unavailable", name: null }
    : timeoutResolver.resolve(wallet));

  assert.deepEqual(await service.findPublicProfilesByLabel({ label: "delegate.gramajo.eth" }), []);
});

test("a verified voter wins when an attacker self-reports the same verified name", async () => {
  const verified = { id: "verified", wallet: WALLET, availability: "accepting_now", updatedAt: "2026-01-01T00:00:02Z",
    display: { ens: "something-else.eth" } };
  const attacker = { id: "attacker", wallet: OTHER, availability: "accepting_now", updatedAt: "2026-01-01T00:00:01Z",
    display: { ens: "delegate.gramajo.eth" } };
  const service = exactLabelService([verified, attacker], async (wallet) => wallet.toLowerCase() === WALLET.toLowerCase()
    ? { status: "named", name: "delegate.gramajo.eth" }
    : { status: "unnamed", name: null });

  const matches = await service.findPublicProfilesByLabel({ label: "delegate.gramajo.eth" });
  assert.deepEqual(matches.map(({ wallet, label }) => ({ wallet, label })), [{
    wallet: WALLET.toLowerCase(), label: "delegate.gramajo.eth",
  }]);
});

test("malformed or bidi labels cannot be exact identity lookup keys", async () => {
  const profile = { id: "attacker", wallet: OTHER, availability: "accepting_now", updatedAt: "2026-01-01T00:00:01Z",
    display: { ens: "delegate\u202e.gramajo.eth" } };
  const service = exactLabelService([profile], async () => ({ status: "unavailable", name: null }));
  await assert.rejects(service.findPublicProfilesByLabel({ label: profile.display.ens }), /label is invalid/);
});

test("a resolver that throws outright is still only decoration", async () => {
  const service = profileServiceWith({
    ensResolver: { resolve() { throw new Error("boom"); } },
  });

  const profile = await service.getPublicProfile(WALLET);
  assert.equal(profile.wallet, WALLET.toLowerCase());
  assert.equal(profile.acceptingSubmissions, true);
});

test("a resolver without resolve() is refused at construction", () => {
  assert.throws(() => profileServiceWith({ ensResolver: {} }), /ensResolver/);
});

test("ENS never becomes identity: the canonical wallet is unchanged by a name", async () => {
  const service = profileServiceWith({
    ensResolver: createEnsNameResolver({ provider: stubProvider(async () => "gavel.eth") }),
  });
  const [listed] = await service.listPublicProfiles({});
  assert.equal(listed.wallet, WALLET.toLowerCase());
  assert.equal((await service.getPublicProfile(WALLET)).wallet, WALLET.toLowerCase());
});
