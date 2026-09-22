/**
 * Remote outcome scoring, cached per proposal.
 *
 * Two things changed when Gavel stopped being single-DAO. The cache is keyed
 * by the composite `dao:proposalId`, because a bare proposal id collides
 * across DAOs and would have served one DAO's score for another's proposal.
 * And it lives under GAVEL_DATA_DIR rather than a fixed `~/.config` path, so
 * a standalone TUI, Hermes, Bankr and a container each keep their own private
 * state instead of sharing one file.
 *
 * Optimistic stale cache: the last result is shown instantly with a staleness
 * indicator. The fetch timeout IS the failure signal — no health ping.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { privatePath, resolveDataDir } from '@gavel/core';
import type { Config } from '../config.js';
import type { Prediction } from '../types.js';

/** Resolved per call so a changed GAVEL_DATA_DIR is honoured without a restart. */
function cacheFile(config: Config): string {
  return privatePath(config.dataDir || resolveDataDir(), 'prediction-cache.json');
}

const FETCH_TIMEOUT_MS = 30_000;

type Cache = Record<string, Prediction>;

async function readCache(config: Config): Promise<Cache> {
  try {
    const raw = await readFile(cacheFile(config), 'utf8');
    return JSON.parse(raw) as Cache;
  } catch {
    return {};
  }
}

async function writeCache(config: Config, cache: Cache): Promise<void> {
  try {
    const file = cacheFile(config);
    await mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Cache is best-effort; a write failure must never break the UI.
  }
}

export async function getCachedPrediction(
  config: Config,
  proposalKey: string,
): Promise<Prediction | null> {
  const cache = await readCache(config);
  return cache[proposalKey] ?? null;
}

export class ColdStartError extends Error {
  constructor() {
    super('Space cold-starting — retry in ~30s');
    this.name = 'ColdStartError';
  }
}

/**
 * Call the Gradio Space. Gradio exposes a `/run/predict` (or `/api/predict`)
 * REST endpoint that takes `{ data: [...] }` and returns `{ data: [...] }`.
 * We send the proposal text; the Space returns a pass/fail label + probability.
 */
export async function fetchPrediction(
  config: Config,
  proposalKey: string,
  proposalText: string,
): Promise<Prediction> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.predictionUrl}/api/predict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: [proposalText] }),
      signal: controller.signal,
    });
    if (res.status === 503) throw new ColdStartError();
    if (!res.ok) throw new Error(`prediction ${res.status}: ${res.statusText}`);
    const json = (await res.json()) as { data?: unknown[] };
    const prediction = parseGradioResult(proposalKey, json.data ?? []);
    const cache = await readCache(config);
    cache[proposalKey] = prediction;
    await writeCache(config, cache);
    return prediction;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ColdStartError();
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Space returns either a label map (Gradio Label component:
 * `{ label, confidences: [{label, confidence}] }`) or a raw probability.
 * Handle both shapes defensively.
 */
function parseGradioResult(proposalKey: string, data: unknown[]): Prediction {
  const first = data[0];
  let passProbability = 0.5;
  let label: 'PASS' | 'FAIL' = 'FAIL';

  if (first && typeof first === 'object') {
    const obj = first as {
      label?: string;
      confidences?: Array<{ label: string; confidence: number }>;
    };
    if (obj.confidences?.length) {
      const pass = obj.confidences.find((c) => /pass|for|yes|1/i.test(c.label));
      passProbability = pass ? pass.confidence : (obj.confidences[0]?.confidence ?? 0.5);
    }
    if (obj.label) label = /pass|for|yes|1/i.test(obj.label) ? 'PASS' : 'FAIL';
  } else if (typeof first === 'number') {
    passProbability = first;
    label = first >= 0.5 ? 'PASS' : 'FAIL';
  }

  if (passProbability >= 0.5) label = 'PASS';
  else label = 'FAIL';

  return {
    proposalKey,
    passProbability,
    label,
    fetchedAt: Date.now(),
    raw: first,
  };
}

