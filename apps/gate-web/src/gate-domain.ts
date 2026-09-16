// Single typed entry point to the frozen `@gavel/gate` CommonJS domain package.
//
// The browser deliberately does NOT own a second copy of the Markdown allowlist
// or the EIP-3009 authorization derivation. Both are frozen server-side rules;
// re-implementing them here would let the two drift and would let the browser
// become a second, weaker authority.
//
// Only the submodules the browser needs are imported. The package root also
// exports settlement helpers that require `node:crypto`, which must never be
// pulled into a browser bundle. Default imports keep CommonJS interop identical
// under Vite, esbuild, and Vitest.
import markdownModule from '@gavel/gate/src/markdown.js';
import quoteModule from '@gavel/gate/src/quote.js';
import constantsModule from '@gavel/gate/src/constants.js';
import type { QuoteMessage } from './types';

export interface MarkdownToken {
  type: string;
  tag: string;
  nesting: number;
  content: string;
  markup: string;
  info: string;
  hidden: boolean;
  children: MarkdownToken[] | null;
  attrs: [string, string][] | null;
  attrGet(name: string): string | null;
}

export interface ValidatedMarkdown {
  source: string;
  tokens: MarkdownToken[];
}

/** Exactly the authorization the splitter will accept for this quote. */
export interface UsdcAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

interface GateConstants {
  MAX_PITCH_CODE_POINTS: number;
  MAX_DISCLOSURE_CODE_POINTS: number;
  MAX_EVIDENCE_URLS: number;
  GAVEL_FEE_AMOUNT: bigint;
  MIN_ATTENTION_AMOUNT: bigint;
  QUOTE_VERSION: number;
}

interface GateMarkdown {
  validateMarkdown(source: string): ValidatedMarkdown;
}

interface GateQuote {
  deriveUsdcAuthorization(message: QuoteMessage, splitter: string): UsdcAuthorization;
}

const constants = constantsModule as unknown as GateConstants;
const markdown = markdownModule as unknown as GateMarkdown;
const quote = quoteModule as unknown as GateQuote;

export const MAX_PITCH_CODE_POINTS = constants.MAX_PITCH_CODE_POINTS;
export const MAX_DISCLOSURE_CODE_POINTS = constants.MAX_DISCLOSURE_CODE_POINTS;
export const MAX_EVIDENCE_URLS = constants.MAX_EVIDENCE_URLS;
export const GAVEL_FEE_AMOUNT = constants.GAVEL_FEE_AMOUNT;
export const MIN_ATTENTION_AMOUNT = constants.MIN_ATTENTION_AMOUNT;
export const QUOTE_VERSION = constants.QUOTE_VERSION;

/**
 * Validates against the frozen CommonMark allowlist and returns the token
 * stream. Throws for raw HTML, images, embeds, or any non-HTTPS destination.
 */
export function validateMarkdown(source: string): ValidatedMarkdown {
  return markdown.validateMarkdown(source);
}

/**
 * Derives the EIP-3009 authorization from the signed quote alone. Every field
 * is a deterministic function of the persisted quote — the browser contributes
 * no value and can change none.
 */
export function deriveUsdcAuthorization(message: QuoteMessage, splitter: string): UsdcAuthorization {
  return quote.deriveUsdcAuthorization(message, splitter);
}
