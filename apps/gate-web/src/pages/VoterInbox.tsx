import { Link } from 'react-router-dom';

/**
 * Product-gap page for the private voter inbox.
 *
 * The merged backend (PR4–PR6) serves no private inbox route. This page is
 * deliberately static: it holds no API client, issues no request, and declares
 * no response shape. A speculative client for a route that does not exist would
 * become that route's undeclared contract the first time some future response
 * returned 200, so there is nothing here to bypass.
 */
export function VoterInbox() {
  return (
    <div className="page page-inbox">
      <h1>Voter inbox</h1>
      <p role="status" className="notice">
        The private voter inbox is not available in this deployment yet. Paid submissions that settle
        on chain are recorded by the server, but there is no inbox API to read them from here.
      </p>
      <p className="page-intro">
        Public Gate discovery, profiles, enrollment, and paid submission checkout all work today.{' '}
        <Link to="/">Browse the Gate directory</Link>.
      </p>
    </div>
  );
}
