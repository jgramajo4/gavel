/**
 * WaaP autonomous execution: policy authorizes, Gavel executes.
 *
 *   ValidatedExecutionIntent
 *       -> policy evaluation
 *       -> WaaP execution identity signs
 *       -> broadcast
 *       -> confirmation
 *
 * This mode has materially more authority than supervised mode -- no human
 * stands between a decision and the chain -- so the gates are correspondingly
 * harder, and every one of them fails closed:
 *
 *   - the input must be a ValidatedExecutionIntent
 *   - the governance layer must have opened autonomy for this specific intent
 *     (`validation.autonomyAllowed`, false for advisory recommendations)
 *   - the identity must be an ExecutionIdentity, which a Safe proposal identity
 *     structurally cannot be
 *   - the wallet policy must approve, and silence is not approval
 *   - the actor, chain and target must match what was configured
 *
 * Policy evaluation happens in `prepare()` and again in `submit()`. The submit
 * decision is authoritative, so stale or forged preparation policy metadata
 * can never authorize a broadcast.
 */

const { getAddress } = require("ethers");

const { ExecutionMode } = require("../../schema/execution");
const { ExecutionEvent } = require("../events");
const { ExecutionState } = require("../lifecycle");
const { assertPreparable, assertSubmittable, executionPreparation } = require("../adapter");
const { assertExecutionIdentity } = require("../identity/roles");

class PolicyRejected extends Error {
  constructor(message, reasonCode = "POLICY_REJECTED") {
    super(message);
    this.name = "PolicyRejected";
    this.code = reasonCode;
  }
}

/**
 * A policy decision must be an explicit `{ allowed: true }`.
 *
 * A thrown error, a rejected promise, a falsy return, `undefined`, or a
 * truthy-but-unshaped value are all treated as refusal. The only way to
 * broadcast is for a policy to say yes in so many words.
 */
function assertPolicyApproval(decision) {
  if (decision === true) return { allowed: true, reason: null, policyId: null };
  if (!decision || typeof decision !== "object" || decision.allowed !== true) {
    const reason = decision && typeof decision === "object" ? decision.reason : null;
    throw new PolicyRejected(
      `The autonomous execution policy did not approve this action${reason ? `: ${reason}` : ""}`,
      (decision && typeof decision === "object" && decision.reasonCode) || "POLICY_REJECTED",
    );
  }
  return { allowed: true, reason: decision.reason || null, policyId: decision.policyId || null };
}

class WaapAutonomousExecutionAdapter {
  /**
   * @param {object} options
   * @param {object} options.executionIdentity  an ExecutionIdentity, never a proposal identity
   * @param {Function} options.policy           async (validated) => { allowed, reason?, policyId? }
   * @param {number} options.chainId
   * @param {object} [options.client]           optional provider client for status lookups
   */
  constructor(options) {
    this.mode = ExecutionMode.WAAP_AUTONOMOUS;
    this.chainId = Number(options?.chainId);
    if (!Number.isInteger(this.chainId) || this.chainId <= 0) {
      throw new TypeError("Autonomous mode requires a chain id");
    }
    // The type gate, in the direction that matters most: a Safe proposal
    // identity cannot be handed autonomous authority.
    this.executionIdentity = assertExecutionIdentity(options?.executionIdentity);
    if (this.executionIdentity.scope.chainId !== this.chainId) {
      throw new Error("The execution identity is scoped to a different chain");
    }
    if (typeof options?.policy !== "function") {
      throw new TypeError(
        "Autonomous execution requires an explicit policy hook. There is no default-allow policy.",
      );
    }
    this.policy = options.policy;
    this.client = options.client || null;
  }

  async getExecutionAddress() {
    return this.executionIdentity.address();
  }

