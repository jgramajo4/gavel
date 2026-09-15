function positive(value, name, fallback) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${name} must be a positive integer`);
  return result;
}
function trustedJob(job) {
  if (!job || typeof job.id !== "string" || !job.id) throw new TypeError("notification id is required");
  if (typeof job.claimToken !== "string" || !/^[1-9][0-9]*$/.test(job.claimToken)) {
    throw new TypeError("notification claim token is required");
  }
  if (typeof job.destinationRef !== "string" || !job.destinationRef || /^https?:/i.test(job.destinationRef)) {
    throw new TypeError("notification destination must be an opaque private reference");
  }
  const summary = job.summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)
      || Object.keys(summary).sort().join("\0") !== "subject\0text"
      || typeof summary.subject !== "string" || typeof summary.text !== "string") {
    throw new TypeError("notification requires a trusted pre-rendered summary");
  }
  if (!Number.isSafeInteger(job.retryCount ?? 0) || (job.retryCount ?? 0) < 0) throw new TypeError("invalid notification retry count");
  return Object.freeze({ id: job.id, claimToken: job.claimToken, retryCount: job.retryCount ?? 0,
    destinationRef: job.destinationRef, summary: Object.freeze({ subject: summary.subject, text: summary.text }) });
}
function errorCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : "PROVIDER_ERROR";
}

function createNotificationWorker({ store, provider, clock = () => new Date(), batchSize = 20,
  baseDelayMs = 30_000, maxDelayMs = 30 * 60_000, leaseMs = 5 * 60_000 } = {}) {
  if (typeof provider !== "function") throw new TypeError("notification provider must be a narrow function");
  if (provider.durableIdempotency !== true) {
    throw new TypeError("notification provider must guarantee durable deduplication by idempotencyKey");
  }
  if (!store || typeof store.claimNotificationAttempts !== "function"
      || typeof store.completeNotification !== "function" || typeof store.failNotification !== "function") {
    throw new TypeError("notification store claim/complete/fail methods are required");
  }
  const limit = positive(batchSize, "batchSize", 20);
  const base = positive(baseDelayMs, "baseDelayMs", 30_000);
  const maximum = positive(maxDelayMs, "maxDelayMs", 30 * 60_000);
  const lease = positive(leaseMs, "leaseMs", 5 * 60_000);
  if (maximum < base) throw new TypeError("maxDelayMs must be at least baseDelayMs");

  async function runOnce() {
    const now = new Date(clock());
    if (Number.isNaN(now.valueOf())) throw new TypeError("clock must return a valid timestamp");
    const attempts = await store.claimNotificationAttempts({ limit, leaseMs: lease });
    let sent = 0; let failed = 0;
    for (const raw of attempts) {
      let job;
      try {
        job = trustedJob(raw);
        const result = await provider(Object.freeze({
          idempotencyKey: job.id, destinationRef: job.destinationRef, summary: job.summary,
        }));
        const providerOpaqueId = result?.providerOpaqueId;
        if (providerOpaqueId !== undefined && (typeof providerOpaqueId !== "string" || providerOpaqueId.length > 256)) {
          throw new Error("invalid provider result");
        }
        const completed = await store.completeNotification({
          id: job.id, claimToken: job.claimToken, providerOpaqueId: providerOpaqueId ?? null,
        });
        if (completed !== false) sent += 1;
      } catch (error) {
        const retryCount = job?.retryCount ?? (Number.isSafeInteger(raw?.retryCount) && raw.retryCount >= 0 ? raw.retryCount : 0);
        const exponent = Math.min(retryCount, 30);
        const delay = Math.min(maximum, base * (2 ** exponent));
        const id = job?.id ?? raw?.id;
        const claimToken = job?.claimToken ?? raw?.claimToken;
        let recorded = false;
        if (typeof id === "string" && id && typeof claimToken === "string" && /^[1-9][0-9]*$/.test(claimToken)) {
          try {
            recorded = await store.failNotification({ id, claimToken,
              errorCode: job ? errorCode(error) : "INVALID_JOB", nextAttemptAt: new Date(now.valueOf() + delay) });
          } catch {
            recorded = false;
          }
        }
        if (recorded !== false) failed += 1;
      }
    }
    return { claimed: attempts.length, sent, failed };
  }
  return Object.freeze({ runOnce });
}

module.exports = { createNotificationWorker };
