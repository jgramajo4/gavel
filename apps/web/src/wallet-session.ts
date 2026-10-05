import type { GateApi } from './gate-api';
import { resolveAccount, signTypedData, type Eip1193Provider } from './wallet';
import type { VerifiedSession, WalletSessionRole } from './types';

export class WalletSessionRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletSessionRoleError';
  }
}

export class WalletSessionChallengeError extends Error {
  readonly code = 'WALLET_SESSION_CHALLENGE_MISMATCH';

  constructor() {
    super('The wallet session challenge does not match the requested wallet and role. Nothing was signed.');
    this.name = 'WalletSessionChallengeError';
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
  const challengeWallet = challenge?.message?.wallet;
  const challengeRole = challenge?.message?.role;
  if (
    typeof challengeWallet !== 'string' ||
    challengeWallet.toLowerCase() !== account.toLowerCase() ||
    challengeRole !== role
  ) {
    throw new WalletSessionChallengeError();
  }
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

/**
 * Whether the tab holds an explicit, live Base sender.
 *
 * The Base sender is the account that requests, owns, and pays a quote. It is
 * established in exactly one way: a `base_sender` WalletSession the server
 * issued, for the account the wallet is connected to right now. Nothing else
 * stands in for it — not the target voter, not a `dao_profile` or `dao_inbox`
 * session, not a connected address with no session, and not a session left
 * over from an account the wallet has since moved away from or disconnected.
 */
export type BaseSenderState =
  | { status: 'ready'; session: VerifiedSession; sender: string }
  /** No connected wallet account. */
  | { status: 'disconnected' }
  /** Connected, but no `base_sender` session (none, or another role's). */
  | { status: 'unsigned' }
  /** A `base_sender` session whose server expiry has passed. */
  | { status: 'expired' }
  /** A `base_sender` session for a different account than the connected one. */
  | { status: 'mismatch'; sender: string };

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function baseSenderState(
  session: VerifiedSession | null,
  connected: string | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): BaseSenderState {
  if (!isSessionForRole(session, 'base_sender')) return connected ? { status: 'unsigned' } : { status: 'disconnected' };
  let unexpired = false;
  try {
    unexpired = BigInt(session.session.expiry) > BigInt(nowSeconds);
  } catch {
    unexpired = false;
  }
  if (!unexpired) return { status: 'expired' };
  if (!connected) return { status: 'disconnected' };
  const sender = session.session.wallet;
  if (typeof sender !== 'string' || !sameAddress(sender, connected)) return { status: 'mismatch', sender };
  return { status: 'ready', session, sender };
}
