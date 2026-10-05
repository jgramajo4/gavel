import { Link, Navigate, useParams } from 'react-router-dom';
import { useCallback } from 'react';
import { DAOS, findDao, findSection, hasCapability, newestPageSize, sectionsOf, type DaoDefinition } from '../daos';
import { newestFirst, type IndexedProposal } from '../index-api';
import { paths } from '../routes';
import { useServices } from '../services';
import { useResource } from '../use-resource';
import { ProposalCard, StatusChip } from '../components/ProposalCard';
import { ResourceView } from '../components/ResourceView';
import { formatDateTime } from '../format';
import { NavLink } from 'react-router-dom';
import { NotFound } from './NotFound';

/** /daos — every registered DAO, from the registry alone. */
export function DaoIndex() {
  return (
    <div className="page">
      <p className="eyebrow">DAOs</p>
      <h1>Governance Gavel follows</h1>
      <p className="page-intro">Public and read-only. No wallet needed to browse.</p>
      <ul className="dao-list" aria-label="DAOs">
        {DAOS.map((dao) => (
          <li key={dao.id} className="dao-card">
            <h2>
              <Link to={paths.dao(dao.id)}>{dao.name}</Link>
            </h2>
            <p>{dao.summary}</p>
            <p className="dao-card-caps">{sectionsOf(dao).map((section) => section.label).join(' · ')}
              {hasCapability(dao, 'gate') ? ' · Gate' : ''}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function useProposals(dao: DaoDefinition, limit: number) {
  const { index } = useServices();
  const size = newestPageSize(dao, limit);
  const load = useCallback(
    (signal: AbortSignal) =>
      index.listProposals(dao.indexId, { limit: size, signal }).then((page) => newestFirst(page.items).slice(0, limit)),
    [index, dao.indexId, size, limit],
  );
  return useResource<IndexedProposal[]>(`${dao.indexId}:list:${size}:${limit}`, load);
}

function ProposalList({ dao, limit }: { dao: DaoDefinition; limit: number }) {
  const proposals = useProposals(dao, limit);
  return (
    <ResourceView resource={proposals} loading="Loading proposals from the Governance Indexer…">
      {(items) =>
        items.length === 0 ? (
          <p className="notice">The index has no proposals for {dao.name} yet.</p>
        ) : (
          <ul className="activity-list" aria-label={`${dao.name} proposals`}>
            {items.map((proposal) => (
              <ProposalCard key={proposal.id} proposal={proposal} dao={dao} />
            ))}
          </ul>
        )
      }
    </ResourceView>
  );
}

function Overview({ dao }: { dao: DaoDefinition }) {
  return (
    <>
      <dl className="dao-facts">
        <div><dt>Governance</dt><dd>{dao.governance}</dd></div>
        <div><dt>Chain</dt><dd>{dao.chainId === 1 ? 'Ethereum' : `Chain ${dao.chainId}`}</dd></div>
        <div><dt>Index id</dt><dd><code>{dao.indexId}</code></dd></div>
      </dl>
      {hasCapability(dao, 'gate') ? (
        <aside className="callout">
          <p className="eyebrow">Gate</p>
          <p>
            {dao.name} voters can set a price for their attention. Advocates pay to deliver a pitch; payment never buys a
            vote. <Link to={paths.gate}>Open the Gate directory</Link>.
          </p>
        </aside>
      ) : null}
      <section className="dao-section" aria-labelledby="recent-heading">
        <div className="section-head">
          <h2 id="recent-heading">Recent proposals</h2>
          <Link to={paths.daoCapability(dao.id, 'proposals')}>All proposals</Link>
        </div>
        <ProposalList dao={dao} limit={5} />
      </section>
    </>
  );
}

function DaoShell({ dao, children }: { dao: DaoDefinition; children: React.ReactNode }) {
  return (
    <div className="page page-dao">
      <p className="eyebrow">
        <Link to={paths.daos}>DAOs</Link> / {dao.name}
      </p>
      <h1>{dao.name}</h1>
      <p className="page-intro">{dao.summary}</p>
      <nav className="dao-tabs" aria-label={`${dao.name} sections`}>
        {sectionsOf(dao).map((section) => (
          <NavLink
            key={section.id}
            to={section.segment ? paths.daoCapability(dao.id, section.segment) : paths.dao(dao.id)}
            end
          >
            {section.label}
          </NavLink>
        ))}
      </nav>
      {children}
    </div>
  );
}

/** /daos/:dao and /daos/:dao/:section */
export function DaoRoute() {
  const { dao: daoParam, section: sectionParam } = useParams();
  const dao = findDao(daoParam);
  if (!dao) return <NotFound what="DAO" />;
  const section = findSection(dao, sectionParam);
  if (!section) return <NotFound what={`${dao.name} section`} />;
  return (
    // Keyed by DAO so nothing (scroll, local state) survives into another DAO.
    <DaoShell key={dao.id} dao={dao}>
      {section.id === 'overview' ? <Overview dao={dao} /> : null}
      {section.id === 'proposals' ? <ProposalList dao={dao} limit={25} /> : null}
    </DaoShell>
  );
}

const PROPOSAL_ID = /^\d{1,78}$/;

/** /daos/:dao/proposals/:id */
export function ProposalRoute() {
  const { dao: daoParam, id } = useParams();
  const dao = findDao(daoParam);
  const { index } = useServices();
  const valid = Boolean(dao && id && PROPOSAL_ID.test(id) && hasCapability(dao, 'proposals'));
  const load = useCallback(
    (signal: AbortSignal) => index.getProposal(dao!.indexId, id!, signal),
    [index, dao, id],
  );
  const proposal = useResource<IndexedProposal | null>(valid ? `${dao!.indexId}:proposal:${id}` : null, load);
  if (!dao) return <NotFound what="DAO" />;
  if (!valid) return <NotFound what="proposal" />;
  return (
    <DaoShell dao={dao}>
      <ResourceView resource={proposal} loading="Loading proposal…">
        {(data) =>
          data ? (
            <article className="proposal">
              <div className="activity-meta">
                <span className="activity-id">#{data.id}</span>
                <StatusChip status={data.effectiveStatus} />
              </div>
              <h2 className="proposal-title">{data.title}</h2>
              <dl className="dao-facts">
                {data.createdAt ? <div><dt>Created</dt><dd>{formatDateTime(data.createdAt)}</dd></div> : null}
                {data.proposer ? <div><dt>Proposer</dt><dd><code>{data.proposer}</code></dd></div> : null}
                <div><dt>For</dt><dd>{data.forVotes ?? '—'}</dd></div>
                <div><dt>Against</dt><dd>{data.againstVotes ?? '—'}</dd></div>
                <div><dt>Abstain</dt><dd>{data.abstainVotes ?? '—'}</dd></div>
                {data.sourceState && data.sourceState !== data.effectiveStatus ? (
                  <div><dt>Source state</dt><dd>{data.sourceState} (raw, not authoritative)</dd></div>
                ) : null}
              </dl>
              <p className="provenance-note" data-origin={data.provenance.origin}>
                Onchain fact from the Gavel Governance Indexer
                {data.provenance.sourceContract ? <> · governor <code>{data.provenance.sourceContract}</code></> : null}
                {data.provenance.createdBlock ? <> · block {data.provenance.createdBlock}</> : null}
              </p>
              {data.description ? (
                <details className="proposal-body">
                  <summary>Proposal text (author-supplied, unverified)</summary>
                  <pre className="proposal-text">{data.description}</pre>
                </details>
              ) : null}
            </article>
          ) : (
            <p className="notice" data-error-kind="not_found">The index has no {dao.name} proposal #{id}.</p>
          )
        }
      </ResourceView>
    </DaoShell>
  );
}

/** Old-style ?dao= links or bare ids are never guessed; unknown → NotFound. */
export function DaoRedirect({ to }: { to: string }) {
  return <Navigate to={to} replace />;
}
