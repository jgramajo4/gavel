import type { ReactNode } from 'react';
import { httpsUrlOrNull } from '../safe-url';

/**
 * Renders an advocate-supplied URL as a link only when it is absolute HTTPS.
 *
 * Anything else renders as inert text: still visible, so a reader can see what
 * was submitted, but with no `href` and therefore no navigation or protocol
 * handler. Every advocate-supplied URL in the app goes through this component,
 * so a future private-inbox implementation cannot reintroduce a raw
 * `href={url}` without deleting this on purpose.
 */
export function ExternalLink({
  href,
  children,
  className,
}: {
  href: string;
  children?: ReactNode;
  className?: string;
}) {
  const safe = httpsUrlOrNull(href);
  const label = children ?? href;

  if (safe === null) {
    return (
      <span className={className ? `inert-link ${className}` : 'inert-link'} data-blocked-url="true">
        {label}
      </span>
    );
  }

  return (
    <a
      className={className ? `external-link ${className}` : 'external-link'}
      href={safe}
      rel="noopener noreferrer"
      target="_blank"
    >
      {label}
      <span className="external-indicator" aria-label="external link">
        ↗
      </span>
    </a>
  );
}
