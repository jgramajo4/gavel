/**
 * EAS GraphQL reads for the Nouns Passport feed. Queries the official EAS
 * indexer at easscan.org — no custom backend. Attestations are decoded against
 * the three Passport schemas by their schema UID.
 */
import type { Config } from '../config.js';
import type { Attestation } from '../types.js';
import { SCHEMA_UIDS, SCHEMA_DEFINITIONS } from '../constants.js';
import { decodeSchemaData } from '../utils/schemaEncoder.js';

const FEED_QUERY = /* GraphQL */ `
  query Feed($take: Int!, $where: AttestationWhereInput) {
    attestations(take: $take, orderBy: { time: desc }, where: $where) {
      id
      schemaId
      attester
      recipient
      refUID
      revocable
      revocationTime
      expirationTime
      time
      data
    }
  }
`;

interface RawAttestation {
  id: string;
  schemaId: string;
  attester: string;
  recipient: string;
  refUID: string;
  revocable: boolean;
  revocationTime: number;
  expirationTime: number;
  time: number;
  data: string;
}

function classify(schemaId: string): Attestation['passportType'] {
  const id = schemaId.toLowerCase();
  if (id === SCHEMA_UIDS.builderMilestone.toLowerCase()) return 'MILESTONE';
  if (id === SCHEMA_UIDS.peerVerification.toLowerCase()) return 'PEER';
  if (id === SCHEMA_UIDS.builderPassport.toLowerCase()) return 'PASSPORT';
  return 'UNKNOWN';
}

function schemaFor(type: Attestation['passportType']): string | null {
  switch (type) {
    case 'MILESTONE':
      return SCHEMA_DEFINITIONS.builderMilestone;
    case 'PEER':
      return SCHEMA_DEFINITIONS.peerVerification;
    case 'PASSPORT':
      return SCHEMA_DEFINITIONS.builderPassport;
    default:
      return null;
  }
}

function decode(raw: RawAttestation): Attestation {
  const passportType = classify(raw.schemaId);
  const schema = schemaFor(passportType);
  let decoded: Record<string, unknown> | undefined;
  if (schema && raw.data && raw.data !== '0x') {
    try {
      decoded = decodeSchemaData(schema, raw.data as `0x${string}`);
    } catch {
      decoded = undefined;
    }
  }
  return { ...raw, decoded, passportType };
}

async function query<T>(config: Config, gql: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(config.easGraphqlUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: gql, variables }),
  });
  if (!res.ok) throw new Error(`EAS GraphQL ${res.status}: ${res.statusText}`);
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`EAS error: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  if (!json.data) throw new Error('EAS: empty response');
  return json.data;
}

/**
 * Fetch the recent Passport feed. When schema UIDs are configured, filters to
 * just the three Passport schemas; otherwise returns the latest attestations
 * so the feed is never empty during setup.
 */
export async function fetchPassportFeed(config: Config, take = 25): Promise<Attestation[]> {
  const configuredSchemas = [
    SCHEMA_UIDS.builderMilestone,
    SCHEMA_UIDS.peerVerification,
    SCHEMA_UIDS.builderPassport,
  ].filter((s) => /[1-9a-f]/i.test(s.replace(/0x0*/, '')));

  const where =
    configuredSchemas.length > 0
      ? { schemaId: { in: configuredSchemas } }
      : undefined;

  const data = await query<{ attestations: RawAttestation[] }>(config, FEED_QUERY, {
    take,
    where,
  });
  return data.attestations.map(decode);
}

export async function fetchAttestation(
  config: Config,
  uid: string,
): Promise<Attestation | null> {
  const data = await query<{ attestations: RawAttestation[] }>(config, FEED_QUERY, {
    take: 1,
    where: { id: { equals: uid } },
  });
  const raw = data.attestations[0];
  return raw ? decode(raw) : null;
}

