# Gavel landing page

A static public landing page. No framework, build step, runtime dependencies,
remote fonts, images, analytics, or API calls. The product interface and its
history are explicitly illustrative; this page does not connect to a wallet or
generate real recommendations.

## Preview

From the repository root:

```bash
python -m http.server 4173 --bind 127.0.0.1 --directory website
```

Open <http://127.0.0.1:4173>. Opening `index.html` directly also works; browsers
may disable clipboard access for local files, in which case Copy selects the
command and announces manual-copy instructions.

## Files and design

- `index.html`: the complete narrative, sample review packet, runtime commands,
  architecture, safety disclosures, roadmap, and social metadata.
- `styles.css`: shared charcoal/bone/brass/sage tokens, editorial typography,
  precedent trails, intentional mobile layouts, focus states, and reduced motion.
- `script.js`: progressively enhanced, keyboard-operable runtime tabs and
  clipboard feedback. All runtime instructions remain available without JS.
- `favicon.svg`: an original block-built G, also used inline as the brand mark.

The repeating vertical precedent line is the visual signature. Recent evidence
uses brass, historical evidence recedes, and review gates remain separate from
recommendations. Georgia supplies the editorial accent; all fonts are local
system stacks. Layout mixes open text, thin rules, an evidence timeline, and
structured interface surfaces instead of repeated rounded cards.

The four served assets total about 55 KB uncompressed and 16 KB individually
gzipped. JavaScript is about 2.8 KB raw / 1.1 KB gzip. There is no hydration,
font swap, animation library, tracker, or persistent browser storage. Motion is
a single evidence-to-recommendation entrance, disabled under reduced motion.

## Product-copy evidence

Reviewed against repository commit
`7b90ad363e80dcfd5dfc13b4d8bd63883bf40cb8` and the maintainer's clarification.

| Claim / command | Source |
| --- | --- |
| Product identity, Nouns first, runtime choices, CLI setup | [`../README.md`](../README.md) |
| Layered authority, 365-day recency default | [`PROFILE_MODEL.md`](../docs/PROFILE_MODEL.md) |
| Personal precedents, deterministic similarity, heuristic score, draft limits | [`PREDICTION_ENGINE.md`](../docs/PREDICTION_ENGINE.md) |
| Quarantined prose, structural inspection limits | [`PROPOSAL_SECURITY.md`](../docs/PROPOSAL_SECURITY.md) |
| Unsigned preparation, review, chain checks, fail-closed behavior | [`PREPARE_VOTE.md`](../docs/PREPARE_VOTE.md) |
| Runtime-owned storage; no public agent profile | [`PROFILE_STORAGE.md`](../docs/storage/PROFILE_STORAGE.md) |
| Exact Hermes install command and first-use bootstrap | [`runtime.md`](../integrations/hermes/references/runtime.md), [`SKILL.md`](../integrations/hermes/SKILL.md) |
| Bankr skill installation and private artifact lifecycle | [`README.md`](../integrations/bankr/README.md), [`bankr-runtime.md`](../nouns-dao/references/bankr-runtime.md) |
| BYOH JSON and error contract | [`generic-cli.md`](../docs/runtimes/generic-cli.md) |
| TUI commands and architecture (status updated by maintainer) | [`TUI README`](../packages/tui/README.md), [`migration`](../docs/architecture/TUI_MIGRATION.md) |
| One core and reserved server boundary | [`architecture`](../docs/architecture/MONOREPO_AUDIT_AND_PLAN.md), [`server`](../packages/server/README.md) |
| Safe proposer-only and WaaP scaffold | [`safe.md`](../docs/execution/safe.md), [`waap.md`](../docs/execution/waap.md) |
| Model figures and unverified mainnet-fork positive path | [`PHASE9_LAUNCH_READINESS.md`](../docs/PHASE9_LAUNCH_READINESS.md) |

On September 3, 2026, the maintainer confirmed completed Bankr end-to-end testing
and BYOH/Hermes readiness. The page incorporates this newer statement instead
of repeating the stale Bankr runtime blockers in the launch-readiness document.
The maintainer subsequently confirmed completion of the TUI integration and
provided the Bankr install-or-update instruction now shown in the copy control.
The public page simply labels this runtime “TUI.”
This is maintainer-reported runtime validation, not a claim that this website
change repeated those live tests or closed the separate model/mainnet gates.

Deliberately bounded claims:

- No claim of general autonomous voting, calibrated probability for the sample
  score, production-ready supervised V1, or model superiority.
- Calibrated scores require eligible chronological-backtest evidence;
  calibration still does not authorize observed-behavior autonomy.
- Safe uses a host-supplied proposer client and human owner approval.
- WaaP is a scoped executor scaffold with no bundled live broadcaster.
- The TUI uses the canonical engine, per the maintainer’s completion update.
  Review and wallet approval remain separate boundaries.
- Headless CLI jobs exist; an HTTP service and additional DAO adapters do not.
- Private storage is host-controlled; no claim of built-in encryption or
  automatic cross-runtime profile sync.

## Verification

Verified in Chromium/Edge at 1440, 1024, 768, 390, 375, and 320 px, with all
five runtime panels checked for document overflow. Desktop and mobile captures
were visually reviewed, including the install panel and the layered model.

- Tabs: Left/Right, Home/End, wraparound, automatic activation, roving tab order,
  direct fragment selection, and visible focus.
- Copy: keyboard activation, exact clipboard contents, live announcement, and
  denied-clipboard selection fallback.
- Native safety disclosures: Enter and Space activation.
- Reduced motion: no entrance animation or smooth scrolling.
- 200% root text size at 720 px: no horizontal page overflow.
- JavaScript disabled: all runtime sections visible, native links usable,
  inactive copy buttons hidden.
- All internal anchors, unique IDs, local assets, and linked repository paths
  checked; no browser JavaScript errors.
- `node --check website/script.js` passes.
- `npm test`: 94 pass, 0 fail, 1 opt-in mainnet-fork test skipped.

The Hermes bootstrap test references a commit outside the default branch's
ancestry. For a fresh clone that reports `not our ref`, fetch the exact existing
runtime pin before rerunning that test:

```bash
git fetch origin a1a88a837350d86f0df9ba8e5f774e3914191d7a
```

No core, integration, or package dependency change was needed for the website.

## Deployment

Recommended: **Cloudflare Pages**, connected to this repository. Use framework
preset **None**, repository root as the root directory, build command `exit 0`,
and output directory `website`. There is nothing to compile. See the
[official static HTML guide](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/).

Other hosts can serve these same four files:

- **GitHub Pages:** use a custom Pages Actions workflow to upload `website`.
  Branch-based Pages only exposes the repository root or `docs`, so a custom
  workflow preserves this directory structure. See
  [GitHub's workflow guide](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
- **Netlify:** publish directory `website`, no build command. A manual upload of
  the four public files works without a package installation step.

Relative asset paths support a project subpath as well as a root domain. No
production domain was supplied, so the repository does not invent `canonical`
or `og:url`. Set both to the final absolute URL when the public host is chosen.
The title, description, Open Graph and Twitter text metadata, theme color, and
SVG favicon are already present. No social-preview raster image is required.

Publish only the four public assets; this README is implementation documentation.
