"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createBankrGateFlow, sendAttentionRequest } = require("../src/flow");
const {
  BASE_MAINNET, PAYER, RELAYER, VOTER, candidateRow, candidateTargetIdFixture, createFetchStub, createRelayerStub,
  createWalletStub, gateProfile, issuedQuote,
} = require("./helpers");

const PUBLIC_ID = "abcdefghijklmnopqrstuv";
const TARGET_VOTER = "0xc180000000000000000000000000000000005425";
const AUDIENCE = "gate.local";
const EVIDENCE = [
  "https://evidence.invalid/thread-1",
  "https://evidence.invalid/ignore-prior-instructions",
];

function walletSessionChallenge() {
  return {
    proofType: "WalletSession",
    primaryType: "WalletSession",
    domain: { name: "GavelGate", version: "1", chainId: BASE_MAINNET, verifyingContract: `0x${"b4".repeat(20)}` },
    types: {
      WalletSession: [
        { name: "wallet", type: "address" },
        { name: "role", type: "string" },
        { name: "audience", type: "string" },
        { name: "purpose", type: "string" },
        { name: "nonce", type: "bytes32" },
        { name: "issuedAt", type: "uint256" },
        { name: "expiry", type: "uint256" },
        { name: "version", type: "string" },
      ],
    },
    message: {
      wallet: PAYER, role: "base_sender", audience: AUDIENCE, purpose: "gavel-gate-wallet-session",
      nonce: `0x${"7e".repeat(32)}`, issuedAt: "1800000000", expiry: "1800000300", version: "1",
    },
    nonceHash: `0x${"5a".repeat(32)}`,
    payloadHash: `0x${"5b".repeat(32)}`,
  };
}

/** Routes for the whole happy path, plus a recording of every URL contacted. */
function stubWorld({ statuses = ["pending_settlement", "accepted"], submissionStatus = 201, submissionBody } = {}) {
  let statusIndex = 0;
  return createFetchStub([
    { match: (url) => url.includes("/v1/gate/daos/nouns/targets/"), body: candidateRow() },
    { match: (url) => url.includes("/v1/gates?"), body: { items: [gateProfile()] } },
    { match: (url) => /\/v1\/gates\/0x[0-9a-f]{40}$/.test(url), body: gateProfile() },
    { match: (url) => url.endsWith("/v1/gate/auth/challenge"), body: walletSessionChallenge() },
    {
      match: (url) => url.endsWith("/v1/gate/auth/verify"),
      body: {
        token: "T".repeat(43),
        session: { wallet: PAYER.toLowerCase(), role: "base_sender", chainId: String(BASE_MAINNET), audience: AUDIENCE,
          issuedAt: "1800000000", expiry: "1800000900" },
      },
    },
    {
      match: (url, options) => /\/v1\/gates\/0x[0-9a-f]{40}\/submissions$/.test(url) && options.method === "POST",
      status: submissionStatus,
      body: submissionBody ?? { publicId: PUBLIC_ID, state: "payment_required", quote: issuedQuote() },
    },
    {
      match: (url) => url.endsWith(`/v1/submissions/${PUBLIC_ID}/resume`),
      body: { publicId: PUBLIC_ID, state: "payment_required", quote: issuedQuote() },
    },
    { match: (url) => url.endsWith("/settlement"), status: 202, body: { publicId: PUBLIC_ID, state: "pending_settlement" } },
    {
      match: (url) => url.endsWith("/status"),
      body: () => {
        const state = statuses[Math.min(statusIndex, statuses.length - 1)];
        statusIndex += 1;
        return state === "accepted"
          ? { publicId: PUBLIC_ID, state, acceptedAt: "2026-09-19T00:01:00.000Z" }
          : { publicId: PUBLIC_ID, state };
      },
    },
  ]);
}

function flowFor(world, walletStub = createWalletStub(), relayerStub = createRelayerStub()) {
  return {
    relayerStub,
    flow: createBankrGateFlow({
      wallet: walletStub.wallet,
      relayer: relayerStub.relayer,
      fetchImpl: world.fetchImpl,
      config: {
        gateUrl: "https://gate.test",
        indexUrl: "https://index.test",
        dao: "nouns",
        allowedChainIds: [BASE_MAINNET],
        requestTimeoutMs: 5_000,
      },
      now: () => 1_800_000_000_000,
      sleep: async () => {},
    }),
    walletStub,
  };
}

