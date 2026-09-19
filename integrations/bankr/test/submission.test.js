"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createGateApi } = require("../src/gate-api");
const { buildSubmissionRequest, createOrResumeSubmission } = require("../src/submission");
const { describeTarget } = require("../src/targets");
const {
  PAYER, VOTER, candidateRow, candidateTargetIdFixture, createFetchStub, issuedQuote, proposalRow,
} = require("./helpers");

const TOKEN = "S".repeat(43);
const PUBLIC_ID = "abcdefghijklmnopqrstuv";

function gateApiFor(routes) {
  const { fetchImpl, calls } = createFetchStub(routes);
  return { api: createGateApi({ baseUrl: "https://gate.test", fetchImpl }), calls };
}

const candidateTarget = () => describeTarget(candidateRow());

test("a candidate submission body carries targetId, PRE_VOTE, and SPONSOR", () => {
  const request = buildSubmissionRequest({
    target: candidateTarget(),
    pitch: "Please sponsor this candidate.",
    disclosures: "Paid advocate.",
    evidenceUrls: ["https://example.org/thread"],
  });

  assert.deepEqual({ ...request, evidenceUrls: [...request.evidenceUrls] }, {
    dao: "nouns",
    targetId: candidateTargetIdFixture(),
    stage: "PRE_VOTE",
    position: "SPONSOR",
    pitch: "Please sponsor this candidate.",
    disclosures: "Paid advocate.",
    evidenceUrls: ["https://example.org/thread"],
  });
  // Payer, voter, and signed sender come from the session and the routed
  // profile, never from the body.
  assert.equal(request.payer, undefined);
  assert.equal(request.voter, undefined);
  assert.equal(request.signedSender, undefined);
});

test("an active proposal submission body carries proposalId and VOTING", () => {
  const request = buildSubmissionRequest({
    target: describeTarget(proposalRow(), { position: "FOR" }),
    pitch: "Vote for this.",
    disclosures: "",
  });
  assert.equal(request.proposalId, "812");
  assert.equal(request.targetId, undefined);
  assert.equal(request.stage, "VOTING");
});

test("evidence URLs must be absolute HTTPS and are carried verbatim", () => {
  const request = buildSubmissionRequest({
    target: candidateTarget(),
    pitch: "hi",
    disclosures: "",
    evidenceUrls: ["https://example.org/a?b=c#d"],
  });
  assert.deepEqual([...request.evidenceUrls], ["https://example.org/a?b=c#d"]);

  for (const bad of [["http://example.org"], ["javascript:alert(1)"], ["/relative"], [42]]) {
    assert.throws(
      () => buildSubmissionRequest({ target: candidateTarget(), pitch: "hi", disclosures: "", evidenceUrls: bad }),
      (error) => error.code === "INVALID_SUBMISSION",
    );
  }
});

test("more evidence URLs than Gate accepts are refused", () => {
  assert.throws(
    () => buildSubmissionRequest({
      target: candidateTarget(),
      pitch: "hi",
      disclosures: "",
      evidenceUrls: Array.from({ length: 6 }, (_, index) => `https://example.org/${index}`),
    }),
    (error) => error.code === "INVALID_SUBMISSION",
  );
});

test("oversized or empty advocate content is refused before Gate is called", () => {
  assert.throws(
    () => buildSubmissionRequest({ target: candidateTarget(), pitch: "   ", disclosures: "" }),
    (error) => error.code === "INVALID_SUBMISSION",
  );
  assert.throws(
    () => buildSubmissionRequest({ target: candidateTarget(), pitch: "x".repeat(4001), disclosures: "" }),
    (error) => error.code === "INVALID_SUBMISSION",
  );
});

test("exactly one Gate submission is created and its quote is returned", async () => {
  const { api, calls } = gateApiFor([
    {
      match: (url, options) => url.includes("/submissions") && options.method === "POST",
      status: 201,
      body: { publicId: PUBLIC_ID, state: "payment_required", updatedAt: "2026-09-19T00:00:00.000Z", quote: issuedQuote() },
    },
  ]);
  const request = buildSubmissionRequest({ target: candidateTarget(), pitch: "Sponsor please.", disclosures: "" });
  const receipt = await createOrResumeSubmission({ gateApi: api, token: TOKEN, voterWallet: VOTER, request });

  assert.equal(receipt.publicId, PUBLIC_ID);
  assert.equal(receipt.state, "payment_required");
  assert.equal(receipt.resumed, false);
  assert.equal(receipt.quote.totalAmount, "1250000");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
});

