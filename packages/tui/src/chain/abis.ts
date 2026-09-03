/**
 * Minimal ABIs — only the functions Gavel actually calls. Kept hand-trimmed so
 * viem's type inference stays fast and the intent of each call is obvious.
 */

export const nounsDaoAbi = [
  // --- reads ---
  {
    type: 'function',
    name: 'proposalCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'state',
    stateMutability: 'view',
    inputs: [{ name: 'proposalId', type: 'uint256' }],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'proposalVotes',
    stateMutability: 'view',
    inputs: [{ name: 'proposalId', type: 'uint256' }],
    outputs: [
      { name: 'againstVotes', type: 'uint256' },
      { name: 'forVotes', type: 'uint256' },
      { name: 'abstainVotes', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'quorumVotes',
    stateMutability: 'view',
    inputs: [{ name: 'proposalId', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  // --- writes (rewards-eligible: pass clientId 38) ---
  {
    type: 'function',
    name: 'castRefundableVote',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'proposalId', type: 'uint256' },
      { name: 'support', type: 'uint8' },
      { name: 'clientId', type: 'uint32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'castRefundableVoteWithReason',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'proposalId', type: 'uint256' },
      { name: 'support', type: 'uint8' },
      { name: 'reason', type: 'string' },
      { name: 'clientId', type: 'uint32' },
    ],
    outputs: [],
  },
] as const;

export const nounsTokenAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getCurrentVotes',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint96' }],
  },
  {
    type: 'function',
    name: 'delegates',
    stateMutability: 'view',
    inputs: [{ name: 'delegator', type: 'address' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'delegate',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'delegatee', type: 'address' }],
    outputs: [],
  },
] as const;

export const rewardsAbi = [
  {
    type: 'function',
    name: 'clientBalance',
    stateMutability: 'view',
    inputs: [{ name: 'clientId', type: 'uint32' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'withdrawClientBalance',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'clientId', type: 'uint32' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

/**
 * EAS.attest(AttestationRequest). The request is a nested struct:
 *   AttestationRequest { bytes32 schema; AttestationRequestData data; }
 *   AttestationRequestData { address recipient; uint64 expirationTime;
 *     bool revocable; bytes32 refUID; bytes data; uint256 value; }
 */
export const easAbi = [
  {
    type: 'function',
    name: 'attest',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'request',
        type: 'tuple',
        components: [
          { name: 'schema', type: 'bytes32' },
          {
            name: 'data',
            type: 'tuple',
            components: [
              { name: 'recipient', type: 'address' },
              { name: 'expirationTime', type: 'uint64' },
              { name: 'revocable', type: 'bool' },
              { name: 'refUID', type: 'bytes32' },
              { name: 'data', type: 'bytes' },
              { name: 'value', type: 'uint256' },
            ],
          },
        ],
      },
    ],
    outputs: [{ type: 'bytes32' }],
  },
] as const;

/** NounsPassportResolver direct reads for individual builder lookups. */
export const passportResolverAbi = [
  {
    type: 'function',
    name: 'getBuilderRecord',
    stateMutability: 'view',
    inputs: [{ name: 'builder', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'totalProps', type: 'uint256' },
          { name: 'completedProps', type: 'uint256' },
          { name: 'totalMilestones', type: 'uint256' },
          { name: 'peerVerifications', type: 'uint256' },
          { name: 'avgDaysBetweenUpdates', type: 'uint256' },
          { name: 'passportVersion', type: 'uint256' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getMilestoneUIDs',
    stateMutability: 'view',
    inputs: [{ name: 'builder', type: 'address' }],
    outputs: [{ type: 'bytes32[]' }],
  },
] as const;