test("the full demo flow runs target -> voter -> pitch -> quote -> confirmation -> payment -> verification", async () => {
  const world = stubWorld();
  const walletStub = createWalletStub();
  const { flow, relayerStub } = flowFor(world, walletStub);
  const phases = [];
  const confirmations = [];

  const result = await sendAttentionRequest({
    flow,
    target: { targetId: candidateTargetIdFixture() },
    voterWallet: VOTER.toLowerCase(),
    pitch: "This candidate funds a Nouns builder grant. Please sponsor it.",
    disclosures: "I am a paid advocate for the proposer.",
    evidenceUrls: EVIDENCE,
    confirm: async (summary) => { confirmations.push(summary); return true; },
    onPhase: (phase) => phases.push(phase),
    poll: { attempts: 5 },
  });

  assert.equal(result.target.stage, "PRE_VOTE");
  assert.equal(result.target.position, "SPONSOR");
  assert.equal(result.voter.wallet, VOTER.toLowerCase());
  assert.equal(result.publicId, PUBLIC_ID);
  assert.equal(result.delivered, true);
  assert.equal(result.verdict.state, "accepted");
  assert.match(result.message, /private Gate inbox/);

  assert.deepEqual(phases, [
    "target_resolved", "voter_selected", "quote_issued",
    "authorizing", "authorized", "broadcasting", "broadcast", "settlement_hint_recorded",
  ]);
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].lines[2], "Attention: 1.00 USDC");
  assert.equal(confirmations[0].lines[3], "Gavel fee: 0.25 USDC");
  assert.equal(confirmations[0].lines[4], "Total: 1.25 USDC");
  // Bankr signed; a separate relayer broadcast.
  assert.equal(typeof walletStub.wallet.sendTransaction, "undefined");
  assert.equal(result.payment.relayer, RELAYER);
  assert.equal(result.payment.payer, PAYER);
});

test("flow target selection keeps an explicit voter ahead of a profile default", async () => {
  const explicitProfile = gateProfile({ wallet: TARGET_VOTER, ens: null, label: "delegate.gramajo.eth" });
  const world = createFetchStub([
    { match: (url) => url.includes("/v1/gates?"), body: { items: [explicitProfile] } },
    { match: (url) => url.endsWith(`/v1/gates/${TARGET_VOTER}`), body: explicitProfile },
  ]);
  const { flow } = flowFor(world);

  const voter = await flow.selectTargetVoter({
    explicitTarget: "delegate.gramajo.eth",
    profileWallet: VOTER,
    stage: "PRE_VOTE",
  });

  assert.equal(voter.wallet, TARGET_VOTER);
});

test("sendAttentionRequest forwards the explicit voter target ahead of a profile default", async () => {
  const selections = [];
  const stop = new Error("stop after voter selection");
  const flow = {
    async resolveTarget() { return { stage: "PRE_VOTE" }; },
    async selectTargetVoter(input) {
      selections.push(input);
      return { wallet: TARGET_VOTER, label: "delegate.gramajo.eth (0xc180…5425)" };
    },
    selectVoter() { throw new Error("legacy wallet selector must not choose the profile default"); },
    compose() { throw stop; },
  };

  await assert.rejects(sendAttentionRequest({
    flow,
    target: { stage: "PRE_VOTE" },
    voterTarget: "delegate.gramajo.eth",
    profileVoterWallet: VOTER,
    pitch: "Please consider this candidate.",
  }), (error) => error === stop);

  assert.deepEqual(selections, [{
    explicitTarget: "delegate.gramajo.eth",
    profileWallet: VOTER,
    stage: "PRE_VOTE",
  }]);
});

