/**
 * Prediction wrapper around the gramajo/nouns_proposal_check Gradio Space
 * (DistilBERT outcome model). Optimistic stale cache: last result per proposal
 * is persisted to ~/.config/gavel/cache.json and shown instantly with a
 * staleness indicator. The fetch timeout IS the failure signal — no health ping.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { Prediction } from '../types.js';

const CACHE_DIR = join(homedir(), '.config', 'gavel');
const CACHE_FILE = join(CACHE_DIR, 'cache.json');
const FETCH_TIMEOUT_MS = 30_000;

type Cache = Record<string, Prediction>;

async function readCache(): Promise<Cache> {
  try {
    const raw = await readFile(CACHE_FILE, 'utf8');
    return JSON.parse(raw) as Cache;
  } catch {
    return {};
  }
}

async function writeCache(cache: Cache): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    // Cache is best-effort; a write failure must never break the UI.
  }
}

export async function getCachedPrediction(proposalId: number): Promise<Prediction | null> {
  const cache = await readCache();
  return cache[String(proposalId)] ?? null;
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
  proposalId: number,
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
    const prediction = parseGradioResult(proposalId, json.data ?? []);
    const cache = await readCache();
    cache[String(proposalId)] = prediction;
    await writeCache(cache);
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
function parseGradioResult(proposalId: number, data: unknown[]): Prediction {
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
      passProbability = pass ? pass.confidence : obj.confidences[0].confidence;
    }
    if (obj.label) label = /pass|for|yes|1/i.test(obj.label) ? 'PASS' : 'FAIL';
  } else if (typeof first === 'number') {
    passProbability = first;
    label = first >= 0.5 ? 'PASS' : 'FAIL';
  }

  if (passProbability >= 0.5) label = 'PASS';
  else label = 'FAIL';

  return {
    proposalId,
    passProbability,
    label,
    fetchedAt: Date.now(),
    raw: first,
  };
}

