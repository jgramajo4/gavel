import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { GateApiError, type GateApi } from '../api';
import { useSession } from '../session';
import { isSessionForRole, openWalletSession } from '../wallet-session';
import { MarkdownPitch } from '../components/MarkdownPitch';
import { ExternalLink } from '../components/ExternalLink';
import { FactPanel } from '../components/FactPanel';
import { formatTimestamp, shortenAddress } from '../format';
import type { Eip1193Provider } from '../wallet';
import type { CanonicalEvidence, CanonicalFact, InboxItem } from '../types';

/**
 * The private voter inbox.
 *
 * Everything shown here was paid for, settled on Base, and independently
 * verified by Gavel's scanner before the server created the item — this page
 * never decides that a submission arrived, it only reads what the server
 * already accepted.
 *
 * Authentication is the `dao_inbox` WalletSession role and nothing else. An
 * advocate's `base_sender` session and an enrollment's `dao_profile` session
 * are both refused here, by this component and again by the server.
 *
 * Advocate-controlled content — the pitch, the disclosures, the evidence URLs —
 * is untrusted. The pitch and disclosures go through the frozen CommonMark
 * allowlist (`MarkdownPitch`), which never emits raw HTML, scripts, images, or
 * embeds. Evidence URLs go through `ExternalLink`, which links only absolute
 * HTTPS and renders anything else as inert text. Nothing on this page fetches,
 * previews, unfurls, resolves, or summarizes an advocate-supplied URL, and no
 * submission body is logged, measured, or sent anywhere.
 */

const INBOX_ROLE = 'dao_inbox' as const;

function isCandidate(item: InboxItem): boolean {
  const facts = item.canonicalFacts;
  return facts.kind === 'candidate' || (facts.targetId ?? '').startsWith('candidate:');
}

/** The identity the server recorded, never a label this page invents. */
function titleOf(item: InboxItem): string {
  const facts = item.canonicalFacts;
  if (isCandidate(item)) return facts.slug ? `Candidate “${facts.slug}”` : 'Proposal candidate';
  return facts.proposalId ? `Proposal ${facts.proposalId}` : 'Governance proposal';
}

/**
 * The stage vocabulary is the server's normalized lifecycle. A candidate is
 * always a PRE_VOTE sponsorship request and is labelled as one, so it can never
 * be mistaken for a proposal that is already up for a vote.
 */
function stageOf(item: InboxItem): string {
  return item.currentLifecycle ?? item.issuanceLifecycle ?? 'UNKNOWN';
}

function ItemKind({ item }: { item: InboxItem }) {
  if (isCandidate(item)) {
    return (
      <span className="badge inbox-kind inbox-kind-candidate" data-kind="candidate">
        Seeking sponsorship
      </span>
    );
  }
  return (
    <span className="badge inbox-kind inbox-kind-proposal" data-kind="proposal">
      {stageOf(item)}
    </span>
  );
}

function Meta({ item }: { item: InboxItem }) {
  return (
    <p className="inbox-meta">
      {item.canonicalFacts.dao ?? 'nouns'} · Received {formatTimestamp(item.createdAt)}
      {isCandidate(item) ? ' · PRE_VOTE sponsorship request' : ` · Stage ${stageOf(item)}`}
      {item.archived ? ' · Archived' : ''}
    </p>
  );
}