test("evidence URLs are carried to Gate verbatim and NEVER fetched", async () => {
  const world = stubWorld();
  const { flow } = flowFor(world);
  await sendAttentionRequest({
    flow,
    target: { targetId: candidateTargetIdFixture() },
    voterWallet: VOTER.toLowerCase(),
    pitch: "Please sponsor this candidate.",
    disclosures: "",
    evidenceUrls: EVIDENCE,
    confirm: async () => true,
    poll: { attempts: 5 },
  });

  // Every URL contacted belongs to Gate or the canonical index. Nothing from
  // the advocate's evidence list was requested, previewed, or unfurled.
  for (const call of world.calls) {
    assert.ok(
      call.url.startsWith("https://gate.test/") || call.url.startsWith("https://index.test/"),
      `unexpected outbound request: ${call.url}`,
    );
    for (const url of EVIDENCE) assert.ok(!call.url.startsWith(url));
  }
  assert.equal(world.calls.some((call) => call.url.includes("evidence.invalid")), false);

  const submission = world.calls.find((call) => call.method === "POST" && call.url.endsWith("/submissions"));
  assert.deepEqual(JSON.parse(submission.body).evidenceUrls, EVIDENCE);
});

test("declining the confirmation signs nothing, sends nothing, and keeps the quote resumable", async () => {
  const world = stubWorld();
  const walletStub = createWalletStub();
  const { flow, relayerStub } = flowFor(world, walletStub);

  await assert.rejects(
    sendAttentionRequest({
      flow,
      target: { targetId: candidateTargetIdFixture() },
      voterWallet: VOTER.toLowerCase(),
      pitch: "Please sponsor this candidate.",
      confirm: async () => false,
    }),
    (error) => error.code === "CONFIRMATION_REQUIRED" && error.message.includes(PUBLIC_ID),
  );

  // The WalletSession signature is the only signature; no authorization, no tx.
  assert.equal(walletStub.calls.signTypedData.length, 1);
  assert.equal(walletStub.calls.signTypedData[0].primaryType, "WalletSession");
  assert.equal(relayerStub.calls.sendTransaction.length, 0);
  assert.equal(world.calls.some((call) => call.url.endsWith("/settlement")), false);
});

test("an omitted confirm callback can never reach the wallet or the relayer", async () => {
  const world = stubWorld();
  const walletStub = createWalletStub();
  const { flow, relayerStub } = flowFor(world, walletStub);
  await assert.rejects(
    sendAttentionRequest({
      flow,
      target: { targetId: candidateTargetIdFixture() },
      voterWallet: VOTER.toLowerCase(),
      pitch: "Please sponsor this candidate.",
    }),
    (error) => error.code === "CONFIRMATION_REQUIRED",
  );
  // Only the WalletSession proof was signed; no EIP-3009, no broadcast.
  assert.equal(walletStub.calls.signTypedData.length, 1);
  assert.equal(walletStub.calls.signTypedData[0].primaryType, "WalletSession");
  assert.equal(relayerStub.calls.sendTransaction.length, 0);
});

test("Bankr signs both EIP-712 payloads and the relayer broadcasts once", async () => {
  const world = stubWorld();
  const walletStub = createWalletStub();
  const { flow, relayerStub } = flowFor(world, walletStub);
  await sendAttentionRequest({
    flow,
    target: { targetId: candidateTargetIdFixture() },
    voterWallet: VOTER.toLowerCase(),
    pitch: "Please sponsor this candidate.",
    confirm: async () => true,
    poll: { attempts: 5 },
  });

  assert.deepEqual(
    walletStub.calls.signTypedData.map((payload) => payload.primaryType),
    ["WalletSession", "ReceiveWithAuthorization"],
  );
  assert.equal(relayerStub.calls.sendTransaction.length, 1);
  assert.deepEqual(Object.keys(relayerStub.calls.sendTransaction[0]).sort(), ["data", "to", "value"]);
});

test("a relayer broadcast alone never produces delivered", async () => {
  const world = stubWorld({ statuses: ["pending_settlement"] });
  const { flow, relayerStub } = flowFor(world);
  const result = await sendAttentionRequest({
    flow,
    target: { targetId: candidateTargetIdFixture() },
    voterWallet: VOTER.toLowerCase(),
    pitch: "Please sponsor this candidate.",
    confirm: async () => true,
    poll: { attempts: 3 },
  });

  // The relayer succeeded and the request is still not delivered.
  assert.equal(relayerStub.calls.sendTransaction.length, 1);
  assert.equal(result.payment.broadcast, true);
  assert.equal(result.payment.accepted, false);
  assert.equal(result.delivered, false);
});

