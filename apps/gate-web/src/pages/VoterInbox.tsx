import { useCallback, useEffect, useState } from 'react';
import { GateApiError, GateEndpointUnavailableError, type GateApi } from '../api';
import { useSession } from '../session';
import { MarkdownPitch } from '../components/MarkdownPitch';
import { FactPanel } from '../components/FactPanel';
import { formatTimestamp } from '../format';
import type { InboxItem } from '../types';

/**
 * The voter's private inbox.
 *
 * It shows the advocate's raw immutable pitch beside canonical, decoded, and
 * clearly-labelled enriched facts, plus both lifecycle states when the proposal
 * moved after the quote was issued.
 *
 * What it deliberately does not show: whether, how, or where the voter was
 * notified; any sender-side receipt internals; capacity; or delivery settings.
 * Those are private operational state, and a voter learning that an advocate's
 * notification "failed" would leak Gavel's delivery behaviour into a paid
 * product surface. There is also no reply or follow-up control in the MVP.
 */

function LifecycleReadout({ item }: { item: InboxItem }) {
  if (!item.lifecycleChanged) {
    return (
      <p className="lifecycle" data-testid="lifecycle">
        <span className="lifecycle-label">Proposal state</span>{' '}
        <span className="lifecycle-value">{item.currentLifecycle}</span>
      </p>
    );
  }
  return (
    <p className="lifecycle lifecycle-changed" data-testid="lifecycle">
      <span className="lifecycle-label">At quote</span>{' '}
      <span className="lifecycle-value">{item.issuanceLifecycle}</span>
      {' · '}
      <span className="lifecycle-label">Now</span>{' '}
      <span className="lifecycle-value">{item.currentLifecycle}</span>
    </p>
  );
}

function InboxCard({ item, onArchive }: { item: InboxItem; onArchive(id: string): void }) {
  return (
    <article className="inbox-item" aria-label={`Nouns proposal ${item.proposalId} — ${item.position}`}>
      <header className="inbox-header">
        <button type="button" onClick={() => onArchive(item.id)}>
          Archive
        </button>
        <p className="inbox-meta">
          Proposal {item.proposalId} · Position {item.position} · Received{' '}
          {formatTimestamp(item.inboxCreatedAt)}
        </p>
        <LifecycleReadout item={item} />
      </header>

      <section className="inbox-pitch" aria-label="Advocate pitch">
        <MarkdownPitch source={item.pitch} />
      </section>

      {item.disclosures ? (
        <section className="inbox-disclosures" aria-label="Disclosures">
          <h3>Disclosures</h3>
          <MarkdownPitch source={item.disclosures} />
        </section>
      ) : null}

      {item.evidenceUrls.length > 0 ? (
        <ul className="evidence-list" aria-label="Evidence links">
          {item.evidenceUrls.map((url) => (
            <li key={url}>
              <a className="external-link" href={url} rel="noopener noreferrer" target="_blank">
                {url}
                <span className="external-indicator" aria-label="external link">
                  ↗
                </span>
              </a>
            </li>
          ))}
          <li className="evidence-note">
            Advocate-provided references only. Gavel never opens or retrieves them.
          </li>
        </ul>
      ) : null}

      <FactPanel
        canonicalFacts={item.canonicalFacts}
        decodedFacts={item.decodedFacts}
        enrichedFacts={item.enrichedFacts}
      />
    </article>
  );
}

export function VoterInbox({ api }: { api: GateApi }) {
  const { session } = useSession();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) {
      setItems([]);
      setError('Sign in with your Gate wallet to read your inbox.');
      return;
    }
    let cancelled = false;
    api
      .listInbox(session.token)
      .then((result) => {
        if (cancelled) return;
        setItems(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setItems([]);
        // An unserved route is reported as exactly that. The UI never fabricates
        // inbox contents to fill the gap.
        setError(
          cause instanceof GateEndpointUnavailableError || cause instanceof GateApiError
            ? cause.message
            : 'Your inbox could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, session]);

  const archive = useCallback(
    async (id: string) => {
      if (!session) return;
      try {
        await api.archiveInboxItem(session.token, id);
        setItems((current) => current.filter((item) => item.id !== id));
      } catch (cause: unknown) {
        setError(cause instanceof GateApiError ? cause.message : 'This item could not be archived.');
      }
    },
    [api, session],
  );

  return (
    <div className="page page-inbox">
      <h1>Voter inbox</h1>
      {error ? (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      ) : null}
      <section className="inbox" aria-label="Voter inbox">
        {items.length === 0 && !error ? <p className="notice">No paid submissions yet.</p> : null}
        {items.map((item) => (
          <InboxCard key={item.id} item={item} onArchive={archive} />
        ))}
      </section>
    </div>
  );
}
