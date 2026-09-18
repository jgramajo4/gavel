const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const { validateRpcAccessEnvelope } = require('../scripts/validate-gate-rpc-access-envelope');

const PAYLOAD = Buffer.alloc(29, 7).toString('base64url');

test('accepts only the closed operator-provisioned encrypted RPC envelope', () => {
  const envelope = `enc:v1:base-sepolia-primary:${PAYLOAD}`;
  assert.equal(validateRpcAccessEnvelope(envelope), envelope);
  const maximumEnvelope = `enc:v1:k:${Buffer.alloc(8192, 7).toString('base64url')}`;
  assert.equal(validateRpcAccessEnvelope(maximumEnvelope), maximumEnvelope);
});

test('runbook bootstrap calls the reusable validator before configuring the deployment', () => {
  const runbook = readFileSync(new URL('../docs/deployment/GAVEL_GATE_EXPERIMENTAL.md', `file://${__filename}`), 'utf8');
  const requireAt = runbook.indexOf("require('./scripts/validate-gate-rpc-access-envelope')");
  const validateAt = runbook.indexOf('validateRpcAccessEnvelope(process.env.GAVEL_GATE_RPC_ACCESS_CIPHERTEXT)');
  const configureAt = runbook.indexOf('store.configureDeployment(expected)');
  assert.ok(requireAt >= 0 && validateAt > requireAt && configureAt > validateAt);
});

test('rejects plaintext, placeholders, unknown versions, malformed fields, and short payloads', async (t) => {
  const invalid = [
    '',
    ' ',
    'https://rpc.example/key',
    'rpc=https://rpc.example/key',
    '{"url":"https://rpc.example/key"}',
    'raw-api-key',
    'changeme',
    `enc:v2:key:${PAYLOAD}`,
    `enc:v1::${PAYLOAD}`,
    `enc:v1:${'a'.repeat(65)}:${PAYLOAD}`,
    `enc:v1:bad key:${PAYLOAD}`,
    `enc:v1:key:${PAYLOAD}=`,
    'enc:v1:key:not+base64url',
    `enc:v1:key:${Buffer.alloc(28, 7).toString('base64url')}`,
    `enc:v1:key:${Buffer.alloc(8193, 7).toString('base64url')}`,
    `enc:v1:key:${'A'.repeat(1_000_000)}`,
    ` enc:v1:key:${PAYLOAD}`,
    `enc:v1:key:${PAYLOAD}:extra`,
  ];
  for (const value of invalid) {
    await t.test(JSON.stringify(value).slice(0, 80), () => {
      assert.throws(() => validateRpcAccessEnvelope(value), /encrypted RPC access envelope is invalid/);
    });
  }
});
