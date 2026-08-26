const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseUint32,
  requireAdminMode,
} = require("../tools/admin/nouns-rewards/_shared");

test("reward administration fails closed without explicit builder mode", () => {
  const previous = process.env.GAVEL_ADMIN_MODE;
  delete process.env.GAVEL_ADMIN_MODE;
  try {
    assert.throws(() => requireAdminMode(), /Builder-only operation refused/);
  } finally {
    if (previous === undefined) delete process.env.GAVEL_ADMIN_MODE;
    else process.env.GAVEL_ADMIN_MODE = previous;
  }
});

test("reward administration accepts only an exact explicit builder mode", () => {
  const previous = process.env.GAVEL_ADMIN_MODE;
  try {
    process.env.GAVEL_ADMIN_MODE = "true";
    assert.throws(() => requireAdminMode(), /Builder-only operation refused/);
    process.env.GAVEL_ADMIN_MODE = "1";
    assert.doesNotThrow(() => requireAdminMode());
  } finally {
    if (previous === undefined) delete process.env.GAVEL_ADMIN_MODE;
    else process.env.GAVEL_ADMIN_MODE = previous;
  }
});

test("admin uint32 parsing rejects overflow and malformed values", () => {
  assert.equal(parseUint32("38", "clientId"), 38);
  assert.throws(() => parseUint32("-1", "clientId"), /unsigned integer/);
  assert.throws(() => parseUint32("4294967296", "clientId"), /fit in uint32/);
});
