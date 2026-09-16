import '@testing-library/jest-dom/vitest';
import { afterEach, expect } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());

// Any test that reaches the network has escaped its boundary. Evidence URLs in
// particular must never be fetched, previewed, scraped, or summarized, so an
// unstubbed fetch is a hard failure rather than a silent request.
const forbiddenFetch = (input: unknown) => {
  throw new Error(`unexpected network request: ${String(input)}`);
};
Object.defineProperty(globalThis, 'fetch', { value: forbiddenFetch, writable: true, configurable: true });

expect.extend({});
