import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { EnsProvider, createEnsResolver, isRenderableEnsName, useEnsName } from './ens';
import { WalletIdentity } from './components/WalletIdentity';
import type { EnsResolver } from './ens';

const ADDRESS = '0x650C1B4D2f5B9e3a0f8C7d6E5a4B3c2d1E0f50E1';
const SHORT = '0x650C…50E1';

function resolverFor(names: Record<string, string | null>): EnsResolver & { lookups: string[] } {
  const lookups: string[] = [];
  return {
    lookups,
    async lookup(address: string) {
      lookups.push(address);
      return names[address] ?? null;
    },
  };
}

function Probe({ address, provided }: { address?: string | null; provided?: string | null }) {
  const name = useEnsName(address, provided);
  return <span data-testid="name">{name ?? 'none'}</span>;
}

function renderProbe(node: React.ReactElement, resolver: EnsResolver | null = null) {
  return render(<EnsProvider resolver={resolver}>{node}</EnsProvider>);
}

describe('createEnsResolver', () => {
  it('is null unless an operator configured an HTTPS endpoint', () => {
    // No endpoint, no browser resolution, no network: the directory simply
    // renders shortened addresses.
    expect(createEnsResolver(undefined)).toBeNull();
    expect(createEnsResolver('')).toBeNull();
    expect(createEnsResolver('   ')).toBeNull();
  });

  it('refuses a non-HTTPS endpoint rather than downgrading the lookup', () => {
    expect(createEnsResolver('http://rpc.example.com')).toBeNull();
    expect(createEnsResolver('ws://rpc.example.com')).toBeNull();
    expect(createEnsResolver('javascript:alert(1)')).toBeNull();
  });

  it('builds a resolver when one is configured', () => {
    expect(createEnsResolver('https://rpc.example.com')).not.toBeNull();
  });
});

describe('isRenderableEnsName', () => {
  it('accepts an ordinary lowercase ENS name', () => {
    expect(isRenderableEnsName('voter.eth')).toBe(true);
    expect(isRenderableEnsName('gavel-gate.voter.eth')).toBe(true);
  });

  it('rejects anything that could impersonate another identity on screen', () => {
    // A reverse record is attacker-chosen text. Mixed scripts, bidi overrides,
    // whitespace, and markup never reach a surface that says who to pay.
    expect(isRenderableEnsName('vоter.eth')).toBe(false); // Cyrillic о
    expect(isRenderableEnsName('voter‮.eth')).toBe(false);
    expect(isRenderableEnsName('voter .eth')).toBe(false);
    expect(isRenderableEnsName('<b>voter</b>.eth')).toBe(false);
    expect(isRenderableEnsName('0x650C1B4D2f5B9e3a0f8C7d6E5a4B3c2d1E0f50E1')).toBe(false);
    expect(isRenderableEnsName('voter')).toBe(false);
    expect(isRenderableEnsName('')).toBe(false);
    expect(isRenderableEnsName(null)).toBe(false);
    expect(isRenderableEnsName(`${'a'.repeat(200)}.eth`)).toBe(false);
  });
});

describe('useEnsName', () => {
  it('returns nothing when no resolver is configured', () => {
    renderProbe(<Probe address={ADDRESS} />);
    expect(screen.getByTestId('name')).toHaveTextContent('none');
  });

  it('resolves through the configured resolver', async () => {
    renderProbe(<Probe address={ADDRESS} />, resolverFor({ [ADDRESS]: 'voter.eth' }));
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('voter.eth'));
  });

  it('prefers the value the server already indexed and resolves nothing itself', async () => {
    const resolver = resolverFor({ [ADDRESS]: 'resolved.eth' });
    renderProbe(<Probe address={ADDRESS} provided="indexed.eth" />, resolver);
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('indexed.eth'));
    expect(resolver.lookups).toEqual([]);
  });

  it('falls back to resolution when the server value is unusable', async () => {
    const resolver = resolverFor({ [ADDRESS]: 'voter.eth' });
    renderProbe(<Probe address={ADDRESS} provided="vоter.eth" />, resolver);
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('voter.eth'));
    expect(resolver.lookups).toEqual([ADDRESS]);
  });

  it('rejects a resolved name that fails the render gate', async () => {
    renderProbe(<Probe address={ADDRESS} />, resolverFor({ [ADDRESS]: 'v‮oter.eth' }));
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('none'));
  });

  it('does not look up an absent address', () => {
    const resolver = resolverFor({});
    renderProbe(<Probe address={null} />, resolver);
    expect(resolver.lookups).toEqual([]);
  });
});

describe('WalletIdentity', () => {
  it('shows the name first and the shortened address second', async () => {
    renderProbe(<WalletIdentity address={ADDRESS} ens="voter.eth" />);
    expect(screen.getByText('voter.eth')).toHaveClass('wallet-identity-primary');
    expect(screen.getByText(SHORT)).toHaveClass('wallet-identity-secondary');
  });

  it('shows the shortened address alone when there is no name', () => {
    const { container } = renderProbe(<WalletIdentity address={ADDRESS} />);
    expect(screen.getByText(SHORT)).toHaveClass('wallet-identity-primary');
    expect(container.querySelector('.wallet-identity-secondary')).toBeNull();
  });

  it('never renders the same full address twice, or at all', () => {
    const { container } = renderProbe(<WalletIdentity address={ADDRESS} ens="voter.eth" />);
    expect(container.textContent).not.toContain(ADDRESS);
    expect(container.textContent?.match(/0x650C…50E1/g)).toHaveLength(1);
  });

  it('keeps the canonical address reachable without printing it', () => {
    renderProbe(<WalletIdentity address={ADDRESS} ens="voter.eth" />);
    expect(screen.getByText('voter.eth')).toHaveAttribute('title', ADDRESS);
  });
});