/** Raw canonical actions the versioned decoder could not interpret. */
function rawCanonicalFacts(actions: CanonicalEvidence[]): CanonicalFact[] {
  return actions.map((action, index) => {
    const evidence: CanonicalEvidence = {
      actionIndex: Number.isInteger(action?.actionIndex) ? action.actionIndex : index,
      target: String(action?.target ?? ''),
      valueWei: String(action?.valueWei ?? '0'),
      calldata: String(action?.calldata ?? '0x'),
      signature: String(action?.signature ?? ''),
    };
    return {
      source: 'canonical',
      kind: 'raw_action',
      displayLabel: 'Raw canonical action',
      ...evidence,
      canonicalEvidence: evidence,
    };
  });
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="field-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function InboxDetail({
  item,
  onBack,
  onArchive,
  archiving,
}: {
  item: InboxItem;
  onBack(): void;
  onArchive(): void;
  archiving: boolean;
}) {
  const facts = item.canonicalFacts;
  return (
    <article className="inbox-item" aria-label="Inbox item">
      <header className="inbox-header">
        <button type="button" onClick={onBack}>
          ← Back to inbox
        </button>
        <h2>{titleOf(item)}</h2>
        <p>
          <ItemKind item={item} />
          {item.archived ? <span className="badge inbox-archived">Archived</span> : null}
        </p>
        <Meta item={item} />
      </header>

      {isCandidate(item) ? (
        <p className="notice">
          This is a Nouns proposal candidate asking you to sponsor it. It is not an active
          governance proposal and there is no vote open on it.
        </p>
      ) : null}
      {item.stateChangedAfterQuote ? (
        <p role="status" className="notice lifecycle-changed">
          This proposal's stage changed after the advocate paid. It was {item.issuanceLifecycle} at
          the time of payment and is {stageOf(item)} now.
        </p>
      ) : null}

      <section className="inbox-section" aria-label="Advocate message">
        <h3>Advocate message</h3>
        <MarkdownPitch source={item.pitch} />
      </section>

      {item.disclosures ? (
        <section className="inbox-section" aria-label="Disclosures">
          <h3>Disclosures</h3>
          <MarkdownPitch source={item.disclosures} />
        </section>
      ) : null}

      <section className="inbox-section" aria-label="Evidence links">
        <h3>Evidence links</h3>
        <p className="evidence-note">
          Advocate-provided references. Gavel never opens, retrieves, previews, or summarizes them —
          following one is your choice, and it opens in a new tab.
        </p>
        {item.evidenceUrls.length === 0 ? (
          <p className="fact-empty">None submitted.</p>
        ) : (
          <ul className="evidence-list">
            {item.evidenceUrls.map((url, index) => (
              <li key={`${url}-${index}`}>
                <ExternalLink href={url} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="inbox-section" aria-label="Canonical target">
        <h3>Canonical target</h3>
        <dl>
          <Row label="DAO" value={facts.dao ?? 'nouns'} />
          <Row label="Type" value={isCandidate(item) ? 'Proposal candidate' : 'Governance proposal'} />
          {facts.proposalId ? <Row label="Proposal ID" value={facts.proposalId} /> : null}
          {facts.targetId ? <Row label="Target ID" value={facts.targetId} /> : null}
          {facts.proposer ? <Row label="Proposer" value={facts.proposer} /> : null}
          <Row label="Stage at payment" value={item.issuanceLifecycle ?? '—'} />
          <Row label="Stage now" value={stageOf(item)} />
          {facts.nativeState ? <Row label="Native state" value={facts.nativeState} /> : null}
          {facts.contentHash ? <Row label="Content hash" value={facts.contentHash} /> : null}
          {facts.sourceBlock ? <Row label="Source block" value={facts.sourceBlock} /> : null}
          {facts.mappingVersion ? <Row label="Lifecycle mapping" value={facts.mappingVersion} /> : null}
          <Row label="Received" value={formatTimestamp(item.createdAt)} />
        </dl>
      </section>

      <FactPanel
        canonicalFacts={rawCanonicalFacts(item.rawUnknownActions)}
        decodedFacts={item.decodedFacts.actions}
        enrichedFacts={item.enrichedFacts}
      />

      {item.archived ? null : (
        <button type="button" className="inbox-archive" onClick={onArchive} disabled={archiving}>
          Archive this request
        </button>
      )}
    </article>
  );
}

export interface VoterInboxProps {
  api: GateApi;
  wallet: Eip1193Provider;
}

export function VoterInbox({ api, wallet }: VoterInboxProps) {
  const { session, setSession, clearSession } = useSession();
  const inboxSession = isSessionForRole(session, INBOX_ROLE) ? session : null;
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [openItem, setOpenItem] = useState<InboxItem | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [archiving, setArchiving] = useState(false);
  // Which session token the first automatic load was already attempted for, so
  // a failed load shows its error instead of retrying in a tight loop.
  const attempted = useRef<string | null>(null);

  /**
   * Turns a failure into one readable sentence. Raw bodies, stack traces, and
   * anything the server said about another voter's data stay out of the UI; an
   * expired or rejected session also drops the in-memory token immediately.
   */
  const explain = useCallback(
    (cause: unknown, fallback: string): string => {
      if (cause instanceof GateApiError) {
        if (cause.status === 401) {
          clearSession();
          return 'Your inbox session expired. Connect your governance wallet again to continue.';
        }
        if (cause.status === 403) {
          clearSession();
          return 'This wallet is not enrolled as a Gate voter, so it has no private inbox.';
        }
        if (cause.status === 404) return 'That request is no longer in your inbox.';
        if (cause.code === 'MALFORMED_RESPONSE') return cause.message;
        if (cause.status >= 500) return 'The inbox is unavailable right now. Try again shortly.';
        return cause.message;
      }
      return fallback;
    },
    [clearSession],
  );

  const load = useCallback(
    async (token: string) => {
      setBusy(true);
      try {
        setItems(await api.listInbox(token));
        setError(null);
      } catch (cause: unknown) {
        setItems(null);
        setError(explain(cause, 'The inbox could not be loaded. Check your connection and try again.'));
      } finally {
        setBusy(false);
      }
    },
    [api, explain],
  );

  useEffect(() => {
    if (!inboxSession || attempted.current === inboxSession.token) return;
    attempted.current = inboxSession.token;
    void load(inboxSession.token);
  }, [inboxSession, load]);

  const authenticate = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const { verified } = await openWalletSession({ api, provider: wallet, role: INBOX_ROLE });
      setItems(null);
      setOpenItem(null);
      setSession(verified);
    } catch (cause: unknown) {
      setError(
        explain(
          cause,
          cause instanceof Error
            ? cause.message
            : 'Wallet sign-in failed. Nothing was signed and no session was created.',
        ),
      );
    } finally {
      setBusy(false);
    }
  }, [api, wallet, setSession, explain]);

  const open = useCallback(
    async (id: string) => {
      if (!inboxSession) return;
      setError(null);
      setBusy(true);
      try {
        const item = await api.getInboxItem(inboxSession.token, id);
        if (!item) {
          setError('That request is no longer in your inbox.');
          return;
        }
        setOpenItem(item);
      } catch (cause: unknown) {
        setError(explain(cause, 'That request could not be opened. Try again shortly.'));
      } finally {
        setBusy(false);
      }
    },
    [api, inboxSession, explain],
  );

  const archive = useCallback(async () => {
    if (!inboxSession || !openItem) return;
    setError(null);
    setArchiving(true);
    try {
      const result = await api.archiveInboxItem(inboxSession.token, openItem.id);
      const archived = result.archived === true;
      setOpenItem({ ...openItem, archived });
      setItems((current) =>
        current === null
          ? current
          : current.map((item) => (item.id === openItem.id ? { ...item, archived } : item)),
      );
    } catch (cause: unknown) {
      setError(explain(cause, 'Archiving failed. The request is still in your inbox.'));
    } finally {
      setArchiving(false);
    }
  }, [api, inboxSession, openItem, explain]);

  const visible = useMemo(
    () => (items ?? []).filter((item) => showArchived || !item.archived),
    [items, showArchived],
  );

  if (!inboxSession) {
    return (
      <div className="page page-inbox">
        <h1>Voter inbox</h1>
        <p className="page-intro">
          Your inbox is private. Sign in with the governance wallet you enrolled to read paid
          lobbying and sponsorship requests that Gavel verified on chain.
        </p>
        <div className="inbox-signin">
          <p className="inbox-meta">
            Signing proves wallet control. It is a typed-data signature, not a transaction: it costs
            no gas and moves no funds.
          </p>
          {error ? (
            <p role="alert" className="notice notice-error">
              {error}
            </p>
          ) : null}
          <button type="button" onClick={authenticate} disabled={busy}>
            Connect governance wallet
          </button>
        </div>
        <p className="page-intro">
          Not enrolled yet? <Link to="/enroll">Set up your Gate</Link> to start accepting paid
          attention requests.
        </p>
      </div>
    );
  }

  return (
    <div className="page page-inbox">
      <h1>Voter inbox</h1>
      <p className="page-intro">
        Signed in as <span className="inbox-wallet">{shortenAddress(inboxSession.session.wallet)}</span>.
        Every request below was paid for and independently verified by Gavel before it appeared here.
      </p>

      {error ? (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      ) : null}

      {openItem ? (
        <InboxDetail
          item={openItem}
          onBack={() => setOpenItem(null)}
          onArchive={archive}
          archiving={archiving}
        />
      ) : (
        <div className="inbox">
          <div className="inbox-controls">
            <label className="inbox-toggle">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
              />{' '}
              Show archived requests
            </label>
            <button type="button" onClick={() => load(inboxSession.token)} disabled={busy}>
              Refresh
            </button>
          </div>

          {busy && items === null ? <p className="notice">Loading your inbox…</p> : null}

          {items !== null && visible.length === 0 ? (
            <p role="status" className="notice">
              {items.length === 0
                ? 'No requests yet. Paid requests appear here only after Gavel verifies settlement on chain.'
                : 'No unarchived requests. Tick “Show archived requests” to see the ones you archived.'}
            </p>
          ) : null}

          <ul className="inbox-list">
            {visible.map((item) => (
              <li key={item.id} className="inbox-card" data-archived={item.archived}>
                <p className="inbox-card-title">{titleOf(item)}</p>
                <p>
                  <ItemKind item={item} />
                  {item.archived ? <span className="badge inbox-archived">Archived</span> : null}
                </p>
                <Meta item={item} />
                <button type="button" onClick={() => open(item.id)} disabled={busy}>
                  Open request
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
