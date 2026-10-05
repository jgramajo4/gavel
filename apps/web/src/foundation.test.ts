import { describe, expect, it } from 'vitest';
import { ConfigError, resolveConfig } from './config';
import { legacyGateTarget, paths } from './routes';
import { DAOS, findDao, findSection, sectionsOf, CAPABILITIES } from './daos';
import { createIndexApi, newestFirst } from './index-api';
import { classify } from './http';
import { stubFetch } from './test/harness';
import { AGENTS, HOSTED, SELF_HOST, RECIPES } from './install';

const PROD = { production: true };
const GOOD = {
  VITE_GAVEL_GATE_API_URL: 'https://api-mainnet.0773h.com',
  VITE_GAVEL_INDEX_API_URL: 'https://index.0773h.com',
};

describe('frontend configuration', () => {
  it('accepts bare HTTPS origins in production', () => {
    expect(resolveConfig(GOOD, PROD)).toEqual({
      gateApiUrl: 'https://api-mainnet.0773h.com',
      indexApiUrl: 'https://index.0773h.com',
    });
  });

  it('fails a production build that is missing either API origin, rather than defaulting', () => {
    expect(() => resolveConfig({ ...GOOD, VITE_GAVEL_GATE_API_URL: '' }, PROD)).toThrow(/VITE_GAVEL_GATE_API_URL/);
    expect(() => resolveConfig({ ...GOOD, VITE_GAVEL_INDEX_API_URL: undefined }, PROD)).toThrow(/VITE_GAVEL_INDEX_API_URL/);
    expect(() => resolveConfig({}, PROD)).toThrow(ConfigError);
  });

  it.each([
    'http://index.0773h.com',
    'https://index.0773h.com/v1',
    'https://index.0773h.com?x=1',
    'https://user:pw@index.0773h.com',
    'index.0773h.com',
    'javascript:alert(1)',
  ])('refuses malformed origin %s in production', (value) => {
    expect(() => resolveConfig({ ...GOOD, VITE_GAVEL_INDEX_API_URL: value }, PROD)).toThrow(ConfigError);
  });

  it('refuses loopback API origins in production, however they are spelled', () => {
    for (const value of [
      'https://localhost',
      'https://localhost:8080',
      'https://localhost.',
      'https://app.localhost',
      'https://127.0.0.1',
      'https://127.1.2.3:8443',
      'https://[::1]',
      'https://0.0.0.0',
    ]) {
      expect(() => resolveConfig({ ...GOOD, VITE_GAVEL_GATE_API_URL: value }, PROD), value).toThrow(/loopback/);
      expect(() => resolveConfig({ ...GOOD, VITE_GAVEL_INDEX_API_URL: value }, PROD), value).toThrow(/loopback/);
    }
    // Uppercase is refused too, earlier: URL lowercases the host, so the value
    // is not a bare origin as written. Refused either way is what matters.
    expect(() => resolveConfig({ ...GOOD, VITE_GAVEL_GATE_API_URL: 'https://LOCALHOST' }, PROD)).toThrow(ConfigError);
    // Not loopback: a real host whose name merely contains the word.
    expect(resolveConfig({ ...GOOD, VITE_GAVEL_GATE_API_URL: 'https://localhost-api.example.com' }, PROD).gateApiUrl).toBe(
      'https://localhost-api.example.com',
    );
  });

  it('refuses the removed VITE_GATE_API_URL so a stale build env cannot silently go same-origin', () => {
    expect(() => resolveConfig({ ...GOOD, VITE_GATE_API_URL: 'https://api.0773h.com' }, PROD)).toThrow(/renamed/);
    expect(() => resolveConfig({ VITE_GATE_API_URL: 'http://localhost:8081' }, { production: false })).toThrow(/renamed/);
  });

  it('allows same-origin and http://localhost in development only', () => {
    expect(resolveConfig({}, { production: false })).toEqual({ gateApiUrl: '', indexApiUrl: '' });
    expect(resolveConfig({ VITE_GAVEL_GATE_API_URL: 'http://127.0.0.1:8081/' }, { production: false }).gateApiUrl).toBe(
      'http://127.0.0.1:8081',
    );
  });
});

