import { describe, expect, it } from 'vitest';
import { createGateApi } from './api';
import { stubFetch } from './test/harness';
import { duplicateReceipt, quotedReceipt, VOTER } from './test/fixtures';

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
});
