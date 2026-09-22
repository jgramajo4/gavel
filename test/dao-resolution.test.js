const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DaoResolutionCode,
  DaoResolutionError,
  daoProposalKey,
  resolveDaoContext,
} = require("../packages/core");

const resolve = (explicitDao, followedDaos) => resolveDaoContext({ explicitDao, followedDaos });
const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    assert.ok(error instanceof DaoResolutionError, "must be a DaoResolutionError");
    return error.code;
  }
};

test("a single followed DAO resolves an omitted --dao", () => {
  // Unambiguous: there is exactly one governance system it could mean.
  assert.equal(resolve(undefined, ["nouns"]).dao, "nouns");
  assert.equal(resolve(undefined, ["nouns"]).source, "sole-followed");
  // And it is not Nouns by privilege -- ENS alone resolves to ENS.
  assert.equal(resolve(undefined, ["ens"]).dao, "ens");
  assert.equal(resolve(undefined, ["railgun-eth"]).dao, "railgun-eth");
  // A duplicate entry is still one DAO, not a conflict with itself.
  assert.equal(resolve(undefined, ["ens", "ens"]).dao, "ens");
});

test("several followed DAOs make an omitted --dao an error, never a guess", () => {
  const code = codeOf(() => resolve(undefined, ["nouns", "ens"]));
  assert.equal(code, DaoResolutionCode.AMBIGUOUS_DAO);
  try {
    resolve(undefined, ["nouns", "ens"]);
  } catch (error) {
    // Actionable: it names the candidates and the flag to pass.
    assert.match(error.message, /multiple DAOs are followed: nouns, ens/);
    assert.match(error.message, /--dao <id>/);
    assert.deepEqual(error.detail.followedDaos, ["nouns", "ens"]);
  }
  // Specifically: it does not fall back to Nouns, nor to configuration order.
  assert.equal(codeOf(() => resolve(undefined, ["ens", "nouns"])), DaoResolutionCode.AMBIGUOUS_DAO);
  assert.equal(codeOf(() => resolve(undefined, ["railgun-eth", "ens"])), DaoResolutionCode.AMBIGUOUS_DAO);
});

test("an explicit DAO always wins, and is validated", () => {
  assert.equal(resolve("ens", ["nouns", "ens"]).dao, "ens");
  assert.equal(resolve("ens", ["nouns"]).dao, "ens");
  assert.equal(resolve("ens", []).dao, "ens");
  assert.equal(resolve("ENS", ["nouns"]).dao, "ens");
  assert.equal(resolve("ens", ["nouns", "ens"]).source, "explicit");
  assert.equal(codeOf(() => resolve("ghost-dao", ["nouns"])), DaoResolutionCode.UNKNOWN_DAO);
});

test("following nothing is a setup error that says how to fix it", () => {
  const code = codeOf(() => resolve(undefined, []));
  assert.equal(code, DaoResolutionCode.NO_DAO_CONFIGURED);
  try {
    resolve(undefined, []);
  } catch (error) {
    assert.match(error.message, /gavel daos follow <id>/);
  }
});

test("a sole followed DAO this build does not know cannot become the default", () => {
  // A removed adapter or a hand-edited config must not silently resolve.
  assert.equal(codeOf(() => resolve(undefined, ["ghost-dao"])), DaoResolutionCode.UNKNOWN_DAO);
});

test("proposal 123 exists independently in Nouns and in ENS", () => {
  // The reason an omitted DAO cannot be guessed: the same number is two
  // different proposals, and they never collide once keyed by DAO.
  const nouns = daoProposalKey("nouns", 123);
  const ens = daoProposalKey("ens", 123);
  assert.notEqual(nouns, ens);
  assert.equal(nouns, "nouns:123");
  assert.equal(ens, "ens:123");

  const seen = new Map([[nouns, "Nouns treasury transfer"], [ens, "ENS treasury swap"]]);
  assert.equal(seen.size, 2);
  assert.equal(seen.get(daoProposalKey("ens", "123")), "ENS treasury swap");
});
