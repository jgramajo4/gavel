const MarkdownIt = require('markdown-it');
const {
  MAX_PITCH_CODE_POINTS,
  MAX_DISCLOSURE_CODE_POINTS,
} = require('./constants');

const parser = new MarkdownIt('commonmark', {
  html: false,
  linkify: false,
  typographer: false,
});
const htmlDetector = new MarkdownIt('commonmark', {
  html: true,
  linkify: false,
  typographer: false,
});

// Let the parser expose all explicit link destinations; domain validation below
// applies the stricter HTTPS-only rule rather than silently treating them as text.
parser.validateLink = () => true;
const defaultLinkOpen = parser.renderer.rules.link_open
  || ((tokens, index, options, env, renderer) => renderer.renderToken(tokens, index, options));
parser.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, index, options, env, renderer);
};
const defaultLinkClose = parser.renderer.rules.link_close
  || ((tokens, index, options, env, renderer) => renderer.renderToken(tokens, index, options));
parser.renderer.rules.link_close = (tokens, index, options, env, renderer) => (
  `${defaultLinkClose(tokens, index, options, env, renderer)}<span aria-label="external link">↗</span>`
);

const ALLOWED_TOKEN_TYPES = new Set([
  'paragraph_open', 'paragraph_close',
  'heading_open', 'heading_close',
  'blockquote_open', 'blockquote_close',
  'bullet_list_open', 'bullet_list_close',
  'ordered_list_open', 'ordered_list_close',
  'list_item_open', 'list_item_close',
  'inline', 'text', 'softbreak', 'hardbreak',
  'strong_open', 'strong_close',
  'em_open', 'em_close',
  'code_inline', 'fence',
  'link_open', 'link_close',
]);

class MarkdownValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'MarkdownValidationError';
    this.code = 'malformed';
    this.details = details;
  }
}

function malformed(message, details) {
  throw new MarkdownValidationError(message, details);
}

function safeHttpsLink(href) {
  let parsed;
  try {
    parsed = new URL(href);
  } catch {
    malformed('link must be a valid absolute HTTPS URL', { href });
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    malformed('link must be a valid absolute HTTPS URL', { href });
  }
  return {
    href,
    external: true,
    rel: 'noopener noreferrer',
  };
}

function validateToken(token) {
  if (!ALLOWED_TOKEN_TYPES.has(token.type)) {
    malformed(`Markdown token is not allowed: ${token.type}`, { tokenType: token.type });
  }
  if (token.type === 'fence' && token.info.trim().split(/\s+/u)[0]?.toLowerCase() === 'mermaid') {
    malformed('Mermaid code fences are not allowed', { tokenType: token.type });
  }
  if (token.type === 'link_open' && token.markup === 'autolink') {
    malformed('autolinks are not allowed; use an explicit HTTPS link', { tokenType: token.type });
  }

  if (token.type === 'link_open') token.link = safeHttpsLink(token.attrGet('href'));
  if (token.children) token.children.forEach(validateToken);
  return token;
}

function containsHtmlToken(tokens) {
  return tokens.some((token) => (
    token.type === 'html_block'
    || token.type === 'html_inline'
    || (token.children && containsHtmlToken(token.children))
  ));
}

function validateMarkdown(source) {
  if (typeof source !== 'string') {
    malformed('Markdown source must be a string');
  }
  if (containsHtmlToken(htmlDetector.parse(source, {}))) {
    malformed('raw HTML is not allowed', { tokenType: 'html' });
  }
  const tokens = parser.parse(source, {});
  tokens.forEach(validateToken);
  return {
    source,
    tokens,
  };
}

function renderMarkdown(source) {
  const validated = validateMarkdown(source);
  return parser.renderer.render(validated.tokens, parser.options, {});
}

function validateLimitedMarkdown(source, maximum, label) {
  if (typeof source !== 'string') malformed(`${label} must be a string`);
  if (Array.from(source).length > maximum) {
    malformed(`${label} must contain at most ${maximum} Unicode code points`, { maximum });
  }
  return validateMarkdown(source);
}

function validatePitchMarkdown(source) {
  return validateLimitedMarkdown(source, MAX_PITCH_CODE_POINTS, 'pitch');
}

function validateDisclosureMarkdown(source) {
  return validateLimitedMarkdown(source, MAX_DISCLOSURE_CODE_POINTS, 'disclosure');
}

module.exports = {
  validateMarkdown,
  renderMarkdown,
  validatePitchMarkdown,
  validateDisclosureMarkdown,
};