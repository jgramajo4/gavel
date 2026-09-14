const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateMarkdown,
  renderMarkdown,
  validatePitchMarkdown,
  validateDisclosureMarkdown,
} = require('../src');

const allowed = [
  '# Heading',
  '',
  'A **bold** and *italic* [source](https://example.com/path?q=1).  ',
  'next line with `code`.',
  '',
  '- one',
  '- two',
  '',
  '1. ordered',
  '',
  '> quote',
  '',
  '```js',
  'const x = 1;',
  '```',
].join('\n');

test('preserves allowed CommonMark and returns a safe token representation', () => {
  const result = validateMarkdown(allowed);
  assert.equal(result.source, allowed);
  assert.ok(result.tokens.some((token) => token.type === 'heading_open'));
  assert.ok(result.tokens.some((token) => token.type === 'fence'));
  const inline = result.tokens.find((token) => token.type === 'inline');
  assert.ok(inline, 'validated render stream retains its inline container');
  const link = result.tokens
    .flatMap((token) => token.children || [])
    .find((token) => token.type === 'link_open');
  assert.deepEqual(link.link, {
    href: 'https://example.com/path?q=1',
    external: true,
    rel: 'noopener noreferrer',
  });
});

test('raw HTML remains malformed when the safe parser tokenizes it as text', () => {
  for (const source of ['<b>raw</b>', 'before <span>raw</span> after']) {
    assert.throws(() => validateMarkdown(source), (error) => error.code === 'malformed');
    assert.throws(() => renderMarkdown(source), (error) => error.code === 'malformed');
  }
});

test('a disallowed token cannot enter the validated render stream', () => {
  for (const source of [
    'allowed paragraph\n\n![image](https://example.com/image.png)',
    'allowed paragraph\n\n---',
  ]) {
    assert.throws(() => renderMarkdown(source), (error) => error.code === 'malformed');
  }
});

test('renders validated CommonMark with escaped code and hardened HTTPS links', () => {
  const source = '[source](https://example.com/a?x=1&y=2) and `<script>`';
  const html = renderMarkdown(source);

  assert.match(html, /href="https:\/\/example\.com\/a\?x=1&amp;y=2"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /aria-label="external link">↗<\/span>/);
  assert.match(html, /<code>&lt;script&gt;<\/code>/);
  assert.throws(() => renderMarkdown('<script>alert(1)</script>'), (error) => error.code === 'malformed');
});

test('rejects raw HTML, images, Mermaid, autolinks, and disallowed nodes as malformed', () => {
  const rejected = [
    '<b>raw</b>',
    '<style>body { color: red }</style>',
    '<iframe src="https://example.com"></iframe>',
    '<script>alert(1)</script>',
    '![alt](https://example.com/image.png)',
    '<https://example.com>',
    '```mermaid\ngraph TD; A-->B\n```',
    '---',
    '    indented code',
  ];

  for (const source of rejected) {
    assert.throws(
      () => validateMarkdown(source),
      (error) => error.code === 'malformed' && error.name === 'MarkdownValidationError',
      source,
    );
  }
});

test('rejects every non-HTTPS, relative, or malformed explicit link', () => {
  for (const href of [
    'http://example.com',
    'mailto:test@example.com',
    'data:text/plain,hello',
    'javascript:alert(1)',
    'file:///tmp/a',
    '/relative',
    'https://',
  ]) {
    assert.throws(() => validateMarkdown(`[link](${href})`), (error) => error.code === 'malformed');
  }
});

test('counts pitch and disclosure limits by Unicode code points', () => {
  assert.equal(validatePitchMarkdown('🙂'.repeat(4000)).source, '🙂'.repeat(4000));
  assert.throws(() => validatePitchMarkdown('🙂'.repeat(4001)), /4000 Unicode code points/);
  assert.equal(validateDisclosureMarkdown('🙂'.repeat(2000)).source, '🙂'.repeat(2000));
  assert.throws(() => validateDisclosureMarkdown('🙂'.repeat(2001)), /2000 Unicode code points/);
});

test('never fetches or previews HTTPS links', () => {
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = () => {
    called = true;
    throw new Error('network access forbidden');
  };
  try {
    validateMarkdown('[source](https://example.com)');
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
  }
});
