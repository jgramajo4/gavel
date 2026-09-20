"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createGateHttpServer } = require("../src/gate/http");
const { RelayRequestError } = require("../src/gate/relay-service");

const PUBLIC_ID = "A".repeat(22);
const PAYER = `0x${"2".repeat(40)}`;
const RELAYER = `0x${"7e".repeat(20)}`;
const SIGNATURE = `0x${"11".repeat(65)}`;

async function withServer(server, callback) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function dependencies(calls, relaySettlement) {
  return {
    authService: {
      issueChallenge: async () => ({}),
      verifyProof: async () => ({}),
      authenticateSession: async (token, requirement) => {
        calls.push(["auth", requirement, token]);
        if (token !== "good-token") throw new Error("nope");
        return { role: "base_sender", wallet: PAYER };
      },
    },
    profileService: { updateProfile: async () => ({}), listPublicProfiles: async () => [], getPublicProfile: async () => null },
    relayService: {
      relaySettlement: relaySettlement || (async (input) => {
        calls.push(["relay", input]);
        return { txHash: `0x${"ab".repeat(32)}`, chainId: "8453", relayer: RELAYER };
      }),
    },
  };
}

function post(body, token = "good-token") {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  };
}

test("the relay route authenticates base_sender and returns only a hint receipt", async () => {
  const calls = [];
  const counters = [];
  const deps = dependencies(calls);
  deps.observability = { counter(name) { counters.push(name); } };
  await withServer(createGateHttpServer(deps), async (base) => {
    const response = await fetch(`${base}/v1/submissions/${PUBLIC_ID}/relay`,
      post({ authorization: { signature: SIGNATURE } }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      txHash: `0x${"ab".repeat(32)}`, chainId: "8453", relayer: RELAYER,
    });
  });
  assert.deepEqual(calls[0], ["auth", { role: "base_sender" }, "good-token"]);
  assert.equal(calls[1][1].publicId, PUBLIC_ID);
  assert.deepEqual(calls[1][1].request, { authorization: { signature: SIGNATURE } });
  assert.deepEqual(counters, ["gate_relay_broadcast_total"]);
});

test("the relay route is closed to an unauthenticated caller", async () => {
  const calls = [];
  await withServer(createGateHttpServer(dependencies(calls)), async (base) => {
    for (const options of [post({ authorization: { signature: SIGNATURE } }, null),
      post({ authorization: { signature: SIGNATURE } }, "bad-token")]) {
      const response = await fetch(`${base}/v1/submissions/${PUBLIC_ID}/relay`, options);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, "UNAUTHORIZED");
    }
  });
  assert.equal(calls.filter(([kind]) => kind === "relay").length, 0);
});

test("the relay route exists only when a relayer is configured", async () => {
  const calls = [];
  const deps = dependencies(calls);
  delete deps.relayService;
  await withServer(createGateHttpServer(deps), async (base) => {
    const response = await fetch(`${base}/v1/submissions/${PUBLIC_ID}/relay`,
      post({ authorization: { signature: SIGNATURE } }));
    assert.equal(response.status, 404);
  });
  assert.equal(calls.length, 0);
});

test("only POST on a well-formed submission id reaches the relay", async () => {
  const calls = [];
  await withServer(createGateHttpServer(dependencies(calls)), async (base) => {
    const get = await fetch(`${base}/v1/submissions/${PUBLIC_ID}/relay`, { headers: { authorization: "Bearer good-token" } });
    assert.equal(get.status, 404);
    const short = await fetch(`${base}/v1/submissions/AAAA/relay`, post({ authorization: { signature: SIGNATURE } }));
    assert.equal(short.status, 404);
  });
  assert.equal(calls.filter(([kind]) => kind === "relay").length, 0);
});

test("a refusal keeps its coarse code, status, and state, and never echoes a signature", async () => {
  const cases = [
    [new RelayRequestError("relay request carries only an authorization; got to", 400, "INVALID_RELAY"), 400, "INVALID_RELAY", undefined],
    [new RelayRequestError("This quote expired before it was broadcast. Nothing was sent.", 410, "EXPIRED", "expired"), 410, "EXPIRED", "expired"],
    [new RelayRequestError("this submission is pending_settlement; there is nothing to broadcast", 409, "NOT_PAYABLE", "pending_settlement"), 409, "NOT_PAYABLE", "pending_settlement"],
    [new RelayRequestError("the Gate relayer must be a separate account from the payer", 503, "RELAYER_IS_PAYER"), 503, "RELAYER_IS_PAYER", undefined],
  ];
  for (const [error, status, code, state] of cases) {
    const calls = [];
    const deps = dependencies(calls, async () => { throw error; });
    await withServer(createGateHttpServer(deps), async (base) => {
      const response = await fetch(`${base}/v1/submissions/${PUBLIC_ID}/relay`,
        post({ authorization: { signature: SIGNATURE } }));
      assert.equal(response.status, status);
      const body = await response.json();
      assert.equal(body.error.code, code);
      assert.equal(body.state, state);
      assert.doesNotMatch(JSON.stringify(body), /0x1{20}/, "a refusal echoed signature material");
    });
  }
});

test("an unexpected relay failure is an opaque 500", async () => {
  const deps = dependencies([], async () => { throw new Error(`boom 0x${"1".repeat(130)}`); });
  await withServer(createGateHttpServer(deps), async (base) => {
    const response = await fetch(`${base}/v1/submissions/${PUBLIC_ID}/relay`,
      post({ authorization: { signature: SIGNATURE } }));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  });
});

test("an incomplete relay service is refused at construction", () => {
  assert.throws(() => createGateHttpServer({ ...dependencies([]), relayService: {} }), /complete relayService/);
});
