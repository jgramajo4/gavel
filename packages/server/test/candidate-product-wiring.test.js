const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Wallet } = require('ethers');
const { candidateTargetId } = require('@gavel/gate');

const { MemoryGateStore } = require('../src/gate/store-memory');
const { PostgresGateStore } = require('../src/gate/store');
const { createNounsIndexClient } = require('../src/gate/index-client');
const { createQuoteSigner } = require('../src/gate/quote-signer');
const { createSubmissionService } = require('../src/gate/submission-service');

const VOTER = '0x1111111111111111111111111111111111111111';
const PAYER = '0x3333333333333333333333333333333333333333';
const PROPOSER = `0x${'aa'.repeat(20)}`;
const TARGET = candidateTargetId(PROPOSER, 'fund nouns');
const BLOCK_HASH = `0x${'cc'.repeat(32)}`;
const CONTENT_HASH = `0x${'dd'.repeat(32)}`;
const CODE_HASH = `0x${'ee'.repeat(32)}`;
const SPLITTER = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const GAVEL = '0x4444444444444444444444444444444444444444';
const SIGNER_KEY = `0x${'7'.repeat(64)}`;
const SIGNER_ADDRESS = new Wallet(SIGNER_KEY).address;
const NOW = new Date('2026-09-18T00:10:00.000Z');

function policy(overrides = {}) {
  return {
    dao: 'nouns', chainId: '1', enabled: true, acceptPreVote: true, acceptVoting: false,
    attentionAmount: '1000000', tags: [], ...overrides,
  };
}

function request(overrides = {}) {
  return {
    dao: 'nouns', targetId: TARGET, stage: 'PRE_VOTE', position: 'SPONSOR',
    pitch: 'Please sponsor this candidate.', disclosures: 'None.', evidenceUrls: [], ...overrides,
  };
}

test('memory and Postgres policy validation persist PRE_VOTE and VOTING flags independently', async () => {
  const memory = new MemoryGateStore({ clock: () => NOW });
  await memory.mutateProfile({
    profile: { id: 'profile-1', wallet: VOTER, availability: 'accepting_now' },
    policy: policy(),
  });
  assert.deepEqual(await memory.getPolicy('profile-1', 'nouns'), {
    profileId: 'profile-1', ...policy(), pendingReservationCapacity: 12, settledCapacity: 25,
  });

  const calls = [];
  const postgres = new PostgresGateStore({ pool: {
    async connect() {
      return {
        async query(sql, params) {
          calls.push([sql, params]);
          if (/FROM gate\.mutate_profile/.test(sql)) return { rows: [{ id: 'profile-1' }] };
          return { rows: [] };
        },
        release() {},
      };
    },
    async query() { return { rows: [] }; },
  } });
  await postgres.mutateProfile({ profile: { id: 'profile-1', wallet: VOTER }, policy: policy({ acceptVoting: true }) });
  const payload = calls.flatMap(([, params]) => params || []).find((value) => typeof value === 'string' && value.includes('acceptPreVote'));
  assert.deepEqual(JSON.parse(payload), {
    ...policy({ acceptVoting: true }), pendingReservationCapacity: 12, settledCapacity: 25,
  });
});

test('index client reads and validates a dedicated candidate target snapshot', async () => {
  const calls = [];
  const source = {
    async getHealth() { return { healthy: true, refreshedAt: '2026-09-18T00:09:00.000Z' }; },
    async getTarget(dao, targetId) {
      calls.push([dao, targetId]);
      return {
        dao, targetId, kind: 'candidate', proposer: PROPOSER, slug: 'fund nouns', nativeState: 'ACTIVE',
        eligibility: 'PRE_VOTE', mappingVersion: 'nouns-candidate-lifecycle/1',
        refreshedAt: '2026-09-18T00:09:00.000Z', sourceBlock: '123', sourceBlockHash: BLOCK_HASH,
        contentHash: CONTENT_HASH, actions: [],
      };
    },
  };
  const client = createNounsIndexClient({ source, clock: () => NOW });
  assert.deepEqual(await client.getTargetSnapshot(TARGET), {
    dao: 'nouns', targetId: TARGET, kind: 'candidate', proposer: PROPOSER, slug: 'fund nouns',
    nativeState: 'ACTIVE', eligibility: 'PRE_VOTE', mappingVersion: 'nouns-candidate-lifecycle/1',
    refreshedAt: '2026-09-18T00:09:00.000Z', sourceBlock: '123', sourceBlockHash: BLOCK_HASH,
    contentHash: CONTENT_HASH, canonicalActions: [],
  });
  assert.deepEqual(calls, [['nouns', TARGET]]);

  source.getTarget = async () => ({
    dao: 'nouns', targetId: TARGET, kind: 'candidate', proposer: PROPOSER, slug: 'identity splice',
    nativeState: 'ACTIVE', eligibility: 'PRE_VOTE', mappingVersion: 'nouns-candidate-lifecycle/1',
    refreshedAt: '2026-09-18T00:09:00.000Z', sourceBlock: '123', sourceBlockHash: BLOCK_HASH,
    contentHash: CONTENT_HASH, actions: [],
  });
  await assert.rejects(client.getTargetSnapshot(TARGET), (error) => error.code === 'PROPOSAL_IDENTITY_MISMATCH' && error.statusCode === 409);

  source.getTarget = async () => ({
    dao: 'nouns', targetId: TARGET, kind: 'candidate', proposer: PROPOSER, slug: 'fund nouns',
    nativeState: 'CANCELED', eligibility: 'CLOSED', mappingVersion: 'nouns-candidate-lifecycle/1',
    refreshedAt: '2026-09-18T00:09:00.000Z', sourceBlock: '124', sourceBlockHash: BLOCK_HASH,
    contentHash: CONTENT_HASH, actions: [],
  });
  assert.equal(await client.getTargetLifecycle(TARGET), 'CLOSED');
  await assert.rejects(client.getTargetSnapshot(TARGET), /eligible/i);

  source.getTarget = async () => ({
    dao: 'nouns', targetId: TARGET, kind: 'candidate', proposer: PROPOSER, slug: 'fund nouns',
    nativeState: 'ACTIVE', eligibility: 'VOTING', mappingVersion: 'nouns-candidate-lifecycle/1',
    refreshedAt: '2026-09-18T00:09:00.000Z', sourceBlock: '123', sourceBlockHash: BLOCK_HASH,
    contentHash: CONTENT_HASH, actions: [],
  });
  await assert.rejects(client.getTargetSnapshot(TARGET), /unavailable|eligibility|candidate/i);
});

