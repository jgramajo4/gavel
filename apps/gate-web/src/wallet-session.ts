import type { GateApi } from './api';
import { resolveAccount, signTypedData, type Eip1193Provider } from './wallet';
import type { VerifiedSession, WalletSessionRole } from './types';

export class WalletSessionRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletSessionRoleError';
  }
}

/**
 * The one WalletSession exchange in this app.
 *
 * It is the merged server flow and nothing else: request a challenge for a
 * SINGLE role, sign that exact typed data with the connected wallet, exchange
 * the signature for a short-lived session. There is no fallback path, no
 * silent role substitution, and no reuse of a session issued for another role —
 * the server scopes every route to one role, and so does this.
 *
 * Nothing here logs. The challenge, the signature, and the returned token never
 * reach `console`, an analytics call, a URL, or storage: the token lives in
 * React state for the life of the tab (see `session.tsx`) and dies with it.
 *
 * `account` is the connection the global header is already showing. Passing it
 * reuses that connection — one signature, no second connect prompt — without
 * relaxing anything: the connection is still identity only, and this exchange
 * is still the sole thing that produces authorization, for one role.
 */
export async function openWalletSession({
  api,
  provider,
  role,
  account: connected = null,
}: {
  api: GateApi;
  provider: Eip1193Provider;
  role: WalletSessionRole;
  account?: string | null;
}): Promise<{ account: string; verified: VerifiedSession }> {
  const account = await resolveAccount(provider, connected);
  const challenge = await api.requestChallenge({ proofType: 'WalletSession', wallet: account, role });
  const signature = await signTypedData(provider, account, {
    domain: challenge.domain,
    types: challenge.types,
    primaryType: challenge.primaryType,
    message: challenge.message,
  });
  const verified = await api.verifyProof({
    proofType: 'WalletSession',
    typedData: {
      primaryType: challenge.primaryType,
      domain: challenge.domain,
      message: challenge.message,
    },
    signature,
  });
  // A session the server did not issue for the requested role is refused here
  // rather than sent to a route that would reject it: role separation is not a
  // server-only concern, and a mismatch is a bug worth surfacing loudly.
  if (verified?.session?.role !== role) {
    throw new WalletSessionRoleError(
      `This wallet session is not a ${role} session. Sign in again from this page.`,
    );
  }
  return { account, verified };
}

/** A session is usable for `role` only when the server issued it for `role`. */
export function isSessionForRole(
  session: VerifiedSession | null,
  role: WalletSessionRole,
): session is VerifiedSession {
  return Boolean(session?.token) && session?.session?.role === role;
}
