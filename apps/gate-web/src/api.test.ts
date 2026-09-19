import { describe, expect, it } from 'vitest';
import { createGateApi } from './api';
import { stubFetch } from './test/harness';
import {
  candidateInboxItem,
  duplicateReceipt,
  proposalInboxItem,
  quotedReceipt,
  VOTER,
} from './test/fixtures';

const token = 'a'.repeat(43);

describe('GateApi', () => {
  it('returns a 409 duplicate receipt instead of throwing', async () => {
    const fetchImpl = stubFetch([
      { method: 'POST', match: /\/submissions$/, status: 409, body: duplicateReceipt },
    ]);
    const api = createGateApi('', fetchImpl);
    const result = await api.createSubmission(token, VOTER, {
      dao: 'nouns',
      proposalId: '812',
      stage: 'VOTING',
      position: 'FOR',
      pitch: 'x',
      disclosures: '',
      evidenceUrls: [],
    });
    expect(result).toEqual(duplicateReceipt);
  });

  it('refuses a resume path that is not a Gate resume route', async () => {
    const api = createGateApi('', stubFetch([]));
    await expect(api.resumeSubmission(token, 'https://evil.example.com/steal')).rejects.toMatchObject({
      code: 'INVALID_RESUME_URL',
    });
  });

  it('sends the session token only as an Authorization header', async () => {
    const seen: RequestInit[] = [];
    const impl = (async (input: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      expect(String(input)).not.toContain(token);
      return { status: 200, ok: true, json: async () => quotedReceipt } as Response;
    }) as typeof fetch;
    const api = createGateApi('', impl);
    await api.resumeSubmission(token, '/v1/submissions/AAAAAAAAAAAAAAAAAAAAAA/resume');
    expect((seen[0].headers as Record<string, string>).authorization).toBe(`Bearer ${token}`);
    expect(seen[0].credentials).toBe('omit');
  });

  describe('private inbox', () => {
    const LIST = /\/v1\/gate\/me\/inbox$/;
    const ITEM = /\/v1\/gate\/me\/inbox\/[^/]+$/;
    const ARCHIVE = /\/v1\/gate\/me\/inbox\/[^/]+\/archive$/;

    it('lists the owner-bound items from the merged route', async () => {
      const impl = stubFetch([
        {
          method: 'GET',
          match: LIST,
          status: 200,
          body: { items: [candidateInboxItem, proposalInboxItem] },
        },
      ]);
      const items = await createGateApi('', impl).listInbox(token);
      expect(impl.calls).toEqual(['GET /v1/gate/me/inbox']);
      expect(items.map((item) => item.id)).toEqual(['inbox-candidate', 'inbox-proposal']);
      expect(items[0].canonicalFacts.kind).toBe('candidate');
      expect(items[0].evidenceUrls).toEqual(candidateInboxItem.evidenceUrls);
    });

    it('returns an empty list rather than throwing for an empty inbox', async () => {
      const api = createGateApi('', stubFetch([{ method: 'GET', match: LIST, status: 200, body: { items: [] } }]));
      expect(await api.listInbox(token)).toEqual([]);
    });

    it('surfaces 401 as an error instead of an empty inbox', async () => {
      const api = createGateApi(
        '',
        stubFetch([
          {
            method: 'GET',
            match: LIST,
            status: 401,
            body: { error: { code: 'UNAUTHORIZED', message: 'authentication required' } },
          },
        ]),
      );
      await expect(api.listInbox(token)).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    });

    it('rejects a body that is not the declared projection', async () => {
      const api = createGateApi('', stubFetch([{ method: 'GET', match: LIST, status: 200, body: { items: [{}] } }]));
      await expect(api.listInbox(token)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
    });

    it('fetches one item and reports a missing or foreign item as null', async () => {
      const found = stubFetch([{ method: 'GET', match: ITEM, status: 200, body: candidateInboxItem }]);
      expect((await createGateApi('', found).getInboxItem(token, 'inbox-candidate'))?.id).toBe('inbox-candidate');
      expect(found.calls).toEqual(['GET /v1/gate/me/inbox/inbox-candidate']);

      const missing = stubFetch([{ method: 'GET', match: ITEM, status: 404, body: { error: { code: 'NOT_FOUND' } } }]);
      expect(await createGateApi('', missing).getInboxItem(token, 'inbox-nope')).toBeNull();
    });

    it('encodes the item ID so it cannot escape its path segment', async () => {
      const impl = stubFetch([{ method: 'GET', match: /inbox/, status: 404, body: null }]);
      await createGateApi('', impl).getInboxItem(token, '../../gates/0x0');
      expect(impl.calls[0]).toBe('GET /v1/gate/me/inbox/..%2F..%2Fgates%2F0x0');
    });

    it('archives one item and returns what the server decided', async () => {
      const impl = stubFetch([
        { method: 'POST', match: ARCHIVE, status: 200, body: { id: 'inbox-candidate', archived: true } },
      ]);
      expect(await createGateApi('', impl).archiveInboxItem(token, 'inbox-candidate')).toEqual({
        id: 'inbox-candidate',
        archived: true,
      });
      expect(impl.calls).toEqual(['POST /v1/gate/me/inbox/inbox-candidate/archive']);
    });

    it('sends the inbox session token only as an Authorization header', async () => {
      const seen: RequestInit[] = [];
      const impl = (async (input: unknown, init?: RequestInit) => {
        seen.push(init ?? {});
        expect(String(input)).not.toContain(token);
        return { status: 200, ok: true, json: async () => ({ items: [] }) } as Response;
      }) as typeof fetch;
      await createGateApi('', impl).listInbox(token);
      expect((seen[0].headers as Record<string, string>).authorization).toBe(`Bearer ${token}`);
      expect(seen[0].credentials).toBe('omit');
      expect(seen[0].referrerPolicy).toBe('no-referrer');
    });
  });
});