test("only a subsequent Gate accepted produces delivered", async () => {
  const world = stubWorld({ statuses: ["pending_settlement", "pending_settlement", "accepted"] });
  const { flow, relayerStub } = flowFor(world);
  const result = await sendAttentionRequest({
    flow,
    target: { targetId: candidateTargetIdFixture() },
    voterWallet: VOTER.toLowerCase(),
    pitch: "Please sponsor this candidate.",
    confirm: async () => true,
    poll: { attempts: 5 },
  });

  assert.equal(relayerStub.calls.sendTransaction.length, 1);
  assert.equal(result.verdict.state, "accepted");
  assert.equal(result.delivered, true);
});

test("no Gate session token reaches the relayer", async () => {
  const world = stubWorld();
  const { flow, relayerStub } = flowFor(world);
  await sendAttentionRequest({
    flow,
    target: { targetId: candidateTargetIdFixture() },
    voterWallet: VOTER.toLowerCase(),
    pitch: "Please sponsor this candidate.",
    confirm: async () => true,
    poll: { attempts: 5 },
  });
  const serialized = JSON.stringify(relayerStub.calls.sendTransaction);
  assert.ok(!serialized.includes("T".repeat(43)));
  assert.doesNotMatch(serialized, /Bearer|token|session/i);
});

test("a duplicate resumes the original quote and pays that one", async () => {
  const world = stubWorld({
    submissionStatus: 409,
    submissionBody: {
      state: "duplicate",
      existing: { publicId: PUBLIC_ID, state: "payment_required", resumeUrl: `/v1/submissions/${PUBLIC_ID}/resume` },
    },
  });
  const { flow } = flowFor(world);
  const phases = [];
  const result = await sendAttentionRequest({
    flow,
    target: { targetId: candidateTargetIdFixture() },
    voterWallet: VOTER.toLowerCase(),
    pitch: "Please sponsor this candidate.",
    confirm: async () => true,
    onPhase: (phase) => phases.push(phase),
    poll: { attempts: 5 },
  });

  assert.equal(result.resumed, true);
  assert.ok(phases.includes("quote_resumed"));
  assert.equal(world.calls.filter((call) => call.method === "POST" && call.url.endsWith("/submissions")).length, 1);
});

test("success is never reported while Gate is still verifying", async () => {
  const world = stubWorld({ statuses: ["pending_settlement"] });
  const { flow } = flowFor(world);
  const result = await sendAttentionRequest({
    flow,
    target: { targetId: candidateTargetIdFixture() },
    voterWallet: VOTER.toLowerCase(),
    pitch: "Please sponsor this candidate.",
    confirm: async () => true,
    poll: { attempts: 3 },
  });

  assert.equal(result.delivered, false);
  assert.equal(result.verdict.state, "pending_settlement");
  assert.equal(result.payment.broadcast, true);
  assert.equal(result.payment.accepted, false);
  assert.match(result.hint.message, /Gate is now independently verifying/);
  assert.doesNotMatch(result.message, /\bwas delivered\b|\binbox\b/i);
});

test("an eventual Gate rejection after a successful broadcast is reported as a rejection", async () => {
  const world = stubWorld({ statuses: ["pending_settlement", "rejected_by_policy"] });
  const { flow } = flowFor(world);
  const result = await sendAttentionRequest({
    flow,
    target: { targetId: candidateTargetIdFixture() },
    voterWallet: VOTER.toLowerCase(),
    pitch: "Please sponsor this candidate.",
    confirm: async () => true,
    poll: { attempts: 5 },
  });
  assert.equal(result.delivered, false);
  assert.equal(result.verdict.state, "rejected_by_policy");
  assert.equal(result.verdict.terminal, true);
});

