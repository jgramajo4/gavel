/**
 * Where the DAO catalog meets the DAO adapters.
 *
 * Core cannot import an adapter -- that boundary is asserted in
 * test/architecture-boundaries.test.js and it is what keeps governance logic
 * out of the execution layer. But *something* has to know that the catalog id
 * "ens" means the ENS adapter class, and previously that something was a
 * private function inside the CLI, which is why the TUI had no way to ask.
 *
 * This package is that something, and nothing else. It holds no governance
 * logic: it constructs adapters, checks each one against the catalog's claims
 * about it, and hands back a registry.
 */

const {
  DaoRegistry,
  assertDescriptorMatchesAdapter,
  getDaoDescriptor,
  listDaoDescriptors,
  listDaoIds,
} = require("@gavel/core");
const { NounsDaoAdapter } = require("@gavel/nouns-adapter");
const { EnsDaoAdapter } = require("@gavel/ens-adapter");
const { RailgunDaoAdapter } = require("@gavel/railgun-adapter");

/** Catalog id -> constructor. The only table of its kind in the monorepo. */
const ADAPTER_CONSTRUCTORS = Object.freeze({
  nouns: NounsDaoAdapter,
  ens: EnsDaoAdapter,
  "railgun-eth": RailgunDaoAdapter,
});

/**
 * Build one adapter.
 *
 * The catalog check runs on every construction rather than once at import: an
 * adapter's capabilities are set in its constructor, so this is the first
 * moment the claim can actually be verified, and a drift between the two is a
 * bug that would otherwise surface as a UI offering an impossible option.
 */
function createDaoAdapter(dao, options = {}) {
  const descriptor = getDaoDescriptor(dao);
  const Adapter = ADAPTER_CONSTRUCTORS[descriptor.id];
  if (!Adapter) {
    throw new Error(`No adapter is wired for ${descriptor.id} in this build`);
  }
  const adapter = new Adapter({ ...options });
  assertDescriptorMatchesAdapter(adapter);
  return adapter;
}

/**
 * Build a registry for a set of DAOs.
 *
 * One DAO failing to construct does not fail the rest. A governance client
 * that follows three DAOs must open when one adapter cannot be built, so the
 * failure is returned as data and the caller decides what to do with it.
 */
function buildDaoRegistry(daoIds, options = {}) {
  const registry = new DaoRegistry();
  const failures = [];
  for (const id of daoIds) {
    try {
      registry.register(createDaoAdapter(id, options));
    } catch (error) {
      failures.push({ dao: id, message: error.message });
    }
  }
  return { registry, failures };
}

/** Which catalog DAOs this build can actually construct. */
function listWiredDaos() {
  return listDaoDescriptors().map((descriptor) => ({
    ...descriptor,
    wired: Boolean(ADAPTER_CONSTRUCTORS[descriptor.id]),
  }));
}

module.exports = {
  ADAPTER_CONSTRUCTORS,
  buildDaoRegistry,
  createDaoAdapter,
  listWiredDaos,
  listDaoIds,
};
