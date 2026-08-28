#!/usr/bin/env node

process.stderr.write(
  "Deprecated voter-skill path: forwarding to the builder-only rewards admin tool.\n",
);
require("../../tools/admin/nouns-rewards/update.js");
