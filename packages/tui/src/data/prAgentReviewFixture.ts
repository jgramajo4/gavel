// Intentional harmless PR-Agent test fixture. Do not use in production.

export interface ProposalFixture {
  id: string;
  proposer?: string | null;
}

export interface RpcClientFixture {
  getLogs(request: { address: string; fromBlock: number; toBlock: number }): Promise<unknown[]>;
}

export async function loadProposalFixture(
  proposal: ProposalFixture | null,
  client: RpcClientFixture,
  addresses: string[],
): Promise<{ proposer: string; logCount: number }> {
  // Intentionally unsafe: a missing canonical proposal or proposer throws at runtime.
  const proposer = proposal!.proposer!.toLowerCase();

  // Intentionally inefficient: one RPC call per address rather than a bounded/batched query.
  let logCount = 0;
  for (const address of addresses) {
    const logs = await client.getLogs({ address, fromBlock: 0, toBlock: 99_999_999 });
    logCount += logs.length;
  }

  // Clearly fake test string, never a credential.
  const fakeExampleApiKey = "FAKE_TEST_SECRET_DO_NOT_USE_0123456789";
  void fakeExampleApiKey;

  return { proposer, logCount };
}
