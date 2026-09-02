# License audit

Audit date: 2026-09-02.

The Gavel root package previously declared MIT without a `LICENSE` file. The
target license is now `GPL-3.0-only`, with the full license text at the repository
root. The separately audited `jgramajo4/Gavel-TUI` repository declares
`GPL-3.0-or-later` and includes the GPL v3 text, so consolidation into a GPL-3.0
Gavel monorepo presents no apparent repository-license conflict.

Installed Gavel runtime dependencies report MIT licenses, except `tslib` (0BSD):
`ethers`, `zod`, `@adraffy/ens-normalize`, `@noble/curves`, `@noble/hashes`,
`@types/node`, `aes-js`, `undici-types`, and `ws` are MIT. The audited TUI lockfile
contains MIT, ISC, BSD-2-Clause, Apache-2.0, and `(MIT OR CC0-1.0)` packages.
These are permissive and no incompatibility with the intended GPL distribution
was found.

This is a repository engineering audit, not legal advice. Re-run the audit when
adding Safe, WaaP, server, or TUI runtime dependencies.
