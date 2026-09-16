import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DirectoryFilters, GateApi } from '../api';
import type { PublicGateProfile } from '../types';
import { AvailabilityBadge } from '../components/AvailabilityBadge';
import { formatTimestamp, formatUsdc } from '../format';

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

function PowerReadout({ profile }: { profile: PublicGateProfile }) {
  if (!profile.governancePower) return <p className="power">Voting power unavailable.</p>;
  return (
    <p className="power">
      <span className="power-label">Voting power</span>{' '}
      <span className="power-amount">{profile.governancePower.amount}</span>{' '}
      <span className="power-asof">As of {formatTimestamp(profile.governancePower.asOf)}</span>
    </p>
  );
}

function GateCard({ profile }: { profile: PublicGateProfile }) {
  const policy = profile.policies?.[0];
  return (
    <li className="gate-card">
      <h2 className="gate-card-title">
        <Link to={`/gates/${profile.wallet}`}>{profile.ens || profile.wallet}</Link>
      </h2>
      <p className="gate-card-wallet">{profile.wallet}</p>
      <AvailabilityBadge
        availability={profile.availability}
        acceptingSubmissions={profile.acceptingSubmissions}
      />
      <PowerReadout profile={profile} />
      {policy ? (
        <p className="gate-card-price">
          <span className="price-label">Attention price</span>{' '}
          <span className="price-amount">{formatUsdc(policy.attentionAmount)}</span>
        </p>
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
      <h1>Gate directory</h1>
      <p className="page-intro">
        Governance participants who have opted in to receive paid pitches. Newest opt-ins first.
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
