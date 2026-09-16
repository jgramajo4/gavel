import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExternalLink } from './ExternalLink';
import { httpsUrlOrNull } from '../safe-url';

/**
 * The single safe link primitive. Every advocate-supplied URL in the app must
 * go through it, so a future inbox implementation cannot reintroduce a raw
 * `href={url}` and hand a `javascript:` handler to a voter.
 */
describe('httpsUrlOrNull', () => {
  it('accepts only absolute HTTPS URLs', () => {
    expect(httpsUrlOrNull('https://example.org/spec')).toBe('https://example.org/spec');
    expect(httpsUrlOrNull('HTTPS://example.org/spec')).toBe('HTTPS://example.org/spec');
  });

  it('rejects every other protocol and malformed input', () => {
    expect(httpsUrlOrNull('http://example.org')).toBeNull();
    // eslint-disable-next-line no-script-url
    expect(httpsUrlOrNull('javascript:alert(1)')).toBeNull();
    expect(httpsUrlOrNull('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
    expect(httpsUrlOrNull('file:///etc/passwd')).toBeNull();
    expect(httpsUrlOrNull('vbscript:msgbox(1)')).toBeNull();
    expect(httpsUrlOrNull('not a url')).toBeNull();
    expect(httpsUrlOrNull('/relative/path')).toBeNull();
    expect(httpsUrlOrNull('')).toBeNull();
    expect(httpsUrlOrNull(undefined)).toBeNull();
    expect(httpsUrlOrNull(null)).toBeNull();
    expect(httpsUrlOrNull(42)).toBeNull();
  });
});

describe('ExternalLink', () => {
  it('links an HTTPS URL with safe attributes and an external indicator', () => {
    const { container } = render(<ExternalLink href="https://example.org/spec" />);
    const link = container.querySelector('a');
    expect(link).toHaveAttribute('href', 'https://example.org/spec');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByLabelText('external link')).toBeInTheDocument();
  });

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html;base64,PHNjcmlwdD4='],
    ['http', 'http://insecure.example.com'],
    ['malformed', 'not a url'],
  ])('renders a %s URL as inert text with no href', (_label, href) => {
    const { container } = render(<ExternalLink href={href} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[href]')).toBeNull();
    // The value stays visible so a reader can see what the advocate supplied.
    expect(container.textContent).toContain(href);
    expect(screen.queryByLabelText('external link')).toBeNull();
  });

  it('renders custom children instead of the raw URL when given', () => {
    render(<ExternalLink href="https://example.org/spec">docs</ExternalLink>);
    expect(screen.getByRole('link')).toHaveTextContent('docs');
  });
});
