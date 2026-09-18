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
  if (typeof job.profileId !== "string" || !job.profileId || job.profileId.length > 256) {
    throw new TypeError("notification profile identity is required");
  }
  const summary = job.summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)
      || Object.keys(summary).sort().join("\0") !== "subject\0text"
      || typeof summary.subject !== "string" || typeof summary.text !== "string") {
    throw new TypeError("notification requires a trusted pre-rendered summary");
  }
  if (!Number.isSafeInteger(job.retryCount ?? 0) || (job.retryCount ?? 0) < 0) throw new TypeError("invalid notification retry count");
  const firstAttemptAt = new Date(job.firstAttemptAt);
  const dedupeDeadline = new Date(job.dedupeDeadline);
  if (Number.isNaN(firstAttemptAt.valueOf()) || Number.isNaN(dedupeDeadline.valueOf())
      || dedupeDeadline <= firstAttemptAt) throw new TypeError("notification dedupe window is required");
  return Object.freeze({ id: job.id, claimToken: job.claimToken, retryCount: job.retryCount ?? 0,
    firstAttemptAt, dedupeDeadline, profileId: job.profileId, destinationRef: job.destinationRef,
    summary: Object.freeze({ subject: summary.subject, text: summary.text }) });
}
function errorCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : "PROVIDER_ERROR";
}

function createNotificationWorker({ store, provider, clock = () => new Date(), batchSize = 20,
  baseDelayMs = 30_000, maxDelayMs = 30 * 60_000, leaseMs = 5 * 60_000,
  operatorAlert } = {}) {
  if (typeof provider !== "function") throw new TypeError("notification provider must be a narrow function");
  if (provider.durableIdempotency !== true) {
    throw new TypeError("notification provider must guarantee durable deduplication by idempotencyKey");
  }
  const idempotencyWindowMs = positive(provider.idempotencyWindowMs, "provider.idempotencyWindowMs");
  const idempotencySafetyMs = positive(provider.idempotencySafetyMs, "provider.idempotencySafetyMs");
  if (idempotencySafetyMs >= idempotencyWindowMs) throw new TypeError("provider idempotency safety margin must be shorter than its window");
  if (!store || typeof store.claimNotificationAttempts !== "function"
      || typeof store.completeNotification !== "function" || typeof store.failNotification !== "function"
      || typeof store.reconcileNotification !== "function") {
    throw new TypeError("notification store claim/complete/fail/reconcile methods are required");
  }
  if (typeof operatorAlert !== "function") throw new TypeError("notification operatorAlert must be a function");
  const limit = positive(batchSize, "batchSize", 20);
  const base = positive(baseDelayMs, "baseDelayMs", 30_000);
  const maximum = positive(maxDelayMs, "maxDelayMs", 30 * 60_000);
  const lease = positive(leaseMs, "leaseMs", 5 * 60_000);
  if (maximum < base) throw new TypeError("maxDelayMs must be at least baseDelayMs");

  async function runOnce() {
    const currentTime = () => {
      const value = new Date(clock());
      if (Number.isNaN(value.valueOf())) throw new TypeError("clock must return a valid timestamp");
      return value;
    };
    currentTime();
    const attempts = await store.claimNotificationAttempts({ limit, leaseMs: lease });
    let attempted = 0; let sent = 0; let failed = 0; let reconciled = 0;
    for (const raw of attempts) {
      let job;
      try {
        job = trustedJob(raw);
        if (job.dedupeDeadline.valueOf() - job.firstAttemptAt.valueOf() > idempotencyWindowMs) {
          throw new TypeError("notification dedupe window exceeds provider guarantee");
        }
        const beforeSend = currentTime();
        if (beforeSend.valueOf() + idempotencySafetyMs >= job.dedupeDeadline.valueOf()) {
          const recorded = await store.reconcileNotification({ id: job.id, claimToken: job.claimToken,
            errorCode: "PROVIDER_IDEMPOTENCY_WINDOW_EXPIRED" });
          if (recorded !== false) {
            reconciled += 1;
            try { await operatorAlert({ code: "PROVIDER_IDEMPOTENCY_WINDOW_EXPIRED", source: "notification_worker" }); } catch {}
          }
          continue;
        }
        attempted += 1;
        const result = await provider(Object.freeze({
          idempotencyKey: job.id, dedupeDeadline: new Date(job.dedupeDeadline),
          profileId: job.profileId, destinationRef: job.destinationRef, summary: job.summary,
        }));
        const providerOpaqueId = result?.providerOpaqueId;
        if (providerOpaqueId != null && (typeof providerOpaqueId !== "string" || providerOpaqueId.length > 256)) {
          throw new Error("invalid provider result");
        }
        const completed = await store.completeNotification({
          id: job.id, claimToken: job.claimToken, providerOpaqueId: providerOpaqueId ?? null,
        });
        if (completed !== false) sent += 1;
      } catch (error) {
        const failedAt = currentTime();
        const retryCount = job?.retryCount ?? (Number.isSafeInteger(raw?.retryCount) && raw.retryCount >= 0 ? raw.retryCount : 0);
        const exponent = Math.min(retryCount, 30);
        const delay = Math.min(maximum, base * (2 ** exponent));
        const id = job?.id ?? raw?.id;
        const claimToken = job?.claimToken ?? raw?.claimToken;
        let recorded = false;
        if (typeof id === "string" && id && typeof claimToken === "string" && /^[1-9][0-9]*$/.test(claimToken)) {
          try {
            const code = job ? errorCode(error) : "INVALID_JOB";
            const deadlineReached = job && failedAt.valueOf() + delay + idempotencySafetyMs >= job.dedupeDeadline.valueOf();
            if (code === "PROVIDER_IDEMPOTENCY_CONFLICT" || deadlineReached) {
              const terminalCode = code === "PROVIDER_IDEMPOTENCY_CONFLICT"
                ? code : "PROVIDER_IDEMPOTENCY_WINDOW_EXPIRED";
              recorded = await store.reconcileNotification({ id, claimToken, errorCode: terminalCode });
              if (recorded !== false) {
                reconciled += 1;
                try { await operatorAlert({ code: terminalCode, source: "notification_worker" }); } catch {}
              }
              continue;
            }
            recorded = await store.failNotification({ id, claimToken,
              errorCode: code, nextAttemptAt: new Date(failedAt.valueOf() + delay) });
          } catch {
            recorded = false;
          }
        }
        if (recorded !== false) failed += 1;
      }
    }
    return { claimed: attempts.length, attempted, sent, failed, ...(reconciled > 0 ? { reconciled } : {}) };
  }
  return Object.freeze({ runOnce });
}

module.exports = { createNotificationWorker };
