/**
 * Resolving which DAO a command is about.
 *
 * Every CLI handler used to carry `--dao` with `default: "nouns"`, which is
 * the single-DAO assumption in its most dangerous form: once a user follows
 * both Nouns and ENS, `gavel proposal 123` silently meant *Nouns* 123, and
 * `ens:123` is a different proposal that exists at the same time. An omitted
 * flag must never be read as a vote for one governance system over another.
 *
 * So resolution is one function with one policy, used by every command:
 *
 *   explicit --dao        use it, after catalog validation
 *   one followed DAO      unambiguous, so resolve to it
 *   several followed      refuse, and name them
 *   none followed         refuse, and say how to follow one
 *
 * Refusing is the point. "Pick the first one" and "pick Nouns" are both ways
 * of guessing which governance system the user meant, and a wrong guess here
 * is a vote in the wrong DAO.
 */

const { getDaoDescriptor, isKnownDao, listDaoIds } = require("./catalog");

/** How the DAO was decided. Carried so a caller can explain itself. */
const DaoResolutionSource = Object.freeze({
  EXPLICIT: "explicit",
  SOLE_FOLLOWED: "sole-followed",
});

const DaoResolutionCode = Object.freeze({
  UNKNOWN_DAO: "UNKNOWN_DAO",
  AMBIGUOUS_DAO: "AMBIGUOUS_DAO",
  NO_DAO_CONFIGURED: "NO_DAO_CONFIGURED",
});

class DaoResolutionError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "DaoResolutionError";
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}

/**
 * Decide the DAO for one command invocation.
 *
 * `followedDaos` is the user's configuration, not a fallback list to scan:
 * it is consulted only to see whether exactly one candidate exists.
 */
function resolveDaoContext(input = {}) {
  const explicit = typeof input.explicitDao === "string" ? input.explicitDao.trim().toLowerCase() : "";
  const followed = (input.followedDaos || []).map((id) => String(id || "").trim().toLowerCase()).filter(Boolean);

  if (explicit !== "") {
    if (!isKnownDao(explicit)) {
      throw new DaoResolutionError(
        DaoResolutionCode.UNKNOWN_DAO,
        `Unknown DAO: ${explicit}. Known DAOs: ${listDaoIds().join(", ")}.`,
        { dao: explicit },
      );
    }
    return { dao: explicit, descriptor: getDaoDescriptor(explicit), source: DaoResolutionSource.EXPLICIT };
  }

  // Deduplicate before counting, so a config listing a DAO twice is still
  // unambiguous rather than reported as a conflict with itself.
  const candidates = [...new Set(followed)];
  const known = candidates.filter((id) => isKnownDao(id));

  if (candidates.length === 0) {
    throw new DaoResolutionError(
      DaoResolutionCode.NO_DAO_CONFIGURED,
      "No DAO is configured. Follow one with `gavel daos follow <id>`, or pass --dao <id>. " +
        `Known DAOs: ${listDaoIds().join(", ")}.`,
      { followedDaos: [] },
    );
  }

  if (candidates.length > 1) {
    throw new DaoResolutionError(
      DaoResolutionCode.AMBIGUOUS_DAO,
      `DAO is required because multiple DAOs are followed: ${candidates.join(", ")}. Pass --dao <id>.`,
      { followedDaos: candidates },
    );
  }

  // Exactly one followed DAO, and it must still be one the catalog knows: a
  // config naming a removed adapter cannot silently become the default.
  const [only] = candidates;
  if (known.length !== 1) {
    throw new DaoResolutionError(
      DaoResolutionCode.UNKNOWN_DAO,
      `The only followed DAO (${only}) is not supported by this build. ` +
        `Pass --dao <id>, or follow a supported DAO. Known DAOs: ${listDaoIds().join(", ")}.`,
      { dao: only },
    );
  }
  return { dao: only, descriptor: getDaoDescriptor(only), source: DaoResolutionSource.SOLE_FOLLOWED };
}

/**
 * The canonical way to name a proposal on a command line: `--dao <id> <proposalId>`.
 *
 * Returned as an array so a caller renders it without re-deriving the flag
 * order, and so the TUI and the CLI cannot drift on what a copyable command
 * looks like.
 */
function daoCommandArgs(dao) {
  return ["--dao", getDaoDescriptor(dao).id];
}

module.exports = {
  DaoResolutionCode,
  DaoResolutionError,
  DaoResolutionSource,
  daoCommandArgs,
  resolveDaoContext,
};
