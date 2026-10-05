import type { CanonicalFact, DecodedFact, EnrichedFact } from '../types';

/**
 * Provenance display.
 *
 * Canonical facts come straight from indexed proposal actions. Decoded facts
 * come from the versioned, tested allowlist decoder. Enriched facts (ENS, token
 * metadata) are convenience only and are never verification material, so they
 * are visually and semantically separated and labelled "display only" — never
 * with the verified marker the other two carry.
 *
 * Actions the decoder does not understand stay visible as raw calldata. An
 * action that silently disappears is worse than one a voter cannot read.
 *
 * There is deliberately no scoring, claim extraction, or omission warning here.
 */

function Evidence({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact-field">
      <dt>{label}</dt>
      <dd className="fact-value">{value}</dd>
    </div>
  );
}

function CanonicalCard({ fact }: { fact: CanonicalFact }) {
  return (
    <li className="fact-card">
      <p className="fact-label">
        {fact.displayLabel} <span className="fact-index">#{fact.actionIndex}</span>
      </p>
      <dl>
        <Evidence label="Target" value={fact.target} />
        <Evidence label="Value (wei)" value={fact.valueWei} />
        <Evidence label="Signature" value={fact.signature || '(none)'} />
        <Evidence label="Calldata" value={fact.calldata} />
      </dl>
    </li>
  );
}

function DecodedCard({ fact }: { fact: DecodedFact }) {
  return (
    <li className="fact-card">
      <p className="fact-label">
        {fact.displayLabel} <span className="fact-index">#{fact.actionIndex}</span>
      </p>
      <dl>
        {fact.kind === 'native_eth_transfer' ? (
          <Evidence label="Amount (wei)" value={fact.amountWei} />
        ) : (
          <>
            <Evidence label="Amount (atomic)" value={fact.amountAtomic} />
            <Evidence label="Token" value={fact.token} />
          </>
        )}
        <Evidence label="Recipient" value={fact.recipient} />
        <Evidence label="Decoder" value={fact.decoderVersion} />
        <Evidence label="Canonical calldata" value={fact.canonicalEvidence.calldata} />
      </dl>
    </li>
  );
}

function EnrichedCard({ fact }: { fact: EnrichedFact }) {
  return (
    <li className="fact-card fact-card-enriched">
      <p className="fact-label">{fact.displayLabel}</p>
      <p className="fact-value">{fact.value}</p>
    </li>
  );
}

function Group({
  provenance,
  title,
  verified,
  note,
  count,
  children,
}: {
  provenance: 'canonical' | 'decoded' | 'enriched';
  title: string;
  verified: boolean;
  note: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section
      role="group"
      aria-label={title}
      data-provenance={provenance}
      className={`fact-group fact-group-${provenance}`}
    >
      <h3 className="fact-group-title">
        {title}
        <span className={verified ? 'badge badge-verified' : 'badge badge-unverified'}>
          {verified ? 'Verified provenance' : 'Display only'}
        </span>
      </h3>
      <p className="fact-note">{note}</p>
      {count === 0 ? <p className="fact-empty">None.</p> : <ul className="fact-list">{children}</ul>}
    </section>
  );
}

export interface FactPanelProps {
  canonicalFacts: CanonicalFact[];
  decodedFacts: DecodedFact[];
  enrichedFacts: EnrichedFact[];
}

export function FactPanel({ canonicalFacts, decodedFacts, enrichedFacts }: FactPanelProps) {
  return (
    <div className="fact-panel">
      <Group
        provenance="canonical"
        title="Canonical proposal actions"
        verified
        note="Recorded exactly as the proposal encodes them, including actions Gavel cannot interpret."
        count={canonicalFacts.length}
      >
        {canonicalFacts.map((fact) => (
          <CanonicalCard key={`canonical-${fact.actionIndex}`} fact={fact} />
        ))}
      </Group>
      <Group
        provenance="decoded"
        title="Decoded actions"
        verified
        note="Produced by the versioned allowlist decoder from the canonical action above."
        count={decodedFacts.length}
      >
        {decodedFacts.map((fact) => (
          <DecodedCard key={`decoded-${fact.actionIndex}-${fact.kind}`} fact={fact} />
        ))}
      </Group>
      <Group
        provenance="enriched"
        title="Enriched context"
        verified={false}
        note="Convenience lookups such as ENS and token names. Treat these as unverified labels."
        count={enrichedFacts.length}
      >
        {enrichedFacts.map((fact, index) => (
          <EnrichedCard key={`enriched-${index}`} fact={fact} />
        ))}
      </Group>
    </div>
  );
}
