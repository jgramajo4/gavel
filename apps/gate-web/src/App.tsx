import { useCallback, useState } from 'react';
import { Link, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import type { GateApi } from './api';
import type { Eip1193Provider } from './wallet';
import type { SubmissionReceipt } from './types';
import { GateDirectory } from './pages/GateDirectory';
import { GateProfile } from './pages/GateProfile';
import { SubmissionComposer } from './pages/SubmissionComposer';
import { Checkout } from './pages/Checkout';
import { VoterInbox } from './pages/VoterInbox';
import { Enrollment } from './pages/Enrollment';

/** Route params are untrusted strings; a malformed wallet never reaches the API. */
const WALLET = /^0x[0-9a-fA-F]{40}$/;

function NotFound() {
  return (
    <div className="page">
      <h1>Not found</h1>
      <p>
        No Gate page matches this address. <Link to="/">Back to the directory</Link>.
      </p>
    </div>
  );
}

function ProfileRoute({ api }: { api: GateApi }) {
  const { wallet } = useParams();
  if (!wallet || !WALLET.test(wallet)) return <NotFound />;
  return <GateProfile api={api} wallet={wallet} />;
}

function ComposerRoute({ api }: { api: GateApi }) {
  const { wallet } = useParams();
  const navigate = useNavigate();
  const onQuote = useCallback(
    (receipt: SubmissionReceipt) => {
      // The quote travels in router state so checkout renders the exact object
      // the server returned; a reload falls back to the resume endpoint.
      navigate(`/checkout/${receipt.publicId}`, { state: { receipt } });
    },
    [navigate],
  );
  if (!wallet || !WALLET.test(wallet)) return <NotFound />;
  return <SubmissionComposer api={api} wallet={wallet} onQuote={onQuote} />;
}

function CheckoutRoute({ api, wallet }: { api: GateApi; wallet: Eip1193Provider }) {
  const { publicId } = useParams();
  const [receipt] = useState<SubmissionReceipt | undefined>(
    () => (window.history.state?.usr?.receipt as SubmissionReceipt | undefined) ?? undefined,
  );
  if (!publicId) return <NotFound />;
  return <Checkout api={api} wallet={wallet} publicId={publicId} receipt={receipt} />;
}

export function App({ api, wallet }: { api: GateApi; wallet: Eip1193Provider }) {
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="app-header">
        <p className="brand">Gavel Gate</p>
        <nav aria-label="Primary">
          <NavLink to="/">Directory</NavLink>
          <NavLink to="/inbox">Inbox</NavLink>
          <NavLink to="/enroll">Enroll</NavLink>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<GateDirectory api={api} />} />
          <Route path="/gates/:wallet" element={<ProfileRoute api={api} />} />
          <Route path="/gates/:wallet/compose" element={<ComposerRoute api={api} />} />
          <Route path="/checkout/:publicId" element={<CheckoutRoute api={api} wallet={wallet} />} />
          <Route path="/inbox" element={<VoterInbox />} />
          <Route path="/enroll" element={<Enrollment api={api} wallet={wallet} />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <footer className="app-footer">
        <p>
          Experimental. Gavel verifies quotes, routing, settlement, and inbox creation — not voter
          attention or persuasion. Payments are final.
        </p>
      </footer>
    </div>
  );
}