test('candidate quote requires canonical PRE_VOTE and an accepting profile, and persists sponsorship facts', async () => {
  const store = new MemoryGateStore({ clock: () => NOW });
  await store.mutateProfile({
    profile: { id: 'profile-1', wallet: VOTER, walletKind: 'eoa', availability: 'accepting_now' },
    policy: policy(),
  });
  await store.configureDeployment({
    id: 'deployment-1', chainId: '8453', splitter: SPLITTER, signer: SIGNER_ADDRESS, token: TOKEN,
    gavelRecipient: GAVEL, contractCodeHash: CODE_HASH, deploymentBlock: '0', nextBlock: '0',
    issuanceActive: true, config: { environment: 'production' }, rpcAccess: {},
  });
  let eligibility = 'PRE_VOTE';
  const service = createSubmissionService({
    store,
    indexClient: { async getTargetSnapshot(targetId) {
      return {
        dao: 'nouns', targetId, kind: 'candidate', proposer: PROPOSER, slug: 'fund nouns',
        nativeState: 'ACTIVE', eligibility, mappingVersion: 'nouns-candidate-lifecycle/1',
        refreshedAt: '2026-09-18T00:09:00.000Z', sourceBlock: '123', sourceBlockHash: BLOCK_HASH,
        contentHash: CONTENT_HASH, canonicalActions: [],
      };
    } },
    quoteSigner: createQuoteSigner({ signer: SIGNER_KEY, chainId: 8453, splitter: SPLITTER }),
    deployment: { id: 'deployment-1', chainId: 8453, splitter: SPLITTER, token: TOKEN, codeHash: CODE_HASH },
    basePayerCodeReader: async () => '0x', clock: () => NOW,
  });
  const session = { wallet: PAYER, role: 'base_sender' };
  const result = await service.createSubmission({ session, voterWallet: VOTER, request: request() });
  assert.equal(result.state, 'payment_required');
  const [item] = await store.listInboxItems('profile-1');
  assert.equal(item, undefined, 'quote issuance does not construct a vote transaction or inbox before settlement');
  const quote = await store.findSettlementQuote(result.quote.message.quoteId);
  assert.equal(quote.targetId, TARGET);
  assert.equal(Object.hasOwn(quote, 'proposalId'), false);
  assert.deepEqual(quote.trustedSummary, {
    subject: 'Candidate sponsorship pitch ready',
    text: 'Open your private Gate inbox to review the candidate sponsorship request.',
  });

  const closedStore = new MemoryGateStore({ clock: () => NOW });
  await closedStore.mutateProfile({ profile: { id: 'profile-2', wallet: VOTER, availability: 'accepting_now' },
    policy: policy({ acceptPreVote: false, acceptVoting: true }) });
  eligibility = 'CLOSED';
  await assert.rejects(service.createSubmission({ session: { wallet: `0x${'55'.repeat(20)}`, role: 'base_sender' },
    voterWallet: VOTER, request: request({ pitch: 'another' }) }), /accept|eligible/i);
});

test('Gate migration supports both exact target identity and PRE_VOTE inbox lifecycle', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/001_gate.sql'), 'utf8');
  assert.match(sql, /target_id text NOT NULL/i);
  assert.match(sql, /proposal_id numeric\(78,0\)(?! NOT NULL)/i);
  assert.match(sql, /accept_pre_vote = true OR accept_voting = true/i);
  assert.match(sql, /issuance_lifecycle IN\('PRE_VOTE','VOTING'\)/i);
});
