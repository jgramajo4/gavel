import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownPitch } from './MarkdownPitch';

describe('MarkdownPitch', () => {
  it('renders the allowlisted CommonMark subset', () => {
    render(
      <MarkdownPitch
        source={'# Heading\n\nA **bold** and *italic* line with `code`.\n\n> quoted\n\n- one\n- two\n\n1. first\n\n```\nfenced\n```'}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('italic').tagName).toBe('EM');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getByText('quoted').closest('blockquote')).not.toBeNull();
    expect(screen.getByText('one').closest('ul')).not.toBeNull();
    expect(screen.getByText('first').closest('ol')).not.toBeNull();
    expect(screen.getByText(/fenced/).closest('pre')).not.toBeNull();
  });

  it('rejects raw HTML instead of rendering it', () => {
    const { container } = render(<MarkdownPitch source={'<script>alert(1)</script>\n\n<b>bold</b>'} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot be displayed/i);
  });

  it('rejects unsafe link protocols', () => {
    for (const source of [
      '[x](javascript:alert(1))',
      '[x](data:text/html;base64,PHNjcmlwdD4=)',
      '[x](file:///etc/passwd)',
      '[x](http://insecure.example.com)',
    ]) {
      const { container, unmount } = render(<MarkdownPitch source={source} />);
      expect(container.querySelector('a')).toBeNull();
      expect(screen.getByRole('alert')).toBeInTheDocument();
      unmount();
    }
  });

  it('does not render images, embeds, or Mermaid diagrams', () => {
    const { container, unmount } = render(
      <MarkdownPitch source={'![alt](https://example.com/a.png)\n\n<iframe src="https://example.com"></iframe>'} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    unmount();

    // A Mermaid fence is rejected outright by the frozen allowlist; it is never
    // rendered as a diagram and never smuggled through as a plain code block.
    const mermaid = render(<MarkdownPitch source={'```mermaid\ngraph TD; A-->B;\n```'} />);
    expect(mermaid.container.querySelector('.mermaid')).toBeNull();
    expect(mermaid.container.querySelector('svg')).toBeNull();
    expect(mermaid.container.querySelector('pre')).toBeNull();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('marks external HTTPS links as external and safe', () => {
    const { container } = render(<MarkdownPitch source={'[docs](https://example.org/spec)'} />);
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', 'https://example.org/spec');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link?.textContent).toMatch(/docs/);
    // A visible indicator that the link leaves the app.
    expect(screen.getByLabelText('external link')).toBeInTheDocument();
  });

  it('never auto-links a bare URL', () => {
    const { container } = render(<MarkdownPitch source={'see https://example.org/raw for details'} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('https://example.org/raw');
  });
});
