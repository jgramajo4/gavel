/**
 * EAS attestation writes for Nouns Passport (Schema 1 & Schema 2). All writes
 * go through EAS.attest() with the appropriate schema UID and resolver. The
 * AttestationRequestData struct is ABI-encoded manually — no EAS SDK.
 *
 * No clientId 38 here: EAS attest() is not a rewards-eligible function.
 */
import type { PublicClient } from 'viem';
import { zeroAddress } from 'viem';
import { ADDRESSES, SCHEMA_UIDS, SCHEMA_DEFINITIONS } from '../constants.js';
import { easAbi } from '../chain/abis.js';
import { encodeSchemaData } from '../utils/schemaEncoder.js';
import type { Signer } from '../chain/clients.js';
import type { TxResult } from './vote.js';

const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

function assertSchemaConfigured(uid: string, name: string): void {
  if (!/[1-9a-f]/i.test(uid.replace(/0x0*/, ''))) {
    throw new Error(
      `${name} schema UID is not configured (still zero). Set it in constants.ts once the schema is registered on-chain.`,
    );
  }
}

async function attest(
  publicClient: PublicClient,
  signer: Signer,
  schemaUid: `0x${string}`,
  encodedData: `0x${string}`,
  opts: { recipient?: `0x${string}`; revocable?: boolean; refUID?: `0x${string}` } = {},
): Promise<TxResult> {
  const request = {
    schema: schemaUid,
    data: {
      recipient: opts.recipient ?? zeroAddress,
      expirationTime: 0n,
      revocable: opts.revocable ?? true,
      refUID: opts.refUID ?? ZERO_BYTES32,
      data: encodedData,
      value: 0n,
    },
  } as const;

  const hash = await signer.walletClient.writeContract({
    account: signer.walletClient.account!,
    chain: signer.walletClient.chain,
    address: ADDRESSES.EAS as `0x${string}`,
    abi: easAbi,
    functionName: 'attest',
    args: [request],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return {
    hash,
    status: receipt.status,
    gasUsed: receipt.gasUsed,
    blockNumber: receipt.blockNumber,
  };
}

/** Schema 2 — a Noun holder verifies or disputes a builder milestone. */
export interface PeerVerificationInput {
  milestoneUID: `0x${string}`;
  propId: bigint;
  verified: boolean;
  comment: string;
}

export async function attestPeerVerification(
  publicClient: PublicClient,
  signer: Signer,
  input: PeerVerificationInput,
): Promise<TxResult> {
  assertSchemaConfigured(SCHEMA_UIDS.peerVerification, 'Peer Verification');
  const data = encodeSchemaData(SCHEMA_DEFINITIONS.peerVerification, {
    milestoneUID: input.milestoneUID,
    propId: input.propId,
    verified: input.verified,
    comment: input.comment,
  });
  return attest(
    publicClient,
    signer,
    SCHEMA_UIDS.peerVerification as `0x${string}`,
    data,
    { revocable: true, refUID: input.milestoneUID },
  );
}

/** Schema 1 — a prop update admin submits a builder milestone. */
export interface BuilderMilestoneInput {
  propId: bigint;
  milestoneTitle: string;
  evidenceURI: string;
  isFinal: boolean;
  propdateTxHash: `0x${string}`;
}

export async function attestBuilderMilestone(
  publicClient: PublicClient,
  signer: Signer,
  input: BuilderMilestoneInput,
): Promise<TxResult> {
  assertSchemaConfigured(SCHEMA_UIDS.builderMilestone, 'Builder Milestone');
  const data = encodeSchemaData(SCHEMA_DEFINITIONS.builderMilestone, {
    propId: input.propId,
    milestoneTitle: input.milestoneTitle,
    evidenceURI: input.evidenceURI,
    isFinal: input.isFinal,
    propdateTxHash: input.propdateTxHash,
  });
  // The resolver auto-mints/refreshes the Schema 3 Builder Passport in the same tx.
  return attest(
    publicClient,
    signer,
    SCHEMA_UIDS.builderMilestone as `0x${string}`,
    data,
    { recipient: signer.address, revocable: false },
  );
}

