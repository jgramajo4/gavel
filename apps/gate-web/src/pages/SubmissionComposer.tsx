import { useCallback, useEffect, useMemo, useState } from 'react';
import { GateApiError, type GateApi } from '../api';
import { useSession } from '../session';
import { useWalletConnection } from '../wallet-connection';
import { isSessionForRole, openWalletSession } from '../wallet-session';
import { MarkdownPitch } from '../components/MarkdownPitch';
import { formatUsdc } from '../format';
import {
  MAX_DISCLOSURE_CODE_POINTS,
  MAX_EVIDENCE_URLS,
  MAX_PITCH_CODE_POINTS,
} from '../gate-domain';
import type { Eip1193Provider } from '../wallet';
import type { DuplicateReceipt, PublicGateProfile, SubmissionReceipt, SubmissionRequest } from '../types';

/**
 * Composes one immutable paid pitch.
 *
 * Client-side limits exist so an advocate learns about a problem while typing
 * rather than after a round trip. They are UX, not policy: whatever the server
 * returns wins, and a server rejection is shown verbatim even when the client
 * believed the draft was fine.
 *
 * Evidence URLs are recorded and displayed as advocate-provided references.
 * They are never fetched, resolved, previewed, unfurled, or summarized, and
 * nothing in the draft is ever sent to a model.
 *
 * A 409 duplicate is a recoverable receipt, not an error: the flow follows the
 * server's resume URL and displays the ORIGINAL quote. It never asks for a
 * second quote, a fresh signature, or a new reservation.
 */

const EMPTY_EVIDENCE = Array.from({ length: MAX_EVIDENCE_URLS }, () => '');

function codePoints(value: string): number {
  return Array.from(value).length;
}

function validateDraft(draft: {
  proposalId: string;
  position: string;
  pitch: string;
  disclosures: string;
  evidenceUrls: string[];
}): string | null {
  if (!draft.proposalId.trim()) return 'Enter the proposal ID this pitch is about.';
  if (!draft.position.trim()) return 'Enter the position you are advocating for.';
  if (codePoints(draft.pitch) === 0) return 'Enter a pitch.';
  if (codePoints(draft.pitch) > MAX_PITCH_CODE_POINTS) {
    return `Pitch must be at most ${MAX_PITCH_CODE_POINTS} characters.`;
  }
  if (codePoints(draft.disclosures) > MAX_DISCLOSURE_CODE_POINTS) {
    return `Disclosures must be at most ${MAX_DISCLOSURE_CODE_POINTS} characters.`;
  }
  const urls = draft.evidenceUrls.map((url) => url.trim()).filter(Boolean);
  if (urls.length > MAX_EVIDENCE_URLS) return `Include at most ${MAX_EVIDENCE_URLS} evidence URLs.`;
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return 'Each evidence URL must be a complete HTTPS URL.';
    }
    if (parsed.protocol !== 'https:') return 'Each evidence URL must use HTTPS.';
  }
  return null;
}

export interface SubmissionComposerProps {
  api: GateApi;
  /** Target voter being lobbied — never the advocate/payer. */
  wallet: string;
  /** Injected EIP-1193 provider used to obtain a `base_sender` session. */
  provider: Eip1193Provider;
  onQuote?(receipt: SubmissionReceipt): void;
}

function sessionUnexpired(expiry: string): boolean {
  try {
    return BigInt(expiry) > BigInt(Math.floor(Date.now() / 1000));
  } catch {
    return false;
  }
}