test("a duplicate resumes the ORIGINAL quote and never requests a second one", async () => {
  const { api, calls } = gateApiFor([
    {
      match: (url, options) => url.includes("/submissions") && options.method === "POST",
      status: 409,
      body: { state: "duplicate", existing: { publicId: PUBLIC_ID, state: "payment_required", resumeUrl: `/v1/submissions/${PUBLIC_ID}/resume` } },
    },
    {
      match: (url) => url.endsWith(`/v1/submissions/${PUBLIC_ID}/resume`),
      status: 200,
      body: { publicId: PUBLIC_ID, state: "payment_required", quote: issuedQuote() },
    },
  ]);
  const request = buildSubmissionRequest({ target: candidateTarget(), pitch: "Sponsor please.", disclosures: "" });
  const receipt = await createOrResumeSubmission({ gateApi: api, token: TOKEN, voterWallet: VOTER, request });

  assert.equal(receipt.resumed, true);
  assert.equal(receipt.publicId, PUBLIC_ID);
  assert.equal(receipt.quote.message.payer, PAYER);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/resume")).length, 1);
});

test("a resume path Gate did not issue is refused", async () => {
  const { api } = gateApiFor([
    {
      match: (url, options) => url.includes("/submissions") && options.method === "POST",
      status: 409,
      body: { state: "duplicate", existing: { publicId: PUBLIC_ID, state: "payment_required", resumeUrl: "https://evil.test/steal" } },
    },
  ]);
  const request = buildSubmissionRequest({ target: candidateTarget(), pitch: "hi", disclosures: "" });
  await assert.rejects(
    createOrResumeSubmission({ gateApi: api, token: TOKEN, voterWallet: VOTER, request }),
    (error) => error.code === "INVALID_RESUME_URL",
  );
});

test("a lost HTTP response re-sends the IDENTICAL request instead of creating a new quote", async () => {
  const bodies = [];
  const { fetchImpl } = createFetchStub([
    {
      match: (url, options) => url.includes("/submissions") && options.method === "POST",
      body: (url, options) => {
        bodies.push(options.body);
        if (bodies.length === 1) throw new Error("socket hang up");
        return { state: "duplicate", existing: { publicId: PUBLIC_ID, state: "payment_required", resumeUrl: `/v1/submissions/${PUBLIC_ID}/resume` } };
      },
      status: 409,
    },
    {
      match: (url) => url.endsWith("/resume"),
      body: { publicId: PUBLIC_ID, state: "payment_required", quote: issuedQuote() },
    },
  ]);
  // The first stub entry throws inside `body`, which the stub raises as a
  // transport failure; the client retries the same frozen body.
  const api = createGateApi({ baseUrl: "https://gate.test", fetchImpl });
  const request = buildSubmissionRequest({ target: candidateTarget(), pitch: "Sponsor please.", disclosures: "" });
  const receipt = await createOrResumeSubmission({ gateApi: api, token: TOKEN, voterWallet: VOTER, request });

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(receipt.resumed, true);
});

test("a transport failure that never resolves reports UNKNOWN, not a new quote", async () => {
  const { fetchImpl, calls } = createFetchStub([
    { match: () => true, throw: new Error("network down") },
  ]);
  const api = createGateApi({ baseUrl: "https://gate.test", fetchImpl });
  const request = buildSubmissionRequest({ target: candidateTarget(), pitch: "hi", disclosures: "" });
  await assert.rejects(
    createOrResumeSubmission({ gateApi: api, token: TOKEN, voterWallet: VOTER, request, attempts: 2 }),
    (error) => error.code === "SUBMISSION_RESULT_UNKNOWN" && /do not change it/.test(error.message),
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
});

test("Gate policy rejections surface as coarse, non-retryable refusals", async () => {
  for (const [status, code] of [[403, "NOT_ACCEPTING"], [409, "ACTIVE_QUOTE_EXISTS"], [503, "CANONICAL_DATA_UNAVAILABLE"], [429, "RATE_LIMITED"]]) {
    const { api } = gateApiFor([
      { match: () => true, status, body: { state: "rejected_by_policy", error: { code, message: "no" } } },
    ]);
    const request = buildSubmissionRequest({ target: candidateTarget(), pitch: "hi", disclosures: "" });
    await assert.rejects(
      createOrResumeSubmission({ gateApi: api, token: TOKEN, voterWallet: VOTER, request }),
      (error) => error.code === code && error.state === "rejected_by_policy",
    );
  }
});
