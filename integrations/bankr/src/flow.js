"use strict";

const { BankrGateError } = require("./errors");
const { createGateApi } = require("./gate-api");
const { createIndexApi } = require("./index-api");
const { discoverVoters, selectTargetVoter, selectVoter } = require("./discovery");
const { assertPayableQuote, confirmationSummary, parseIssuedQuote, secondsUntilExpiry } = require("./quote");
const { buildSubmissionRequest, createOrResumeSubmission } = require("./submission");
const { openBaseSenderSession } = require("./session");
const { authorizePayment, broadcastPayment, payQuote } = require("./payment");
const { pollUntilTerminal, submitSettlementHint } = require("./settlement");
const { resolveTarget } = require("./targets");
const { resolveConfig } = require("./config");
const { assertWalletCapabilities } = require("./wallet");
const { assertRelayerCapabilities } = require("./relayer");
const { createRemoteRelay } = require("./remote-relay");

/**
 * The Bankr advocate flow, as discrete steps.
 *
 * The order is fixed because each step depends on the last being real:
 *
 *   target -> voter -> pitch -> quote -> confirmation -> payment -> verification
 *
 * Gate owns every decision along the way. This object sequences calls, formats
 * what a person needs to see, and refuses to move past a step Gate did not
 * approve. It decides no price, no eligibility, and no acceptance.
 */
function createBankrGateFlow({
  gateApi,
  indexApi,
  wallet,
  relayer,
  remoteRelay,
  config,
  env = process.env,
  fetchImpl,
  now = () => Date.now(),
  sleep,
} = {}) {
  const resolved = config || resolveConfig(env);
  const gate = gateApi || createGateApi({
    baseUrl: resolved.gateUrl,
    fetchImpl,
    timeoutMs: resolved.requestTimeoutMs,
  });
  const index = indexApi || createIndexApi({
    baseUrl: resolved.indexUrl,
    fetchImpl,
    timeoutMs: resolved.requestTimeoutMs,
  });
  if (wallet) assertWalletCapabilities(wallet);
  if (relayer) assertRelayerCapabilities(relayer);
  // The funded account is either in process or on the Gate server. A Bankr
  // sandbox is ephemeral and holds no key, so the remote relay is the normal
  // production path; an in-process relayer stays supported and takes priority.
  const relay = remoteRelay || (resolved.relayerUrl
    ? createRemoteRelay({ relayUrl: resolved.relayerUrl, fetchImpl, timeoutMs: resolved.requestTimeoutMs })
    : null);
  const displayChainId = resolved.allowedChainIds[0];

  return Object.freeze({
    config: resolved,
    gateApi: gate,
    indexApi: index,
    /** Where the gas gets paid: "local", "remote", or null when neither exists. */
    relayMode: relayer ? "local" : (relay ? "remote" : null),

    /** 1. Resolve a REAL Nouns candidate or proposal through canonical data. */
    resolveTarget(input) {
      return resolveTarget(index, input);
    },

    /** 2a. Voters who opted in through Gate AND accept this stage. */
    discoverVoters({ stage, minVotingPower, sort } = {}) {
      return discoverVoters(gate, { stage, dao: resolved.dao, minVotingPower, sort, chainId: displayChainId });
    },

    /** 2b. Re-read one canonical wallet and confirm acceptance at selection time. */
    selectVoter(voterWallet, { stage } = {}) {
      return selectVoter(gate, voterWallet, { stage, chainId: displayChainId });
    },

    /**
     * 2c. Prefer an explicit wallet/label over a private profile default.
     * Labels are matched only against the current Gate directory, then the
     * canonical wallet profile is re-read before selection.
     */
    selectTargetVoter({ explicitTarget, profileWallet, stage } = {}) {
      return selectTargetVoter(gate, {
        explicitTarget,
        profileWallet,
        stage,
        dao: resolved.dao,
        chainId: displayChainId,
      });
    },

    /** 3. Compose the advocate's untrusted content into Gate's exact body. */
    compose(input) {
      return buildSubmissionRequest(input);
    },

    /** 4a. Authenticate the payer wallet on Gate's base_sender WalletSession path. */
    authenticate() {
      return openBaseSenderSession({ gateApi: gate, wallet });
    },

    /** 4b. Create exactly one submission, or resume the one that already exists. */
    async requestQuote({ session, voter, request }) {
      if (!session?.token) throw new BankrGateError("UNAUTHORIZED", "Authenticate the payer wallet first.");
      const receipt = await createOrResumeSubmission({
        gateApi: gate,
        token: session.token,
        voterWallet: voter?.wallet ?? voter,
        request,
      });
      if (!receipt.quote) {
        throw new BankrGateError(
          receipt.state === "expired" ? "QUOTE_EXPIRED" : "NO_PAYABLE_QUOTE",
          receipt.state === "expired"
            ? "Gate holds this request but its quote has expired."
            : `Gate holds this request in state ${receipt.state}; there is nothing to pay.`,
          { state: receipt.state },
        );
      }
      return receipt;
    },

    /** 5. The confirmation an advocate must approve before anything is signed. */
    confirmation({ quote, target, voter }) {
      const parsed = quote.message ? quote : parseIssuedQuote(quote);
      assertPayableQuote(parsed, Math.floor(Number(now()) / 1000), { allowedChainIds: resolved.allowedChainIds });
      return Object.freeze({
        ...confirmationSummary({ quote: parsed, target, voter }),
        expiresInSeconds: secondsUntilExpiry(parsed, Math.floor(Number(now()) / 1000)),
      });
    },

    /** 6a. Bankr signs one EIP-3009 authorization. Nothing is broadcast here. */
    authorize({ quote, confirmed, onPhase }) {
      return authorizePayment({
        wallet,
        quote,
        confirmed,
        onPhase,
        now,
        allowedChainIds: resolved.allowedChainIds,
      });
    },

    /**
     * 6b. A separate funded relayer broadcasts that exact prepared transaction.
     *
     * `session` and `publicId` are required only on the remote path, where Gate
     * resolves the quote from its OWN owner-bound record of this submission.
     */
    broadcast({ prepared, quote, session, publicId, onPhase }) {
      return broadcastPayment({ relayer, remoteRelay: relay, session, publicId, prepared, quote, onPhase, now });
    },

    /** 6. Authorize then broadcast. A broadcast is never success. */
    pay({ quote, confirmed, session, publicId, onPhase }) {
      return payQuote({
        wallet,
        relayer,
        remoteRelay: relay,
        session,
        publicId,
        quote,
        confirmed,
        onPhase,
        now,
        allowedChainIds: resolved.allowedChainIds,
      });
    },

    /** 7a. The tx hash goes to Gate as a hint only. */
    submitSettlementHint({ session, publicId, payment }) {
      return submitSettlementHint({
        gateApi: gate,
        token: session.token,
        publicId,
        txHash: payment.txHash,
        chainId: payment.chainId,
      });
    },

    /** 7b. Gate's authoritative verdict. The only source of "delivered". */
    awaitAcceptance({ publicId, intervalMs, attempts, onPoll }) {
      return pollUntilTerminal({ gateApi: gate, publicId, intervalMs, attempts, sleep, onPoll });
    },
  });
}

