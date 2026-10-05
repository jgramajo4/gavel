import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { SubmissionReceipt } from './types';
import { useServices } from './services';
import { GateDirectory } from './pages/GateDirectory';
import { GateProfile } from './pages/GateProfile';
import { SubmissionComposer } from './pages/SubmissionComposer';
import { Checkout } from './pages/Checkout';
import { VoterInbox } from './pages/VoterInbox';
import { Enrollment } from './pages/Enrollment';
import { Home } from './pages/Home';
import { Install } from './pages/Install';
import { DaoIndex, DaoRoute, ProposalRoute } from './pages/DaoPage';
import { NotFound } from './pages/NotFound';
import { WalletControl } from './components/WalletControl';
import { SessionWalletBinding } from './session-binding';
import { legacyGateTarget, paths, PUBLIC_ID_PARAM, WALLET_PARAM } from './routes';

const DOCS_URL = 'https://github.com/jgramajo4/gavel#readme';

/** The Gavel mark, identical to `public/favicon.svg`. */
function GavelMark() {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true" className="wordmark-mark">
      <path d="M8 8h24v6H14v12h12v-4h-7v-6h13v16H8z" fill="currentColor" />
    </svg>
  );
}

/**
 * Gate pages are keyed by the entity in the URL. Moving from one voter's
 * profile, composer, or checkout to another's remounts the page, so no label,
 * quote, form, or in-flight response from the previous entity can render
 * under the new one.
 */
function ProfileRoute() {
  const { gate } = useServices();
  const { wallet } = useParams();
  if (!wallet || !WALLET_PARAM.test(wallet)) return <NotFound what="Gate profile" />;
  return <GateProfile key={wallet.toLowerCase()} api={gate} wallet={wallet} />;
}

function ComposerRoute() {
  const { gate, wallet: provider } = useServices();
  const { wallet: voter } = useParams();
  const navigate = useNavigate();
  const onQuote = useCallback(
    (receipt: SubmissionReceipt) => {
      // The quote travels in router state so checkout renders the exact object
      // the server returned; a reload falls back to the resume endpoint.
      navigate(paths.gateCheckout(receipt.publicId), { state: { receipt } });
    },
    [navigate],
  );
  if (!voter || !WALLET_PARAM.test(voter)) return <NotFound what="Gate profile" />;
  return (
    <SubmissionComposer key={voter.toLowerCase()} api={gate} wallet={voter} provider={provider} onQuote={onQuote} />
  );
}

function CheckoutRoute() {
  const { gate, wallet } = useServices();
  const { publicId } = useParams();
  const location = useLocation();
  const stateReceipt = (location.state as { receipt?: SubmissionReceipt } | null)?.receipt;
  // Router state is only trusted for the quote this URL names. It is display
  // seed only: Checkout re-authorizes against the persisted quote before paying.
  const receipt = stateReceipt && stateReceipt.publicId === publicId ? stateReceipt : undefined;
  if (!publicId || !PUBLIC_ID_PARAM.test(publicId)) return <NotFound what="checkout" />;
  return <Checkout key={publicId} api={gate} wallet={wallet} publicId={publicId} receipt={receipt} />;
}

function InboxRoute() {
  const { gate, wallet } = useServices();
  return <VoterInbox api={gate} wallet={wallet} />;
}

function EnrollRoute() {
  const { gate, wallet } = useServices();
  return <Enrollment api={gate} wallet={wallet} />;
}

function DirectoryRoute() {
  const { gate } = useServices();
  return <GateDirectory api={gate} />;
}

/** Gate is a capability of Gavel: its own sub-navigation inside the global shell. */
function GateLayout() {
  return (
    <>
      <nav className="sub-nav" aria-label="Gate">
        <NavLink to={paths.gate} end>
          Directory
        </NavLink>
        <NavLink to={paths.gateInbox}>Inbox</NavLink>
        <NavLink to={paths.gateEnroll}>Enroll</NavLink>
      </nav>
      <Outlet />
    </>
  );
}

/**
 * Old gate.0773h.com paths that reach this origin (edge host-swap redirect,
 * or an old link) are forwarded to their canonical route. One mapping,
 * defined in routes.ts.
 */
function LegacyGateRedirect() {
  const location = useLocation();
  const target = legacyGateTarget(location.pathname, location.search);
  return target ? <Navigate to={target} replace /> : <NotFound />;
}

export function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMenuOpen(false), [location.pathname]);

  return (
    <div className="app">
      <SessionWalletBinding />
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="app-header">
        <div className="app-header-inner">
          <Link className="wordmark" to={paths.home} aria-label="Gavel home">
            <GavelMark />
            <span className="wordmark-text">
              gavel<span className="wordmark-dot">.</span>
            </span>
          </Link>
          <button
            type="button"
            className="menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="primary-nav"
            onClick={() => setMenuOpen((open) => !open)}
          >
            Menu
          </button>
          {/* My Governance (/me) joins this nav when it ships; it is reserved, not built. */}
          <nav id="primary-nav" aria-label="Primary" data-open={menuOpen}>
            <NavLink to={paths.daos}>DAOs</NavLink>
            <NavLink to={paths.gate}>Gate</NavLink>
            <NavLink to={paths.install}>Install</NavLink>
            <a href={DOCS_URL} rel="noopener noreferrer" target="_blank">
              Docs
            </a>
          </nav>
          <WalletControl />
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/daos" element={<DaoIndex />} />
          <Route path="/daos/:dao" element={<DaoRoute />} />
          <Route path="/daos/:dao/proposals/:id" element={<ProposalRoute />} />
          <Route path="/daos/:dao/:section" element={<DaoRoute />} />
          <Route path="/gate" element={<GateLayout />}>
            <Route index element={<DirectoryRoute />} />
            <Route path="voters/:wallet" element={<ProfileRoute />} />
            <Route path="voters/:wallet/compose" element={<ComposerRoute />} />
            <Route path="checkout/:publicId" element={<CheckoutRoute />} />
            <Route path="inbox" element={<InboxRoute />} />
            <Route path="enroll" element={<EnrollRoute />} />
          </Route>
          <Route path="/install" element={<Install />} />
          {/* Legacy gate.0773h.com paths. */}
          <Route path="/gates/*" element={<LegacyGateRedirect />} />
          <Route path="/checkout/*" element={<LegacyGateRedirect />} />
          <Route path="/inbox" element={<LegacyGateRedirect />} />
          <Route path="/enroll" element={<LegacyGateRedirect />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <footer className="app-footer">
        <p>
          Experimental. Governance data comes from the Gavel Governance Indexer; recommendations are Gavel analysis,
          never authorization. Gate verifies quotes, routing, settlement and inbox delivery, not voter attention or
          persuasion. Gate payments are final.
        </p>
      </footer>
    </div>
  );
}
