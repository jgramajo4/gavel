import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { DAOS, newestPageSize, type DaoDefinition } from '../daos';
import { newestFirst, type IndexedProposal } from '../index-api';
import { paths } from '../routes';
import { useServices } from '../services';
import { useResource, type Resource } from '../use-resource';
import { ProposalCard } from '../components/ProposalCard';
import { RECIPES } from '../install';
import { CopyBlock } from '../components/CopyBlock';

/**
 * Activity preview: the latest proposals per DAO, side by side.
 *
 * Deliberately NOT a merged global feed. The index has no normalized activity
 * stream (votes, delegation, treasury, ...), and stitching per-DAO proposal
 * lists into one timeline in the browser would be the frontend acting as an
 * indexer. Each column is one index call and one honest source. The real feed
 * is a Governance Indexer capability (docs/web/ARCHITECTURE.md).
 */
const PREVIEW_PER_DAO = 3;

function DaoColumn({ dao }: { dao: DaoDefinition }) {
  const { index } = useServices();
  const size = newestPageSize(dao, PREVIEW_PER_DAO);
  const load = useCallback(
    (signal: AbortSignal) =>
      index.listProposals(dao.indexId, { limit: size, signal }).then((page) => newestFirst(page.items).slice(0, PREVIEW_PER_DAO)),
    [index, dao.indexId, size],
  );
  const proposals: Resource<IndexedProposal[]> = useResource(`${dao.indexId}:home:${size}`, load);
  return (
    <section className="preview-column" aria-label={`${dao.name} latest proposals`}>
      <h3 className="preview-head">
        <Link to={paths.dao(dao.id)}>{dao.name}</Link>
      </h3>
      {proposals.status === 'ready' ? (
        proposals.data.length === 0 ? (
          <p className="notice">No indexed proposals yet.</p>
        ) : (
          <ul className="activity-list">
            {proposals.data.map((proposal) => (
              <ProposalCard key={proposal.id} proposal={proposal} dao={dao} />
            ))}
          </ul>
        )
      ) : proposals.status === 'error' ? (
        <p className="notice notice-error" data-error-kind={proposals.kind}>
          {dao.name} is unavailable right now.
        </p>
      ) : (
        <p className="notice">Loading…</p>
      )}
    </section>
  );
}

export function Home() {
  const brief = RECIPES[0];
  return (
    <div className="page page-home">
      <section className="hero">
        <p className="eyebrow">Gavel · multi-DAO governance</p>
        <h1>Governance without the tab sprawl.</h1>
        <p className="hero-lede">
          Follow {DAOS.map((dao) => dao.name).join(', ').replace(/, ([^,]*)$/, ' and $1')} in one place. Gavel tells you
          what needs your attention, explains it from your own voting history, and prepares the work for your review,
          from the agent you already use.
        </p>
        <div className="hero-actions">
          <Link className="primary-link" to={paths.install}>
            Install Gavel
          </Link>
          <Link className="secondary-link" to={paths.daos}>
            Browse DAOs. No wallet needed.
          </Link>
        </div>
      </section>

      <section className="home-section" aria-labelledby="activity-heading">
        <div className="section-head">
          <h2 id="activity-heading">Latest proposals</h2>
          <Link to={paths.daos}>All DAOs</Link>
        </div>
        <p className="section-note">
          Live from the Gavel Governance Indexer, one column per DAO. A unified cross-DAO feed with votes,
          delegation and treasury activity is next on the roadmap.
        </p>
        <div className="preview-grid">
          {DAOS.map((dao) => (
            <DaoColumn key={dao.id} dao={dao} />
          ))}
        </div>
      </section>

      <section className="home-section explain" aria-labelledby="explain-heading">
        <h2 id="explain-heading">What Gavel does</h2>
        <ol className="explain-list">
          <li>
            <h3>Follows</h3>
            <p>Proposals across every DAO you participate in, read from one canonical index.</p>
          </li>
          <li>
            <h3>Prioritises</h3>
            <p>Execution required, votes ending soon, open votes you haven’t cast, then what’s new.</p>
          </li>
          <li>
            <h3>Explains</h3>
            <p>Recommendations traced to your own past votes and stated preferences, with the evidence attached.</p>
          </li>
          <li>
            <h3>Prepares</h3>
            <p>Unsigned vote and delegation transactions for your review. Recommendation is not authorization.</p>
          </li>
        </ol>
      </section>

      <section className="home-section recipe" aria-labelledby="brief-heading">
        <p className="eyebrow">Try it</p>
        <h2 id="brief-heading">{brief.title}</h2>
        <p className="section-note">{brief.pitch} Paste this into Gavel in your agent.</p>
        <CopyBlock text={brief.prompt} label={`${brief.title} prompt`} />
        <p className="section-note">
          <Link to={paths.install}>Set up Gavel in your agent</Link> first.
        </p>
      </section>

      <section className="home-section" aria-labelledby="gate-heading">
        <p className="eyebrow">Gate</p>
        <h2 id="gate-heading">Paid attention, never paid votes</h2>
        <p className="section-note">
          Voters set a price for their attention; advocates pay to deliver a pitch to their private inbox.{' '}
          <Link to={paths.gate}>Browse the Gate directory</Link> or <Link to={paths.gateEnroll}>enroll as a voter</Link>.
        </p>
      </section>
    </div>
  );
}