export function SubmissionComposer({ api, wallet, provider, onQuote }: SubmissionComposerProps) {
  const { session, setSession, clearSession } = useSession();
  const { address, connect, noteConnected } = useWalletConnection();
  const senderSession = isSessionForRole(session, 'base_sender') ? session : null;
  const expiredSender = Boolean(senderSession && !sessionUnexpired(senderSession.session.expiry));
  const authenticated = Boolean(
    senderSession &&
      !expiredSender &&
      address &&
      address.toLowerCase() === senderSession.session.wallet.toLowerCase(),
  );
  const [profile, setProfile] = useState<PublicGateProfile | null>(null);
  const [proposalId, setProposalId] = useState('');
  const [position, setPosition] = useState('');
  const [pitch, setPitch] = useState('');
  const [disclosures, setDisclosures] = useState('');
  const [evidenceUrls, setEvidenceUrls] = useState<string[]>(EMPTY_EVIDENCE);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getGate(wallet)
      .then((result) => {
        if (!cancelled) setProfile(result);
      })
      .catch(() => {
        if (!cancelled) setProfile(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api, wallet]);

  useEffect(() => {
    if (expiredSender) clearSession();
  }, [expiredSender, clearSession]);

  const policy = profile?.policies?.[0];
  const setEvidence = useCallback((index: number, value: string) => {
    setEvidenceUrls((current) => current.map((url, position) => (position === index ? value : url)));
  }, []);

  const request = useMemo<SubmissionRequest>(
    () => ({
      dao: 'nouns',
      proposalId: proposalId.trim(),
      stage: 'VOTING',
      position: position.trim(),
      // Raw text is passed through byte-for-byte: no trimming, no whitespace
      // normalization, no smart quotes. The hash the server signs must cover
      // exactly what the advocate wrote.
      pitch,
      disclosures,
      evidenceUrls: evidenceUrls.map((url) => url.trim()).filter(Boolean),
    }),
    [proposalId, position, pitch, disclosures, evidenceUrls],
  );

  const authenticate = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const { account, verified } = await openWalletSession({
        api,
        provider,
        role: 'base_sender',
        account: address,
      });
      noteConnected(account);
      setSession(verified);
    } catch (cause: unknown) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Wallet sign-in failed. Nothing was signed and no session was created.',
      );
    } finally {
      setBusy(false);
    }
  }, [api, provider, address, noteConnected, setSession]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setError(null);
      setNotice(null);
      if (!authenticated || !senderSession) {
        setError('Connect your wallet and sign in before requesting a quote.');
        return;
      }
      const problem = validateDraft({ proposalId, position, pitch, disclosures, evidenceUrls });
      if (problem) {
        setError(problem);
        return;
      }
      setBusy(true);
      try {
        const result = await api.createSubmission(senderSession.token, wallet, request);
        if ((result as DuplicateReceipt).state === 'duplicate') {
          const duplicate = result as DuplicateReceipt;
          // Frozen recovery path: resume the existing quote, never reissue.
          const resumed = await api.resumeSubmission(senderSession.token, duplicate.existing.resumeUrl);
          if (!resumed) {
            setError('This submission already exists, but its quote could not be recovered.');
            return;
          }
          setNotice('You already submitted this pitch. Your existing quote was recovered unchanged.');
          onQuote?.(resumed);
          return;
        }
        onQuote?.(result as SubmissionReceipt);
      } catch (cause: unknown) {
        if (cause instanceof GateApiError && cause.status === 401) {
          clearSession();
          setError('Your advocate session expired. Sign in with wallet again to request a quote.');
          return;
        }
        // The server is authoritative; its wording is shown as-is.
        setError(
          cause instanceof GateApiError
            ? cause.message
            : 'The quote request failed. Nothing was submitted and nothing was charged.',
        );
      } finally {
        setBusy(false);
      }
    },
    [api, authenticated, senderSession, wallet, request, proposalId, position, pitch, disclosures, evidenceUrls, onQuote, clearSession],
  );

  return (
    <div className="page page-composer">
      <h1>Paid submission</h1>
      <p className="page-intro">
        One immutable pitch to <span className="composer-target">{profile?.ens || wallet}</span>.
        {policy ? ` Attention price ${formatUsdc(policy.attentionAmount)} plus a ${formatUsdc(policy.gavelFeeAmount)} Gavel service fee.` : ''}
      </p>

      <form className="composer" aria-label="Paid submission" onSubmit={submit}>
        <div className="field">
          <label htmlFor="proposal-id">Proposal ID</label>
          <input id="proposal-id" value={proposalId} onChange={(event) => setProposalId(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="position">Position</label>
          <input id="position" value={position} onChange={(event) => setPosition(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pitch">Pitch (Markdown, max {MAX_PITCH_CODE_POINTS} characters)</label>
          <textarea
            id="pitch"
            rows={12}
            maxLength={MAX_PITCH_CODE_POINTS}
            value={pitch}
            onChange={(event) => setPitch(event.target.value)}
          />
          <p className="counter">
            {codePoints(pitch)} / {MAX_PITCH_CODE_POINTS}
          </p>
        </div>
        <div className="field">
          <label htmlFor="disclosures">Disclosures (max {MAX_DISCLOSURE_CODE_POINTS} characters)</label>
          <textarea
            id="disclosures"
            rows={5}
            maxLength={MAX_DISCLOSURE_CODE_POINTS}
            value={disclosures}
            onChange={(event) => setDisclosures(event.target.value)}
          />
          <p className="counter">
            {codePoints(disclosures)} / {MAX_DISCLOSURE_CODE_POINTS}
          </p>
        </div>

        <fieldset className="field evidence">
          <legend>Evidence links (up to {MAX_EVIDENCE_URLS}, HTTPS only)</legend>
          <p className="composer-note">
            Evidence links are advocate-provided references only. Gavel never opens or retrieves them.
          </p>
          {evidenceUrls.map((url, index) => (
            <div className="field" key={index}>
              <label htmlFor={`evidence-${index}`}>Evidence URL {index + 1}</label>
              <input
                id={`evidence-${index}`}
                inputMode="url"
                value={url}
                onChange={(event) => setEvidence(index, event.target.value)}
              />
            </div>
          ))}
        </fieldset>

        {error ? (
          <p role="alert" className="notice notice-error">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="notice notice-info">
            {notice}
          </p>
        ) : null}

        {authenticated ? (
          <button type="submit" disabled={busy}>
            Request quote
          </button>
        ) : address ? (
          <button type="button" disabled={busy} onClick={() => void authenticate()}>
            {busy ? 'Waiting for your wallet…' : 'Sign in with wallet'}
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => void connect()}>
            {busy ? 'Connecting…' : 'Connect wallet'}
          </button>
        )}
      </form>

      {/* Formatting is shown exactly as the allowlist will render it. Nothing
          here resolves, unfurls, or describes a linked destination. */}
      <section className="composer-preview" aria-label="Rendered submission">
        <h2>Rendered submission</h2>
        <MarkdownPitch source={pitch} />
      </section>
    </div>
  );
}
