import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { FactPanel } from './FactPanel';
import { canonicalFacts, decodedFacts, enrichedFacts } from '../test/fixtures';

describe('FactPanel', () => {
  const renderPanel = () =>
    render(
      <FactPanel
        canonicalFacts={canonicalFacts}
        decodedFacts={decodedFacts}
        enrichedFacts={enrichedFacts}
      />,
    );

  it('separates canonical, decoded, and enriched provenance', () => {
    renderPanel();
    const canonical = screen.getByRole('group', { name: /canonical/i });
    const decoded = screen.getByRole('group', { name: /decoded/i });
    const enriched = screen.getByRole('group', { name: /enriched/i });
    expect(within(decoded).getByText(/Native ETH transfer/)).toBeInTheDocument();
    expect(within(enriched).getByText('builder.eth')).toBeInTheDocument();
    expect(within(canonical).getByText(/Raw canonical action/)).toBeInTheDocument();
    expect(canonical.dataset.provenance).toBe('canonical');
    expect(decoded.dataset.provenance).toBe('decoded');
    expect(enriched.dataset.provenance).toBe('enriched');
  });

  it('does not present enriched facts as verified', () => {
    renderPanel();
    const enriched = screen.getByRole('group', { name: /enriched/i });
    expect(within(enriched).getByText(/display only/i)).toBeInTheDocument();
    expect(within(enriched).queryByText(/^verified$/i)).toBeNull();

    const canonical = screen.getByRole('group', { name: /canonical/i });
    const decoded = screen.getByRole('group', { name: /decoded/i });
    expect(within(canonical).getByText(/verified/i)).toBeInTheDocument();
    expect(within(decoded).getByText(/verified/i)).toBeInTheDocument();
  });

  it('keeps raw unknown actions visible rather than dropping them', () => {
    renderPanel();
    const canonical = screen.getByRole('group', { name: /canonical/i });
    expect(within(canonical).getByText('0xdeadbeef')).toBeInTheDocument();
    expect(within(canonical).getByText(/unknownCall\(bytes\)/)).toBeInTheDocument();
    expect(within(canonical).getByText(/0x8888888888888888888888888888888888888888/)).toBeInTheDocument();
  });

  it('adds no scoring, persuasion, or omission verdict', () => {
    const { container } = renderPanel();
    expect(container.textContent).not.toMatch(/score|persuasi|omission|misleading|credibility/i);
  });
});
