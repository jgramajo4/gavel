import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DirectoryFilters, GateApi } from '../api';
import type { PublicGateProfile } from '../types';
import { AvailabilityBadge } from '../components/AvailabilityBadge';
import { WalletIdentity } from '../components/WalletIdentity';
import { formatDateTime, formatTimestamp, formatUsdc } from '../format';

/**
 * Public Gate discovery.
 *
 * Defaults are deliberate: `accepting_now` availability and `recent` sort, so
 * the first thing a visitor sees is who opted in most recently — not who holds
 * the most tokens. Power sort and the minimum-power filter are optional extras.
 *
 * Voting power is shown because it is public and useful context, never because
 * it gates availability: a Gate with zero indexed power can be accepting, and
 * nothing in this page may suggest otherwise.
 */

/**
 * One card, one reading order: who, whether they are open, what attention
 * costs, how much weight they carry, and when that weight was measured.
 *
 * The wallet address appears once, shortened, and only as the secondary line
 * under an ENS name — a 42-character hex string is not a headline. The exact
 * instant behind the human "as of" stays available as the element's title, so
 * nothing about provenance is lost to legibility.
 */
function GateCard({ profile }: { profile: PublicGateProfile }) {
  const policy = profile.policies?.[0];
  const power = profile.governancePower;
  return (
    <li className="gate-card">
      <h2 className="gate-card-title">
        <Link to={`/gates/${profile.wallet}`}>
          <WalletIdentity address={profile.wallet} ens={profile.label} />
        </Link>
      </h2>
      <AvailabilityBadge
        availability={profile.availability}
        acceptingSubmissions={profile.acceptingSubmissions}
      />
      <dl className="gate-card-stats">
        <div className="gate-stat">
          <dt className="price-label">Attention</dt>
          <dd className="price-amount">
            {policy ? formatUsdc(policy.attentionAmount) : 'Price unavailable'}
          </dd>
        </div>
        <div className="gate-stat">
          <dt className="power-label">Voting power</dt>
          <dd className="power-amount">{power ? power.amount : '—'}</dd>
        </div>
      </dl>
      {power ? (
        <p className="power-asof" title={formatTimestamp(power.asOf)}>
          As of {formatDateTime(power.asOf)}
        </p>
      ) : (
        <p className="power-asof">Voting power unavailable.</p>
      )}
      {policy && policy.acceptedStages.length > 0 ? (
        <p className="gate-card-stages">Accepts {policy.acceptedStages.join(', ')}</p>
      ) : null}
      {policy && policy.tags.length > 0 ? (
        <ul className="tag-list" aria-label="Public tags">
          {policy.tags.map((tag) => (
            <li key={tag} className="tag">
              {tag}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function GateDirectory({ api }: { api: GateApi }) {
  const [dao, setDao] = useState('nouns');
  const [availability, setAvailability] = useState('accepting_now');
  const [sort, setSort] = useState<'recent' | 'power'>('recent');
  const [minPowerDraft, setMinPowerDraft] = useState('');
  const [minPower, setMinPower] = useState('');
  const [profiles, setProfiles] = useState<PublicGateProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const filters: DirectoryFilters = { dao, availability, sort };
    if (minPower) filters.minVotingPower = minPower;
    setLoading(true);
    api
      .listGates(filters)
      .then((items) => {
        if (cancelled) return;
        setProfiles(items);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setProfiles([]);
        setError(cause instanceof Error ? cause.message : 'The Gate directory is unavailable.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, dao, availability, sort, minPower]);

  const apply = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      setMinPower(minPowerDraft.trim());
    },
    [minPowerDraft],
  );

  const clear = useCallback(() => {
    setMinPowerDraft('');
    setMinPower('');
  }, []);

  return (
    <div className="page page-directory">
      <p className="eyebrow">Gavel Gate</p>
      <h1>Gate directory</h1>
      <p className="page-intro">
        These governance participants have opted in and set a price for their attention. Newest
        opt-ins first.
      </p>
      <form className="filters" role="search" aria-label="Gate filters" onSubmit={apply}>
        <div className="field">
          <label htmlFor="filter-dao">DAO</label>
          <select id="filter-dao" value={dao} onChange={(event) => setDao(event.target.value)}>
            <option value="nouns">Nouns</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-availability">Availability</label>
          <select
            id="filter-availability"
            value={availability}
            onChange={(event) => setAvailability(event.target.value)}
          >
            <option value="accepting_now">Accepting now</option>
            <option value="all">All Gates</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-sort">Sort</label>
          <select
            id="filter-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value as 'recent' | 'power')}
          >
            <option value="recent">Recent opt-ins</option>
            <option value="power">Voting power</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-min-power">Minimum voting power (optional)</label>
          <input
            id="filter-min-power"
            inputMode="numeric"
            value={minPowerDraft}
            onChange={(event) => setMinPowerDraft(event.target.value)}
          />
        </div>
        <button type="submit">Apply</button>
        <button type="button" onClick={clear}>
          Clear filters
        </button>
      </form>

      {error ? (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      ) : null}
      {!error && !loading && profiles.length === 0 ? (
        <p className="notice">No Gates match these filters.</p>
      ) : null}
      <ul className="gate-list" aria-label="Gates">
        {profiles.map((profile) => (
          <GateCard key={profile.wallet} profile={profile} />
        ))}
      </ul>
    </div>
  );
}
