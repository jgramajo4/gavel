const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DAO_DESCRIPTORS,
  ADAPTER_DECLARED_CAPABILITIES,
  assertDescriptorMatchesAdapter,
  daoCapabilityMatrix,
  daoProposalKey,
  daoProposalRef,
  daoSupports,
  daoTerm,
  daosSupporting,
  formatDaoProposal,
  getDaoDescriptor,
  isKnownDao,
  listDaoIds,
  normalizeDaoSelection,
  parseDaoProposalKey,
  sameDaoProposal,
} = require("../packages/core");
const { ADAPTER_CONSTRUCTORS, createDaoAdapter, listWiredDaos } = require("@gavel/daos");

/** Enough of a provider that an adapter constructor succeeds without a network. */
function stubProvider() {
  return {
    getNetwork: async () => ({ chainId: 1n }),
    getBlockNumber: async () => 1,
    getCode: async () => "0x60",
    call: async () => "0x",
    estimateGas: async () => 21000n,
  };
}

test("the catalog is the single list of supported DAOs", () => {
  assert.deepEqual(listDaoIds(), ["nouns", "ens", "railgun-eth"]);
  assert.equal(isKnownDao("nouns"), true);
  assert.equal(isKnownDao("not-a-dao"), false);
  assert.throws(() => getDaoDescriptor("not-a-dao"), /Unknown DAO/);
  // Every descriptor is complete: a partially-declared DAO would make the UI
  // guess, which is what the catalog exists to prevent.
  for (const descriptor of DAO_DESCRIPTORS) {
    assert.ok(descriptor.displayName && descriptor.network && descriptor.chainId > 0, descriptor.id);
    assert.equal(typeof descriptor.capabilities.proposals, "boolean");
    assert.equal(typeof descriptor.terminology.votingPower, "string");
  }
});

test("capabilities differ per DAO and the UI can ask rather than assume", () => {
  assert.equal(daoSupports("nouns", "waapAutonomous"), true);
  assert.equal(daoSupports("ens", "waapAutonomous"), false);
  assert.equal(daoSupports("railgun-eth", "safeSupervised"), false);
  assert.equal(daoSupports("ens", "safeSupervised"), true);
  // No adapter ships a governance calendar, so nothing claims one.
  assert.deepEqual(daosSupporting("calendar"), []);
  assert.deepEqual(
    daosSupporting("waapAutonomous").map((descriptor) => descriptor.id),
    ["nouns"],
  );

  const matrix = daoCapabilityMatrix(["nouns", "ens"]);
  assert.deepEqual(matrix.map((row) => row.id), ["nouns", "ens"]);
  assert.equal(matrix[0].capabilities.length, matrix[1].capabilities.length);
});

test("DAO terminology is per DAO, with a generic fallback", () => {
  assert.equal(daoTerm("nouns", "votingPower"), "Votes");
  assert.equal(daoTerm("ens", "votingPower"), "Voting power");
  assert.equal(daoTerm("railgun-eth", "votingPower"), "Staked voting power");
  assert.equal(daoTerm("railgun-eth", "delegate"), "Voting key");
  // An unknown DAO gets the generic word rather than a crash or a Nouns word.
  assert.equal(daoTerm("unknown-dao", "votingPower"), "Voting power");
});

test("the catalog and the adapters cannot drift apart", () => {
  for (const descriptor of DAO_DESCRIPTORS) {
    const adapter = createDaoAdapter(descriptor.id, { provider: stubProvider() });
    assert.equal(adapter.id, descriptor.id);
    assert.equal(adapter.chainId, descriptor.chainId);
    for (const capability of ADAPTER_DECLARED_CAPABILITIES) {
      assert.equal(
        adapter.capabilities[capability] === true,
        descriptor.capabilities[capability] === true,
        `${descriptor.id}.${capability}`,
      );
    }
  }
  // The assertion is what keeps them honest, so prove it actually fails.
  assert.throws(
    () =>
      assertDescriptorMatchesAdapter({
        id: "ens",
        chainId: 1,
        capabilities: { ...createDaoAdapter("ens", { provider: stubProvider() }).capabilities, waapAutonomous: true },
      }),
    /disagree about waapAutonomous/,
  );
  assert.throws(
    () => assertDescriptorMatchesAdapter({ id: "nouns", chainId: 8453, capabilities: {} }),
    /chain 1, adapter reports 8453/,
  );
});

test("every catalogued DAO is wired to an adapter in this build", () => {
  for (const row of listWiredDaos()) assert.equal(row.wired, true, row.id);
  assert.deepEqual(Object.keys(ADAPTER_CONSTRUCTORS).sort(), listDaoIds().slice().sort());
});

test("selecting one DAO, several DAOs, and adding or removing them", () => {
  assert.deepEqual(normalizeDaoSelection(["ens"]), { selected: ["ens"], unknown: [] });
  // Catalog order, not input order, so two users with the same DAOs get the
  // same config bytes.
  assert.deepEqual(normalizeDaoSelection(["ens", "nouns"]).selected, ["nouns", "ens"]);
  assert.deepEqual(normalizeDaoSelection(["ens", "ens", "NOUNS"]).selected, ["nouns", "ens"]);
  assert.deepEqual(normalizeDaoSelection([]).selected, []);

  // Unknown ids are reported, never silently dropped: a typo that quietly
  // stops following a DAO is a governance bug.
  const withTypo = normalizeDaoSelection(["nouns", "nounz"]);
  assert.deepEqual(withTypo.selected, ["nouns"]);
  assert.deepEqual(withTypo.unknown, ["nounz"]);

  const followed = normalizeDaoSelection(["nouns", "ens", "railgun-eth"]).selected;
  const removed = normalizeDaoSelection(followed.filter((id) => id !== "ens")).selected;
  assert.deepEqual(removed, ["nouns", "railgun-eth"]);
  assert.deepEqual(normalizeDaoSelection([...removed, "ens"]).selected, ["nouns", "ens", "railgun-eth"]);
});

test("proposal identity is composite, so ids cannot collide across DAOs", () => {
  assert.notEqual(daoProposalKey("nouns", 12), daoProposalKey("ens", 12));
  assert.equal(daoProposalKey("nouns", 12), "nouns:12");
  assert.equal(daoProposalKey(daoProposalRef("ens", "12")), "ens:12");
  assert.equal(sameDaoProposal(daoProposalRef("nouns", 12), daoProposalRef("nouns", "012")), true);
  assert.equal(sameDaoProposal(daoProposalRef("nouns", 12), daoProposalRef("ens", 12)), false);

  const parsed = parseDaoProposalKey("railgun-eth:7");
  assert.equal(parsed.dao, "railgun-eth");
  assert.equal(parsed.proposalId, "7");
  assert.equal(parsed.chainId, 1);

  // A uint256 proposal id must survive intact: `Number()` would not.
  const big = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
  assert.equal(daoProposalRef("ens", big).proposalId, big);
  assert.equal(daoProposalRef("ens", 10n ** 30n).proposalId, (10n ** 30n).toString());

  // The DAO name is always in what the user reads.
  assert.equal(formatDaoProposal("nouns", 812), "Nouns #812");
  assert.equal(formatDaoProposal("ens", 3), "ENS #3");
  assert.equal(formatDaoProposal("railgun-eth", 1), "Railgun #1");

  assert.throws(() => daoProposalRef("nouns", "-1"), /Invalid proposal id/);
  assert.throws(() => daoProposalRef("Nouns!", 1), /Invalid DAO id/);
});
