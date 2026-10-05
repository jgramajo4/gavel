/**
 * What the Install page offers, as data. Each entry states exactly what the
 * repository ships today; `status` is the honesty contract:
 *
 *   one_command  a single real command or message installs it
 *   guided       real, but takes a few steps
 *   not_packaged no Gavel integration exists yet; say so, offer what does
 *
 * Adding an agent: append to AGENTS and cite the source file in `source`.
 * Never mark something `one_command` without a command that works today.
 */

export type InstallStatus = 'one_command' | 'guided' | 'not_packaged';

export interface InstallOption {
  id: string;
  name: string;
  status: InstallStatus;
  /** One sentence: what you get. */
  outcome: string;
  /** The exact command or message, when one exists. */
  command?: string;
  /** Short follow-up steps, when needed. */
  steps?: string[];
  /** Where the claim is documented. */
  source: string;
}

const REPO = 'https://github.com/jgramajo4/gavel';

export const AGENTS: readonly InstallOption[] = [
  {
    id: 'hermes',
    name: 'Hermes',
    status: 'one_command',
    outcome: 'Gavel as a persistent Hermes skill with private, runtime-owned memory.',
    command:
      'hermes skills install https://raw.githubusercontent.com/jgramajo4/gavel/main/integrations/hermes/SKILL.md --yes',
    steps: [
      'Start a new conversation and paste the Governance Brief prompt below. Gavel answers when asked; to get it every morning, schedule the prompt with Hermes’s own cron jobs.',
    ],
    source: `${REPO}/blob/main/integrations/hermes/references/runtime.md`,
  },
  {
    id: 'bankr',
    name: 'Bankr',
    status: 'one_command',
    outcome: 'One Gavel skill in Bankr for voter workflows and Gate advocacy.',
    command: 'install the Gavel skill from https://github.com/jgramajo4/gavel/tree/main/integrations/bankr',
    steps: ['Send that message to Bankr, then start a new conversation so the skill loads.'],
    source: `${REPO}/blob/main/integrations/bankr/README.md`,
  },
  {
    id: 'muse',
    name: 'Muse',
    status: 'not_packaged',
    outcome: 'No Gavel integration for Muse is packaged yet.',
    steps: ['Explore public governance here today. If your Muse setup can run shell commands, use the CLI path below.'],
    source: REPO,
  },
  {
    id: 'grok',
    name: 'Grok Bot',
    status: 'not_packaged',
    outcome: 'No Gavel integration for Grok Bot is packaged yet.',
    steps: ['Explore public governance here today. The Governance Brief prompt below needs an agent with Gavel installed.'],
    source: REPO,
  },
];

export const HOSTED: InstallOption = {
  id: 'railway',
  name: 'Hosted on Railway',
  status: 'guided',
  outcome:
    'Run Gavel’s scheduled jobs (ingestion, analysis, briefs as JSON) in the cloud without a machine of your own. A hosted Gavel HTTP service is not shipped yet.',
  steps: [
    'Create a Railway service from your fork of the repository.',
    'Mount a volume and point GAVEL_DATA_DIR at it.',
    'Schedule the CLI command you want as a Railway Cron Job.',
  ],
  source: `${REPO}#headless-on-railway`,
};

export const SELF_HOST: readonly InstallOption[] = [
  {
    id: 'cli',
    name: 'CLI',
    status: 'guided',
    outcome: 'The headless engine. JSON out, private state in a directory you choose.',
    command:
      'git clone --branch main --single-branch https://github.com/jgramajo4/gavel.git gavel\ncd gavel && npm ci\nexport GAVEL_DATA_DIR="$PWD/private/me"\nnode bin/gavel.js onboard 0xYourVoterAddress --questions',
    source: `${REPO}#readme`,
  },
  {
    id: 'tui',
    name: 'Terminal UI',
    status: 'guided',
    outcome: 'A seat at the terminal for the same engine.',
    command: 'npm ci\nnpm run tui',
    source: `${REPO}/blob/main/packages/tui/README.md`,
  },
  {
    id: 'byoh',
    name: 'Bring your own harness',
    status: 'guided',
    outcome: 'Any agent that can run a shell command can drive Gavel through its JSON CLI contract.',
    command: 'export GAVEL_STRUCTURED_ERRORS=1\nnode bin/gavel.js daos capabilities --json',
    source: `${REPO}/blob/main/docs/runtimes/generic-cli.md`,
  },
  {
    id: 'docker',
    name: 'Docker: your own Governance Indexer',
    status: 'guided',
    outcome: 'Run the indexer and its read-only API with Docker Compose instead of the public index.',
    command:
      'cp .env.example .env   # set passwords and RPC URLs\ndocker compose up -d --build postgres\ndocker compose run --rm migrate\ndocker compose run --rm indexer backfill --dao nouns\ndocker compose up -d api indexer',
    steps: ['The governance-index README has the full sequence, including ENS and Railgun backfills.'],
    source: `${REPO}/blob/main/packages/governance-index/README.md`,
  },
];

/**
 * Recipes: a prompt that shows why Gavel is worth installing. A plain data
 * shape on purpose. Future recipes (Vote Desk, Catch Me Up, Proposal Review,
 * Gate Inbox) are new entries, not new machinery.
 *
 * The prompt asks only for what Gavel provides today: proposal state and
 * attention (execution required, voting ends soon, vote open, new proposal,
 * voting opens soon), vote status, and evidence-backed recommendations. It does
 * not promise calendars, forums, or other sources Gavel cannot read.
 *
 * It is on demand: installing Gavel schedules nothing, and the web app keeps
 * no follow list. The prompt names its DAOs and voter itself, and recurring
 * delivery is the agent's own scheduler, where it has one.
 */
export interface Recipe {
  id: string;
  title: string;
  pitch: string;
  prompt: string;
}

export const RECIPES: readonly Recipe[] = [
  {
    id: 'governance-brief',
    title: 'Governance Brief',
    pitch:
      'Ask your agent whenever you want one: what needs you across the DAOs you name, and nothing that doesn’t. Want it every morning? Schedule this prompt with your agent’s own scheduler, if it has one.',
    prompt: [
      'Use Gavel to give me a governance brief for Nouns, ENS and Railgun (keep only the DAOs I care about). My voting address is <your address or ENS name>.',
      '',
      'Lead with what needs action: proposals awaiting execution, votes ending soon, and open votes I have not cast. Then new proposals from the last 24 hours and votes opening soon.',
      '',
      'Mark proposals I already voted on and keep them to one line. For anything I still need to decide, include Gavel’s recommendation and the evidence behind it, and say when that evidence is thin.',
      '',
      'Use Gavel as the source of truth for proposal state. If Gavel cannot confirm something, say so instead of guessing. Do not prepare or sign any transaction.',
    ].join('\n'),
  },
];
