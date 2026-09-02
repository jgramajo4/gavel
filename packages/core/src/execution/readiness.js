const { getAddress } = require("ethers");

const { assertModeSupported } = require("../dao/registry");
const { ExecutionMode, addressRolesSchema } = require("../schema/execution");

function sameAddress(left, right) {
  return getAddress(left) === getAddress(right);
}

async function resolveExecutionReadiness(input) {
  const adapter = assertModeSupported(input.adapter, input.mode);
  const modelAddress = getAddress(input.modelAddress);
  const assetOwnerAddress = input.assetOwnerAddress ? getAddress(input.assetOwnerAddress) : null;
  const executionAddress = getAddress(input.executionAddress || modelAddress);
  const requiredDelegateAddress = executionAddress;
  const delegationSourceAddress = assetOwnerAddress || modelAddress;

  let currentDelegateAddress;
  let votingPower;
  try {
    [currentDelegateAddress, votingPower] = await Promise.all([
      adapter.getCurrentDelegate(delegationSourceAddress),
      adapter.getVotingPower(executionAddress, input.blockTag),
    ]);
  } catch (error) {
    throw new Error(`Execution readiness failed closed: ${error.message}`);
  }

  const roles = addressRolesSchema.parse({
    modelAddress,
    assetOwnerAddress,
    currentDelegateAddress: currentDelegateAddress ? getAddress(currentDelegateAddress) : null,
    executionAddress,
    requiredDelegateAddress,
  });
  const delegationReady = Boolean(
    roles.currentDelegateAddress && sameAddress(roles.currentDelegateAddress, roles.requiredDelegateAddress),
  );
  const normalizedPower = BigInt(votingPower).toString();
  const hasVotingPower = BigInt(normalizedPower) > 0n;
  const autonomous = input.mode === ExecutionMode.WAAP_AUTONOMOUS;

  return {
    dao: adapter.id,
    chainId: adapter.chainId,
    mode: input.mode,
    ...roles,
    delegationSourceAddress,
    votingPower: normalizedPower,
    delegationReady,
    redelegationRequired: !delegationReady,
    canVote: delegationReady && hasVotingPower,
    autonomous,
  };
}

module.exports = { resolveExecutionReadiness, sameAddress };