describe('legacy Gate URL mapping', () => {
  const W = '0x4444444444444444444444444444444444444444';
  it.each([
    [`/gates/${W}`, '', `/gate/voters/${W}`],
    [`/gates/${W}/`, '', `/gate/voters/${W}`],
    [`/gates/${W}/compose`, '?utm_source=x', `/gate/voters/${W}/compose?utm_source=x`],
    ['/checkout/AAAAAAAAAAAAAAAAAAAAAA', '', '/gate/checkout/AAAAAAAAAAAAAAAAAAAAAA'],
    ['/inbox', '', '/gate/inbox'],
    ['/enroll', '?', '/gate/enroll'],
  ])('%s%s → %s', (path, search, target) => {
    expect(legacyGateTarget(path, search)).toBe(target);
    // Deterministic: same input, same output.
    expect(legacyGateTarget(path, search)).toBe(legacyGateTarget(path, search));
  });

  it.each([
    '/',
    '/gates',
    '/gates/nope',
    '/gates/0x12/compose',
    '/checkout',
    '/checkout/a/b',
    '/checkout/short',
    '/checkout/..%2F..%2Fevil',
    '/checkout/AAAAAAAAAAAAAAAAAAAAA%2F',
    '/daos/nouns',
    '/inboxes',
  ])(
    'returns null for %s rather than guessing',
    (path) => {
      expect(legacyGateTarget(path)).toBeNull();
    },
  );

  it('produces targets that are canonical routes', () => {
    expect(legacyGateTarget(`/gates/${W}`)).toBe(paths.gateVoter(W));
    expect(legacyGateTarget('/inbox')).toBe(paths.gateInbox);
  });
});

describe('DAO registry', () => {
  it('has unique route ids and index ids', () => {
    expect(new Set(DAOS.map((dao) => dao.id)).size).toBe(DAOS.length);
    expect(new Set(DAOS.map((dao) => dao.indexId)).size).toBe(DAOS.length);
  });

  it('every DAO starts with overview and lists only known capabilities', () => {
    for (const dao of DAOS) {
      expect(dao.capabilities[0]).toBe('overview');
      for (const id of dao.capabilities) expect(CAPABILITIES[id]).toBeDefined();
    }
  });

  it('resolves only known DAOs and only their own sections', () => {
    expect(findDao('nouns')?.indexId).toBe('nouns');
    expect(findDao('railgun')?.indexId).toBe('railgun-eth');
    for (const bad of [undefined, '', 'NOUNS', 'railgun-eth', '../x', 'a'.repeat(70)]) expect(findDao(bad)).toBeNull();
    const ens = findDao('ens')!;
    expect(findSection(ens, undefined)?.id).toBe('overview');
    expect(findSection(ens, 'proposals')?.id).toBe('proposals');
    expect(findSection(ens, 'gate')).toBeNull();
    expect(findSection(ens, 'streams')).toBeNull();
    // Feature capabilities never become tabs.
    expect(sectionsOf(findDao('nouns')!).map((section) => section.id)).toEqual(['overview', 'proposals']);
  });
});

