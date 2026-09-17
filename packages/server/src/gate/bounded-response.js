"use strict";

async function readBoundedText(response, maximumBytes, errorMessage = "response too large") {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError("maximumBytes must be positive");
  const body = response?.body;
  if (!body || typeof body.getReader !== "function") throw new Error(errorMessage);

  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await body.cancel?.().catch(() => {});
    throw new Error(errorMessage);
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(errorMessage);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

module.exports = { readBoundedText };