  async #authorize(validated) {
    if (validated.validation.autonomyAllowed !== true) {
      throw new PolicyRejected(
        "The governance layer did not authorize autonomous execution of this intent " +
          "(prediction review requires human acknowledgement)",
        "AUTONOMY_NOT_AUTHORIZED",
      );
    }
    try {
      return assertPolicyApproval(await this.policy(validated));
    } catch (error) {
      if (error instanceof PolicyRejected) throw error;
      throw new PolicyRejected(`The autonomous execution policy failed closed: ${error.message}`, "POLICY_ERROR");
    }
  }

  async prepare(validated) {
    const intent = assertPreparable(this, validated).intent;

    if (intent.chainId !== this.chainId) {
      throw new Error(`The validated intent is for chain ${intent.chainId}, not ${this.chainId}`);
    }
    const actor = getAddress(await this.executionIdentity.address());
    if (getAddress(intent.actor) !== actor) {
      throw new Error(
        `The validated intent is actored by ${getAddress(intent.actor)}, not the execution identity ${actor}`,
      );
    }
    if (intent.operation !== "CALL") throw new Error("Autonomous mode executes CALL operations only");

    const decision = await this.#authorize(validated);

    return executionPreparation(
      this,
      validated,
      {
        request: {
          chainId: this.chainId,
          from: actor,
          to: getAddress(intent.target),
          value: intent.value,
          data: intent.data,
        },
        policy: decision,
        intentHash: validated.intentHash,
      },
      { providerData: { providerStatus: "policy-approved" } },
    );
  }

  async submit(preparation) {
    const { validated } = assertSubmittable(this, preparation);

    // The broadcast request is rebuilt from `validated.intent`, never read out
    // of the payload. The payload is deeply frozen, but a caller can hand us a
    // look-alike preparation object carrying a genuine validated intent beside
    // an attacker-chosen `request` -- so the payload is treated as a hint about
    // what prepare() computed, and the intent is the authority.
    const intent = validated.intent;
    const actor = getAddress(await this.executionIdentity.address());
    if (getAddress(intent.actor) !== actor) {
      throw new Error(`The validated intent is actored by ${getAddress(intent.actor)}, not ${actor}`);
    }
    if (intent.chainId !== this.chainId) {
      throw new Error(`The validated intent is for chain ${intent.chainId}, not ${this.chainId}`);
    }
    const decision = await this.#authorize(validated);

    const broadcast = await this.executionIdentity.broadcast({
      chainId: intent.chainId,
      from: actor,
      to: getAddress(intent.target),
      value: intent.value,
      data: intent.data,
      // Carried so a provider can deduplicate on its own side too.
      intentHash: validated.intentHash,
    });
    const transactionHash = broadcast?.transactionHash || broadcast?.hash || null;
    if (!transactionHash) throw new Error("The autonomous broadcaster returned no transaction hash");

    return {
      state: broadcast.confirmed === true ? ExecutionState.EXECUTED : ExecutionState.EXECUTING,
      providerData: {
        transactionHash: String(transactionHash),
        providerRequestId: broadcast.requestId ? String(broadcast.requestId) : undefined,
      },
      events: [
        { name: ExecutionEvent.WAAP_AUTHORIZED, detail: { reasonCode: decision.policyId || undefined } },
        { name: ExecutionEvent.WAAP_BROADCAST, detail: { transactionHash: String(transactionHash) } },
        ...(broadcast.confirmed === true
          ? [{ name: ExecutionEvent.WAAP_CONFIRMED, detail: { transactionHash: String(transactionHash) } }]
          : []),
      ],
    };
  }

  async status(record) {
    const transactionHash = record?.providerData?.transactionHash;
    if (!transactionHash) throw new Error("This execution record has no transaction hash to look up");
    if (typeof this.client?.getTransactionStatus !== "function") {
      throw new Error("This autonomous adapter has no client capable of status lookups");
    }
    const reported = await this.client.getTransactionStatus(transactionHash);
    // Onchain outcome, not provider opinion: a mined-but-reverted transaction
    // is a failure even if the provider calls it complete.
    const state =
      reported?.status === "reverted" || reported?.success === false
        ? ExecutionState.FAILED
        : reported?.confirmed === true
          ? ExecutionState.EXECUTED
          : ExecutionState.EXECUTING;
    return {
      state,
      providerData: { transactionHash: String(transactionHash), providerStatus: reported?.status || undefined },
    };
  }
}

module.exports = {
  PolicyRejected,
  WaapAutonomousExecutionAdapter,
  assertPolicyApproval,
};