describe('index client', () => {
  it('projects rows without promoting raw state into the derived status', async () => {
    const index = createIndexApi(
      'https://index.example',
      stubFetch([
        {
          method: 'GET',
          match: /proposals\?limit=5$/,
          status: 200,
          body: { items: [{ id: '7', dao: 'nouns', title: 'T', state: 'ACTIVE' }], nextCursor: 'c' },
        },
      ]),
    );
    const page = await index.listProposals('nouns', { limit: 5 });
    expect(page.items[0].effectiveStatus).toBeNull();
    expect(page.items[0].sourceState).toBe('ACTIVE');
    expect(page.items[0].provenance.origin).toBe('onchain');
    expect(page.nextCursor).toBe('c');
  });

  it('refuses a row that belongs to another DAO instead of relabelling it', async () => {
    const index = createIndexApi(
      '',
      stubFetch([{ method: 'GET', match: /proposals/, status: 200, body: { items: [{ id: '7', dao: 'ens', title: 'T' }] } }]),
    );
    await expect(index.listProposals('nouns')).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE', kind: 'defect' });
  });

  it('bounds the page size and never calls the index for a malformed DAO id', async () => {
    const fetchImpl = stubFetch([{ method: 'GET', match: /proposals\?limit=100$/, status: 200, body: { items: [] } }]);
    const index = createIndexApi('', fetchImpl);
    await index.listProposals('nouns', { limit: 10_000 });
    await expect(index.listProposals('../admin')).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetchImpl.calls).toEqual(['GET /v1/daos/nouns/proposals?limit=100']);
  });

  it('sends no credentials and no auth header to the index', async () => {
    const fetchImpl = stubFetch([{ method: 'GET', match: /daos$/, status: 200, body: { items: [] } }]);
    let init: RequestInit | undefined;
    const spy = (async (input: unknown, options?: RequestInit) => {
      init = options;
      return fetchImpl(input as string, options);
    }) as typeof fetch;
    await createIndexApi('', spy).listDaos();
    expect(init?.credentials).toBe('omit');
    expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('treats a source-reported block 0 as unknown, not the genesis block', async () => {
    const index = createIndexApi(
      '',
      stubFetch([
        {
          method: 'GET',
          match: /proposals/,
          status: 200,
          body: { items: [{ id: '1', dao: 'railgun-eth', title: 'T', createdBlock: '0' }, { id: '2', dao: 'railgun-eth', title: 'U', createdBlock: '15505900' }] },
        },
      ]),
    );
    const page = await index.listProposals('railgun-eth');
    expect(page.items.map((p) => p.provenance.createdBlock)).toEqual([null, '15505900']);
  });

  it('reuses a validated page briefly, but never a failed one', async () => {
    let calls = 0;
    let fail = true;
    const fetchImpl = (async () => {
      calls += 1;
      if (fail) return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
      return new Response(JSON.stringify({ items: [{ id: '1', dao: 'ens', title: 'T' }] }), { status: 200 });
    }) as typeof fetch;
    const index = createIndexApi('', fetchImpl);
    await expect(index.listProposals('ens', { limit: 100 })).rejects.toMatchObject({ kind: 'retryable' });
    fail = false;
    await index.listProposals('ens', { limit: 100 });
    await index.listProposals('ens', { limit: 100 });
    expect(calls).toBe(2);
    await index.listProposals('ens', { limit: 5 });
    expect(calls).toBe(3);
  });

  it('orders a page newest first', () => {
    const at = (createdAt: string | null) => ({ createdAt }) as never;
    expect(newestFirst([at('2022-01-01'), at(null), at('2026-01-01')]).map((p: { createdAt: string | null }) => p.createdAt)).toEqual([
      '2026-01-01',
      '2022-01-01',
      null,
    ]);
  });
});

describe('shared error model', () => {
  it.each([
    [0, '', 'retryable'],
    [429, '', 'retryable'],
    [503, '', 'retryable'],
    [404, '', 'not_found'],
    [401, 'SESSION_EXPIRED', 'action'],
    [403, 'WRONG_ROLE', 'action'],
    [400, 'INVALID_REQUEST', 'action'],
    [200, 'MALFORMED_RESPONSE', 'defect'],
  ])('status %i %s → %s', (status, code, kind) => {
    expect(classify(status, code)).toBe(kind);
  });
});

describe('install claims', () => {
  it('never claims one step without a command, and never offers a command for an unpackaged agent', () => {
    for (const option of [...AGENTS, HOSTED, ...SELF_HOST]) {
      if (option.status === 'one_command') expect(option.command).toBeTruthy();
      if (option.status === 'not_packaged') expect(option.command).toBeUndefined();
      expect(option.source).toMatch(/^https:\/\//);
    }
    expect(AGENTS.map((agent) => agent.name)).toEqual(['Hermes', 'Bankr', 'Muse', 'Grok Bot']);
  });

  it('the Daily Brief asks only for what Gavel provides and forbids signing', () => {
    const prompt = RECIPES.find((recipe) => recipe.id === 'daily-brief')!.prompt;
    expect(prompt).toMatch(/source of truth/i);
    expect(prompt).toMatch(/do not prepare or sign/i);
    expect(prompt).not.toMatch(/calendar|forum|discord|twitter/i);
  });
});
