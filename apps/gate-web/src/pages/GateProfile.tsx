import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { GateApi } from '../api';
import type { PublicGateProfile } from '../types';
import { AvailabilityBadge } from '../components/AvailabilityBadge';
import { WalletIdentity } from '../components/WalletIdentity';
import { formatDateTime, formatTimestamp, formatUsdc } from '../format';

/**
 * A durable public page for a Gate in every availability state.
 *
 * It renders only fields the public projection serves — wallet/ENS, DAO policy,
 * accepted stages, price, tags, exact power and its as-of timestamp. Delivery
 * settings, capacity, inbox and read state, and any authorization material are
 * private and have no representation here. When a Gate is unavailable the page
 * still exists and says so, without publishing a count or a reset time.
 *
 * The Gavel service fee is deliberately NOT shown. This page answers "what does
 * this voter charge for their attention"; the fee is Gavel's, is paid by the
 * advocate, and never comes out of the voter's price. It is disclosed where it
 * is actually owed — the composer and the checkout quote — so the number beside
 * a voter's name is the number that reaches them.
 */
export function GateProfile({ api, wallet }: { api: GateApi; wallet: string }) {
  const [profile, setProfile] = useState<PublicGateProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getGate(wallet)
      .then((result) => {
        if (cancelled) return;
        setProfile(result);
        setError(result ? null : 'Gate profile not found.');
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setProfile(null);
        setError(cause instanceof Error ? cause.message : 'This Gate profile could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, wallet]);

  const policy = profile?.policies?.[0];

  return (
    <div className="page page-profile">
      <p className="eyebrow">Gavel Gate</p>
      <h1>Gate profile</h1>
      {loading ? <p className="notice">Loading…</p> : null}
      {error ? (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      ) : null}
      {profile ? (
        <article className="profile">
          <header className="profile-header">
            {/* Name first, shortened address under it. The canonical address is
                published in full once, below, where a reader who needs to copy
                it can find it — not twice at the top of the page. */}
            <WalletIdentity address={profile.wallet} ens={profile.ens} tone="header" />
            <AvailabilityBadge
              availability={profile.availability}
              acceptingSubmissions={profile.acceptingSubmissions}
            />
          </header>

          {profile.message ? <p className="profile-message">{profile.message}</p> : null}

          <section className="profile-section" aria-label="Governance">
            <h2>Governance</h2>
            <dl>
              <div className="field-row">
                <dt>DAO</dt>
                <dd>{policy?.dao ?? 'nouns'}</dd>
              </div>
              <div className="field-row">
                <dt>Wallet</dt>
                <dd className="profile-wallet">{profile.wallet}</dd>
              </div>
              {profile.governancePower ? (
                <div className="field-row">
                  <dt>Voting power</dt>
                  <dd className="profile-power">
                    <span className="power-amount">{profile.governancePower.amount}</span>
                    <span
                      className="power-asof"
                      title={formatTimestamp(profile.governancePower.asOf)}
                    >
                      As of {formatDateTime(profile.governancePower.asOf)}
                    </span>
                  </dd>
                </div>
              ) : null}
            </dl>
            <p className="profile-note">
              Voting power is published as indexed context. It does not decide whether this Gate takes
              submissions.
            </p>
          </section>

          {policy ? (
            <section className="profile-section" aria-label="Policy">
              <h2>Policy</h2>
              <dl>
                <div className="field-row">
                  <dt>Accepted stages</dt>
                  <dd>
                    <ul className="stage-list">
                      {policy.acceptedStages.map((stage) => (
                        <li key={stage}>{stage}</li>
                      ))}
                    </ul>
                  </dd>
                </div>
                <div className="field-row">
                  <dt>Attention price</dt>
                  <dd>{formatUsdc(policy.attentionAmount)}</dd>
                </div>
              </dl>
              {policy.tags.length > 0 ? (
                <ul className="tag-list" aria-label="Public tags">
                  {policy.tags.map((tag) => (
                    <li key={tag} className="tag">
                      {tag}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          {profile.acceptingSubmissions ? (
            <Link className="primary-link" to={`/gates/${profile.wallet}/compose`}>
              Submit a paid pitch
            </Link>
          ) : null}
        </article>
      ) : null}
    </div>
  );
}
