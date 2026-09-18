#!/usr/bin/env node
"use strict";

const { createGateObservability } = require("../src/gate/observability");

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== "settlement-reorg"
      || !new Set(["pre_acceptance", "post_acceptance"]).has(argv[1])) {
    process.stderr.write("usage: gate-observe settlement-reorg pre_acceptance|post_acceptance\n");
    return 2;
  }
  createGateObservability().recordSettlementReorg({ phase: argv[1], source: "operator" });
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { main };
