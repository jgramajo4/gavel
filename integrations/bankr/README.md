# Gavel skill for Bankr

Install the one public Gavel skill by sending Bankr exactly:

```text
install the Gavel skill from https://github.com/jgramajo4/gavel/tree/main/integrations/bankr
```

This one same-name `gavel` install exposes both personalized voter/copilot workflows and Gavel Gate discovery, advocacy, and payment. Do not use the repository-wide “install all skills” action: the repository contains other host integrations, including Hermes, that are not Bankr skills.

## Install lifecycle

**Upgrade or reinstall:** send the exact install action above again. Bankr replaces an installed skill with the same frontmatter name. Start a new conversation so the refreshed instructions load. Replacement does not authorize changes to private Gavel files.

**Inspect the installed version:** ask Bankr, “What Gavel skill version, build ID, build kind, Git SHA, and runtime ref are installed?” The skill reads `references/skill-manifest.json` and reports those fields. Compare its version and build ID to the same file on `main` at <https://github.com/jgramajo4/gavel/blob/main/integrations/bankr/references/skill-manifest.json>. A direct GitHub directory install is a source build with no Git SHA and `runtime.ref` set to `main`; it must not be described as immutable. Release packaging stamps a verified 40-character Git SHA into both `build.gitSha` and `runtime.ref`.

**Remove:** Bankr's in-Bankr skill documentation describes removing an installed skill from the **Skills** tab. It does not document a natural-language uninstall action for a GitHub-installed guest skill, so this guide does not invent one. See <https://docs.bankr.bot/skills/in-bankr/from-github/>.

## Architecture

`SKILL.md` is the umbrella router. It gives live Gate discovery priority for lobbying prompts, then selects one of two separately bounded modules:

- **Voter/copilot:** onboarding, private history and profiles, preferences, hard rules, proposal analysis, backtests, briefings, unsigned vote preparation, and delegation. Its prompt module starts at `references/voter-copilot.md`.
- **Gate advocate:** live enrolled-voter discovery, candidate/proposal targeting, quote, explicit confirmation, payment authorization, relay, and Gate-owned settlement verification. Its client reference is `references/gate-advocate-client.md` and executable client is `src/`.

The routes share one install name but not authority or private state. Voter profiles never enter Gate advocate requests. Gate quotes, payer sessions, and signatures never enter voter/copilot workflows. `nouns-dao/` remains an independently composable compatibility source tree, but users do not install it separately for the public Bankr experience.

Bankr fetches `SKILL.md` and companion files under `references/`. Every prompt, reference, and installed configuration resource is therefore inside this directory and uses no parent-directory reference. The executable Gavel application is not duplicated into the prompt package: an ephemeral Bankr task clones the runtime revision named by `references/skill-manifest.json`, installs the repository lockfile, and invokes the canonical CLI or this integration client.

## Package and build semantics

The source workspace package declares its actual runtime dependencies: public `ethers` and private workspace package `@gavel/gate`. The private package is not published. Instead, `scripts/build-artifact.js` creates a staging artifact and vendors the exact local `packages/gate` source under `vendor/gate`, rewriting only the staged dependency to `file:vendor/gate`. Source files remain deduplicated in the repository.

Create an unstamped source artifact:

```bash
node integrations/bankr/scripts/build-artifact.js --output /tmp/gavel-bankr-artifact
npm pack /tmp/gavel-bankr-artifact
```

A release process should add `--build-sha <verified-40-character-git-sha>`. The script validates and stamps that supplied SHA; it never guesses one. The source manifest remains unchanged. Inspect a built artifact directly with `node -p "require('/path/to/artifact/references/skill-manifest.json')"`.

Run package and route checks with:

```bash
node --test test/bankr-package-artifact.test.js test/gate-skill.test.js test/bankr-skill.test.js
npm run test:bankr-gate
```

## Runtime boundaries

Bankr sandboxes are ephemeral. Voter/copilot state is staged from private user files with `filesFromUserFs` and explicitly exported with `publishArtifacts` under `/gavel/data/private/`; public Agent Profiles are not private storage. Gate discovery is read-only. Gate payment uses real USDC on Base mainnet only after explicit confirmation, and Gate—not Bankr—owns quote issuance, eligibility, capacity, settlement verification, and inbox creation.

Do not call legacy direct-signing scripts from new workflows. The canonical CLI prepares validated unsigned calldata by default and does not need a private key.