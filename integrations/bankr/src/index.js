"use strict";

/**
 * Bankr <-> Gavel Gate advocate client.
 *
 * Bankr is the advocate/payer client. It is not the settlement authority: Gate
 * owns quote issuance, eligibility, capacity, lifecycle, settlement
 * verification, and inbox creation, and nothing in this package can override
 * any of them.
 */
module.exports = {
  ...require("./errors"),
  ...require("./config"),
  ...require("./format"),
  ...require("./gate-api"),
  ...require("./index-api"),
  ...require("./targets"),
  ...require("./discovery"),
  ...require("./session"),
  ...require("./quote"),
  ...require("./submission"),
  ...require("./wallet"),
  ...require("./splitter"),
  ...require("./relayer"),
  ...require("./remote-relay"),
  ...require("./payment"),
  ...require("./settlement"),
  ...require("./flow"),
};
