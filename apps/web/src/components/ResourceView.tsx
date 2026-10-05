import type { ReactNode } from 'react';
import type { Resource } from '../use-resource';

/**
 * Renders the shared error model consistently. The server's code is kept in a
 * data attribute and shown for defects, so nothing is flattened away.
 */
export function ResourceView<T>({
  resource,
  children,
  loading = 'Loading…',
}: {
  resource: Resource<T>;
  children: (data: T) => ReactNode;
  loading?: string;
}) {
  if (resource.status === 'idle') return null;
  if (resource.status === 'loading') return <p className="notice">{loading}</p>;
  if (resource.status === 'error') {
    const hint =
      resource.kind === 'retryable'
        ? ' Try again in a moment.'
        : resource.kind === 'defect'
          ? ` (${resource.code})`
          : '';
    return (
      <p role="alert" className="notice notice-error" data-error-kind={resource.kind} data-error-code={resource.code}>
        {resource.message}
        {hint}
      </p>
    );
  }
  return <>{children(resource.data)}</>;
}