/**
 * Runs the whole advocate flow.
 *
 * `confirm` is the explicit human gate. It receives the confirmation summary and
 * MUST return exactly `true` for payment to proceed; anything else aborts with
 * nothing signed and nothing sent. A caller that omits it gets the same refusal,
 * so there is no way to reach the wallet by forgetting an argument.
 */
async function sendAttentionRequest({
  flow,
  target: targetInput,
  voterTarget,
  voterWallet,
  profileVoterWallet,
  pitch,
  disclosures = "",
  evidenceUrls = [],
  confirm,
  onPhase = () => {},
  poll = {},
} = {}) {
  if (!flow) throw new BankrGateError("INVALID_CONFIG", "A Bankr Gate flow is required.");
  const target = targetInput?.stage ? targetInput : await flow.resolveTarget(targetInput ?? {});
  onPhase("target_resolved", { target });

  const explicitTarget = voterTarget ?? voterWallet;
  const voter = await flow.selectTargetVoter({
    explicitTarget,
    profileWallet: profileVoterWallet,
    stage: target.stage,
  });
  onPhase("voter_selected", { voter });

  const request = flow.compose({ target, pitch, disclosures, evidenceUrls });
  const session = await flow.authenticate();
  const receipt = await flow.requestQuote({ session, voter, request });
  onPhase(receipt.resumed ? "quote_resumed" : "quote_issued", { publicId: receipt.publicId, state: receipt.state });

  const summary = flow.confirmation({ quote: receipt.quote, target, voter });
  const approved = typeof confirm === "function" ? await confirm(summary) : false;
  if (approved !== true) {
    throw new BankrGateError(
      "CONFIRMATION_REQUIRED",
      "Payment was not confirmed. Nothing was signed and nothing was sent. "
      + `The quote is still resumable at ${receipt.publicId} until it expires.`,
      { state: receipt.state },
    );
  }

  const payment = await flow.pay({
    quote: receipt.quote,
    confirmed: true,
    session,
    publicId: receipt.publicId,
    onPhase: (phase) => onPhase(phase, {}),
  });
  const hint = await flow.submitSettlementHint({ session, publicId: receipt.publicId, payment });
  onPhase("settlement_hint_recorded", { txHash: payment.txHash });

  const verdict = await flow.awaitAcceptance({ publicId: receipt.publicId, ...poll });
  return Object.freeze({
    target,
    voter,
    publicId: receipt.publicId,
    resumed: receipt.resumed,
    confirmation: summary,
    payment,
    hint,
    verdict,
    delivered: verdict.delivered === true,
    message: verdict.message,
  });
}

module.exports = { createBankrGateFlow, sendAttentionRequest };
