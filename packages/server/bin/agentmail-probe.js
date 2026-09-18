#!/usr/bin/env node
"use strict";

const { notifierRuntimeConfigFromEnv } = require("../src/gate/runtime");
const { probeAgentMail } = require("../src/gate/notifiers/email");

async function runAgentMailProbe({ env = process.env, probe = probeAgentMail, stdout = process.stdout } = {}) {
  const config = notifierRuntimeConfigFromEnv(env);
  if (config.mode !== "agentmail") throw new TypeError("AgentMail notifier mode is not enabled");
  const result = await probe({ apiUrl: config.apiUrl, apiKey: config.apiKey, fromInbox: config.fromInbox });
  const redacted = Object.freeze({
    result: result?.result === "pass" ? "pass" : "fail",
    statusClass: typeof result?.statusClass === "string" && /^(?:[1-5]xx|network|invalid)$/.test(result.statusClass)
      ? result.statusClass : "invalid",
  });
  stdout.write(`${JSON.stringify(redacted)}\n`);
  return redacted.result === "pass" ? 0 : 1;
}

if (require.main === module) {
  runAgentMailProbe().then((code) => { process.exitCode = code; }).catch(() => {
    process.stdout.write('{"result":"fail","statusClass":"configuration"}\n');
    process.exitCode = 1;
  });
}

module.exports = { runAgentMailProbe };