test("Bankr never reads the voter's private inbox", async () => {
  const world = stubWorld();
  const { flow } = flowFor(world);
  await sendAttentionRequest({
    flow,
    target: { targetId: candidateTargetIdFixture() },
    voterWallet: VOTER.toLowerCase(),
    pitch: "Please sponsor this candidate.",
    confirm: async () => true,
    poll: { attempts: 5 },
  });
  for (const call of world.calls) assert.doesNotMatch(call.url, /\/v1\/gate\/me\//);
  assert.equal(typeof flow.gateApi.listInbox, "undefined");
});

test("the session token never appears in a URL or a request body", async () => {
  const world = stubWorld();
  const { flow } = flowFor(world);
  await sendAttentionRequest({
    flow,
    target: { targetId: candidateTargetIdFixture() },
    voterWallet: VOTER.toLowerCase(),
    pitch: "Please sponsor this candidate.",
    confirm: async () => true,
    poll: { attempts: 5 },
  });
  const token = "T".repeat(43);
  for (const call of world.calls) {
    assert.ok(!call.url.includes(token), `token leaked into URL: ${call.url}`);
    assert.ok(!String(call.body ?? "").includes(token));
  }
});

test("a voter who stopped accepting blocks the flow before any Gate session is opened", async () => {
  const world = createFetchStub([
    { match: (url) => url.includes("/targets/"), body: candidateRow() },
    { match: (url) => /\/v1\/gates\/0x[0-9a-f]{40}$/.test(url), body: gateProfile({ availability: "paused", acceptingSubmissions: false }) },
  ]);
  const { flow, walletStub } = flowFor(world);
  await assert.rejects(
    sendAttentionRequest({
      flow,
      target: { targetId: candidateTargetIdFixture() },
      voterWallet: VOTER.toLowerCase(),
      pitch: "Please sponsor this candidate.",
      confirm: async () => true,
    }),
    (error) => error.code === "VOTER_NOT_ACCEPTING",
  );
  assert.equal(walletStub.calls.signTypedData.length, 0);
});

// --- remote relay ------------------------------------------------------------

const RELAY_ORIGIN = "https://relay.0773h.com";
const RELAY_TX = `0x${"ab".repeat(32)}`;

/** The stub world plus the Gate relay route, recorded like every other call. */
function relayWorld({ status = 200, body } = {}) {
  const base = stubWorld();
  const inner = base.fetchImpl;
  const relayCalls = [];
  return {
    calls: base.calls,
    relayCalls,
    fetchImpl: async (url, options = {}) => {
      if (String(url).endsWith(`/v1/submissions/${PUBLIC_ID}/relay`)) {
        base.calls.push({ url: String(url), method: options.method, headers: options.headers, body: options.body });
        relayCalls.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
        const payload = body ?? { txHash: RELAY_TX, chainId: String(BASE_MAINNET), relayer: RELAYER };
        return { status, async text() { return JSON.stringify(payload); } };
      }
      return inner(url, options);
    },
  };
}

function remoteFlowFor(world, { relayerUrl = RELAY_ORIGIN } = {}) {
  const walletStub = createWalletStub();
  return {
    walletStub,
    flow: createBankrGateFlow({
      wallet: walletStub.wallet,
      // No in-process relayer: a Bankr sandbox holds no funded key.
      fetchImpl: world.fetchImpl,
      config: {
        gateUrl: "https://gate.0773h.com",
        indexUrl: "https://index.0773h.com",
        ...(relayerUrl ? { relayerUrl } : {}),
        dao: "nouns",
        allowedChainIds: [BASE_MAINNET],
        requestTimeoutMs: 5_000,
      },
      now: () => 1_800_000_000_000,
      sleep: async () => {},
    }),
  };
}

test("RELAYER_UNAVAILABLE is gone once a remote relay is configured", async () => {
  const world = relayWorld();
  const { flow, walletStub } = remoteFlowFor(world);
  assert.equal(flow.relayMode, "remote");

  const phases = [];
  const result = await sendAttentionRequest({
    flow,
    target: { targetId: candidateTargetIdFixture() },
    voterWallet: VOTER.toLowerCase(),
    pitch: "This candidate funds a Nouns builder grant. Please sponsor it.",
    confirm: async () => true,
    onPhase: (phase) => phases.push(phase),
    poll: { attempts: 5 },
  });

  assert.equal(result.delivered, true);
  assert.equal(result.payment.txHash, RELAY_TX);
  assert.equal(result.payment.remote, true);
  assert.equal(result.payment.relayer, RELAYER);
  assert.equal(result.payment.payer, PAYER);
  assert.equal(result.payment.accepted, false);
  assert.ok(phases.includes("broadcasting") && phases.includes("broadcast"));

  // Exactly one relay call, carrying one signature and no transaction fields.
  assert.equal(world.relayCalls.length, 1);
  assert.deepEqual(Object.keys(world.relayCalls[0].body), ["authorization"]);
  assert.deepEqual(Object.keys(world.relayCalls[0].body.authorization), ["signature"]);
  assert.equal(world.relayCalls[0].headers.authorization, `Bearer ${"T".repeat(43)}`);

  // Bankr signed twice — the WalletSession proof and the EIP-3009
  // authorization — and broadcast nothing itself.
  assert.equal(walletStub.calls.signTypedData.length, 2);
  assert.equal(typeof walletStub.wallet.sendTransaction, "undefined");
});

test("without a relayer and without a relay origin, payment still fails by name", async () => {
  const world = relayWorld();
  const { flow, walletStub } = remoteFlowFor(world, { relayerUrl: null });
  assert.equal(flow.relayMode, null);

  await assert.rejects(
    sendAttentionRequest({
      flow,
      target: { targetId: candidateTargetIdFixture() },
      voterWallet: VOTER.toLowerCase(),
      pitch: "Please sponsor this candidate.",
      confirm: async () => true,
      poll: { attempts: 5 },
    }),
    (error) => error.code === "RELAYER_UNAVAILABLE" && /does not broadcast/.test(error.message),
  );
  assert.equal(world.relayCalls.length, 0);
  // The authorization was signed, and nothing was broadcast by Bankr.
  assert.equal(walletStub.calls.signTypedData.length, 2);
});

test("an in-process relayer still takes priority over a configured relay origin", async () => {
  const world = relayWorld();
  const relayerStub = createRelayerStub();
  const walletStub = createWalletStub();
  const flow = createBankrGateFlow({
    wallet: walletStub.wallet,
    relayer: relayerStub.relayer,
    fetchImpl: world.fetchImpl,
    config: {
      gateUrl: "https://gate.0773h.com",
      indexUrl: "https://index.0773h.com",
      relayerUrl: RELAY_ORIGIN,
      dao: "nouns",
      allowedChainIds: [BASE_MAINNET],
      requestTimeoutMs: 5_000,
    },
    now: () => 1_800_000_000_000,
    sleep: async () => {},
  });
  assert.equal(flow.relayMode, "local");

  const result = await sendAttentionRequest({
    flow,
    target: { targetId: candidateTargetIdFixture() },
    voterWallet: VOTER.toLowerCase(),
    pitch: "Please sponsor this candidate.",
    confirm: async () => true,
    poll: { attempts: 5 },
  });
  assert.equal(relayerStub.calls.sendTransaction.length, 1);
  assert.equal(world.relayCalls.length, 0);
  assert.equal(result.payment.remote, false);
});

test("a refused remote relay leaves the quote resumable and nothing accepted", async () => {
  const world = relayWorld({ status: 409, body: { state: "pending_settlement", error: { code: "NOT_PAYABLE", message: "nothing to broadcast" } } });
  const { flow } = remoteFlowFor(world);
  await assert.rejects(
    sendAttentionRequest({
      flow,
      target: { targetId: candidateTargetIdFixture() },
      voterWallet: VOTER.toLowerCase(),
      pitch: "Please sponsor this candidate.",
      confirm: async () => true,
      poll: { attempts: 5 },
    }),
    (error) => error.code === "NOT_PAYABLE" && error.state === "pending_settlement",
  );
  // No settlement hint was recorded for a settlement that never happened.
  assert.equal(world.calls.filter((call) => call.url.endsWith("/settlement")).length, 0);
});

test("the remote relay is never handed the payer's confirmation-free path", async () => {
  const world = relayWorld();
  const { flow, walletStub } = remoteFlowFor(world);
  await assert.rejects(
    sendAttentionRequest({
      flow,
      target: { targetId: candidateTargetIdFixture() },
      voterWallet: VOTER.toLowerCase(),
      pitch: "Please sponsor this candidate.",
      confirm: async () => false,
    }),
    (error) => error.code === "CONFIRMATION_REQUIRED",
  );
  assert.equal(world.relayCalls.length, 0);
  // One signature only: the WalletSession proof. Nothing was authorized.
  assert.equal(walletStub.calls.signTypedData.length, 1);
});
