const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CANONICAL_BASE_USDC_ADDRESS,
  SUPPORTED_DECODER_VERSIONS,
  decodeAction,
  validateFact,
  requireVerificationFact,
  serializeVerificationFact,
} = require('../src');

const RECIPIENT = '0x00000000000000000000000000000000000000aa';

function action(overrides = {}) {
  return {
    target: RECIPIENT,
    valueWei: '1000000000000000001',
    calldata: '0x',
    actionIndex: 3,
    ...overrides,
  };
}

test('decodes a positive native ETH transfer with exact provenance', () => {
  const fact = decodeAction(action(), { decoderVersion: 'gate-facts/1' });

  assert.deepEqual(fact, {
    kind: 'native_eth_transfer',
    source: 'decoded',
    decoderVersion: 'gate-facts/1',
    actionIndex: 3,
    canonicalEvidence: {
      actionIndex: 3,
      target: '0x00000000000000000000000000000000000000AA',
      valueWei: '1000000000000000001',
      calldata: '0x',
      signature: '',
    },
    displayLabel: 'Native ETH transfer',
    amountWei: '1000000000000000001',
    recipient: '0x00000000000000000000000000000000000000AA',
  });
});

test('does not decode zero native value by itself', () => {
  const fact = decodeAction(action({ valueWei: '0' }), { decoderVersion: 'gate-facts/1' });
  assert.equal(fact.kind, 'raw_action');
  assert.equal(fact.source, 'canonical');
});

test('rejects a forged zero-value native ETH transfer', () => {
  const fact = decodeAction(action(), { decoderVersion: 'gate-facts/1' });
  fact.amountWei = '0';
  fact.canonicalEvidence.valueWei = '0';

  assert.throws(() => validateFact(fact), /amountWei/);
  assert.throws(() => serializeVerificationFact(fact), /amountWei/);
});

test('keeps value-bearing calls and multicalls raw', () => {
  for (const calldata of ['0x12345678', '0xac9650d8']) {
    const fact = decodeAction(action({ calldata }), { decoderVersion: 'gate-facts/1' });
    assert.equal(fact.kind, 'raw_action');
    assert.equal(fact.source, 'canonical');
  }
});

test('keeps an empty-calldata action with a nonempty signature raw', () => {
  const fact = decodeAction(action({ signature: 'deposit()' }), { decoderVersion: 'gate-facts/1' });
  assert.equal(fact.kind, 'raw_action');
  assert.equal(fact.source, 'canonical');
});

test('binds exact signature semantics into canonical evidence and serialization', () => {
  const transfer = decodeAction(action({ signature: 'transfer(address,uint256)' }), decoderOptions);
  const approve = decodeAction(action({ signature: 'approve(address,uint256)' }), decoderOptions);

  assert.equal(transfer.signature, 'transfer(address,uint256)');
  assert.equal(transfer.canonicalEvidence.signature, 'transfer(address,uint256)');
  assert.equal(approve.signature, 'approve(address,uint256)');
  assert.equal(approve.canonicalEvidence.signature, 'approve(address,uint256)');
  assert.notEqual(serializeVerificationFact(transfer), serializeVerificationFact(approve));

  transfer.canonicalEvidence.signature = 'approve(address,uint256)';
  assert.throws(() => validateFact(transfer), /signature/);
  assert.throws(() => serializeVerificationFact(transfer), /signature/);
});

test('canonicalizes absent and empty signatures to the same explicit representation', () => {
  const absent = action({ valueWei: '0' });
  delete absent.signature;
  const absentFact = decodeAction(absent, decoderOptions);
  const emptyFact = decodeAction(action({ valueWei: '0', signature: '' }), decoderOptions);

  assert.equal(absentFact.signature, '');
  assert.equal(absentFact.canonicalEvidence.signature, '');
  assert.deepEqual(absentFact, emptyFact);
});

test('rejects invalid basic canonical action shape', () => {
  assert.throws(() => decodeAction(action({ target: 'bad' }), { decoderVersion: 'gate-facts/1' }));
  assert.throws(() => decodeAction(action({ valueWei: Number.MAX_SAFE_INTEGER + 1 }), { decoderVersion: 'gate-facts/1' }));
  assert.throws(() => decodeAction(action({ calldata: 'xyz' }), { decoderVersion: 'gate-facts/1' }));
});

test('accepts only nonnegative safe integer action indexes everywhere', () => {
  for (const maximum of [
    decodeAction(action({ actionIndex: Number.MAX_SAFE_INTEGER }), decoderOptions),
    decodeAction(action({ actionIndex: Number.MAX_SAFE_INTEGER, valueWei: '0' }), decoderOptions),
  ]) {
    assert.equal(maximum.actionIndex, Number.MAX_SAFE_INTEGER);
    assert.equal(maximum.canonicalEvidence.actionIndex, Number.MAX_SAFE_INTEGER);
  }

  for (const actionIndex of [Number.MAX_SAFE_INTEGER + 1, String(Number.MAX_SAFE_INTEGER)]) {
    assert.throws(() => decodeAction(action({ actionIndex }), decoderOptions), /actionIndex|safe/i);
  }

  for (const fact of [decodeAction(action(), decoderOptions), decodeAction(action({ valueWei: '0' }), decoderOptions)]) {
    for (const field of ['actionIndex', 'canonicalEvidence']) {
      const unsafe = structuredClone(fact);
      if (field === 'actionIndex') unsafe.actionIndex = Number.MAX_SAFE_INTEGER + 1;
      else unsafe.canonicalEvidence.actionIndex = Number.MAX_SAFE_INTEGER + 1;
      assert.throws(() => validateFact(unsafe), /actionIndex|safe/i);
      assert.throws(() => serializeVerificationFact(unsafe), /actionIndex|safe/i);
    }
  }
});

test('requires every canonical action input to include an actionIndex', () => {
  const missingActionIndex = action({ valueWei: '0' });
  delete missingActionIndex.actionIndex;
  assert.throws(
    () => decodeAction(missingActionIndex, { decoderVersion: 'gate-facts/1' }),
    /actionIndex/,
  );
});

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_AMOUNT = '90071992547409931234567890';
const TRANSFER_CALLDATA = `0xa9059cbb${'0'.repeat(24)}${RECIPIENT.slice(2)}${BigInt(USDC_AMOUNT).toString(16).padStart(64, '0')}`;

function usdcAction(overrides = {}) {
  return action({
    target: USDC,
    valueWei: '0',
    calldata: TRANSFER_CALLDATA,
    signature: '',
    ...overrides,
  });
}

const decoderOptions = { decoderVersion: 'gate-facts/1', canonicalUsdcAddress: USDC };

test('exports the frozen canonical Base USDC allowlist address', () => {
  assert.equal(CANONICAL_BASE_USDC_ADDRESS, USDC);
});

test('allows only the exported decoder version implemented by these rules', () => {
  assert.deepEqual(SUPPORTED_DECODER_VERSIONS, ['gate-facts/1']);
  assert.equal(Object.isFrozen(SUPPORTED_DECODER_VERSIONS), true);
  assert.equal(decodeAction(action(), decoderOptions).decoderVersion, 'gate-facts/1');
  assert.throws(
    () => decodeAction(action(), { decoderVersion: 'caller-controlled/999' }),
    /decoderVersion/,
  );

  const decoded = decodeAction(action(), decoderOptions);
  decoded.decoderVersion = 'caller-controlled/999';
  assert.throws(() => validateFact(decoded), /decoderVersion/);
});

test('decodes only an exact allowlisted USDC transfer without integer loss', () => {
  const fact = decodeAction(usdcAction(), { decoderVersion: 'gate-facts/1' });
  assert.equal(fact.kind, 'usdc_transfer');
  assert.equal(fact.source, 'decoded');
  assert.equal(fact.decoderVersion, 'gate-facts/1');
  assert.equal(fact.actionIndex, 3);
  assert.equal(fact.recipient, '0x00000000000000000000000000000000000000AA');
  assert.equal(fact.amountAtomic, USDC_AMOUNT);
  assert.equal(fact.token, USDC);
  assert.equal(fact.displayLabel, 'USDC transfer');
  assert.equal(fact.canonicalEvidence.calldata, TRANSFER_CALLDATA);
});

test('rejects arbitrary-token transfer facts during validation and serialization', () => {
  const fact = decodeAction(usdcAction(), decoderOptions);
  fact.token = '0x00000000000000000000000000000000000000AA';
  fact.canonicalEvidence.target = '0x00000000000000000000000000000000000000AA';

  assert.throws(() => validateFact(fact), /USDC|token/);
  assert.throws(() => serializeVerificationFact(fact), /USDC|token/);
});

test('fails closed when the decoder USDC option is not canonical Base USDC', () => {
  const arbitraryToken = '0x00000000000000000000000000000000000000AA';
  const candidate = usdcAction({ target: arbitraryToken });

  assert.throws(
    () => decodeAction(candidate, {
      decoderVersion: 'gate-facts/1',
      canonicalUsdcAddress: arbitraryToken,
    }),
    /canonical Base USDC/,
  );
  assert.throws(
    () => decodeAction(action(), {
      decoderVersion: 'gate-facts/1',
      canonicalUsdcAddress: arbitraryToken,
    }),
    /canonical Base USDC/,
  );
  assert.equal(
    decodeAction(candidate, { decoderVersion: 'gate-facts/1' }).kind,
    'raw_action',
  );
});

test('keeps selector-prefixed USDC calldata with a nonempty signature raw', () => {
  const fact = decodeAction(
    usdcAction({ signature: 'transfer(address,uint256)' }),
    decoderOptions,
  );
  assert.equal(fact.kind, 'raw_action');
  assert.equal(fact.source, 'canonical');
});

test('keeps nonexact and unknown calls raw without throwing', () => {
  const wrongRecipientPadding = `0xa9059cbb01${'0'.repeat(22)}${RECIPIENT.slice(2)}${BigInt(1).toString(16).padStart(64, '0')}`;
  const cases = [
    usdcAction({ target: RECIPIENT }),
    usdcAction({ valueWei: '1' }),
    usdcAction({ signature: 'approve(address,uint256)' }),
    usdcAction({ calldata: `0x095ea7b3${TRANSFER_CALLDATA.slice(10)}` }),
    usdcAction({ calldata: TRANSFER_CALLDATA.slice(0, -2) }),
    usdcAction({ calldata: `${TRANSFER_CALLDATA}00` }),
    usdcAction({ calldata: wrongRecipientPadding }),
    usdcAction({ calldata: '0xac9650d8' }),
  ];

  for (const candidate of cases) {
    const fact = decodeAction(candidate, decoderOptions);
    assert.equal(fact.kind, 'raw_action');
    assert.equal(fact.source, 'canonical');
  }
});

test('allows absent and empty canonical signatures', () => {
  assert.equal(decodeAction(usdcAction(), decoderOptions).kind, 'usdc_transfer');

  const candidate = usdcAction();
  delete candidate.signature;
  assert.equal(decodeAction(candidate, decoderOptions).kind, 'usdc_transfer');
});

test('rejects kindless canonical facts as verification material', () => {
  const canonical = { source: 'canonical', displayLabel: 'Proposal title' };

  assert.throws(() => validateFact(canonical));
  assert.throws(() => requireVerificationFact(canonical));
  assert.throws(() => serializeVerificationFact(canonical));
});

test('permits strict raw and decoded facts as verification material', () => {
  assert.equal(
    requireVerificationFact(decodeAction(action({ valueWei: '0' }), decoderOptions)).source,
    'canonical',
  );
  assert.equal(requireVerificationFact(decodeAction(action(), decoderOptions)).source, 'decoded');
});

test('rejects enriched facts when marked or requested as verifiable', () => {
  const enrichment = {
    source: 'enriched',
    displayLabel: 'Example ENS label',
    value: 'example.eth',
  };
  assert.equal(validateFact(enrichment).source, 'enriched');
  assert.throws(() => requireVerificationFact(enrichment), /enriched facts are display-only/);
  assert.throws(() => validateFact({ ...enrichment, verifiable: true }), /display-only/);
});

test('rejects additional verification fields during validation and serialization', () => {
  const canonical = {
    source: 'canonical',
    displayLabel: 'Proposal title',
    ens: 'example.eth',
  };
  const raw = decodeAction(action({ valueWei: '0' }), decoderOptions);
  raw.ens = 'example.eth';
  const native = decodeAction(action(), decoderOptions);
  native.ens = 'example.eth';
  const usdc = decodeAction(usdcAction(), decoderOptions);
  usdc.signature = 'transfer(address,uint256)';
  const evidenceEnriched = decodeAction(action(), decoderOptions);
  evidenceEnriched.canonicalEvidence.ens = 'example.eth';

  for (const candidate of [canonical, raw, native, usdc, evidenceEnriched]) {
    assert.throws(() => validateFact(candidate));
    assert.throws(() => serializeVerificationFact(candidate));
  }
});

test('rejects caller-controlled verification display labels', () => {
  for (const fact of [
    decodeAction(action({ valueWei: '0' }), decoderOptions),
    decodeAction(action(), decoderOptions),
    decodeAction(usdcAction(), decoderOptions),
  ]) {
    fact.displayLabel = 'Caller-controlled label';
    assert.throws(() => validateFact(fact), /displayLabel/);
    assert.throws(() => serializeVerificationFact(fact), /displayLabel/);
  }
});

test('serializes exact raw, native ETH, and USDC verification fields', () => {
  const facts = [
    decodeAction(action({ valueWei: '0' }), decoderOptions),
    decodeAction(action(), decoderOptions),
    decodeAction(usdcAction(), decoderOptions),
  ];

  for (const fact of facts) {
    assert.deepEqual(JSON.parse(serializeVerificationFact(fact)), fact);
  }
});

test('requires decoded facts to remain bound to complete exact canonical evidence', () => {
  const decoded = decodeAction(action(), decoderOptions);

  for (const field of ['target', 'valueWei', 'calldata', 'signature']) {
    const candidate = structuredClone(decoded);
    delete candidate.canonicalEvidence[field];
    assert.throws(() => validateFact(candidate), new RegExp(field));
  }

  const invalidTarget = structuredClone(decoded);
  invalidTarget.recipient = 'not-an-address';
  invalidTarget.canonicalEvidence.target = 'not-an-address';
  assert.throws(() => validateFact(invalidTarget), /target/);

  for (const [field, value] of [
    ['target', '0x00000000000000000000000000000000000000bb'],
    ['valueWei', '1000000000000000002'],
    ['calldata', '0x00'],
  ]) {
    const candidate = structuredClone(decoded);
    candidate.canonicalEvidence[field] = value;
    assert.throws(() => validateFact(candidate), new RegExp(field));
  }
});

test('requires matching action indexes on decoded facts', () => {
  assert.throws(() => validateFact({ source: 'decoded', displayLabel: 'Transfer' }));
  assert.throws(() => validateFact({ source: 'unknown', displayLabel: 'Unknown' }));

  const mismatched = decodeAction(action(), decoderOptions);
  mismatched.actionIndex = 2;
  assert.throws(() => validateFact(mismatched), /actionIndex/);
});

test('requires raw actions to remain bound to complete exact canonical evidence', () => {
  const raw = decodeAction(action({ valueWei: '0' }), decoderOptions);
  assert.deepEqual(
    {
      actionIndex: raw.actionIndex,
      target: raw.target,
      valueWei: raw.valueWei,
      calldata: raw.calldata,
      signature: raw.signature,
    },
    raw.canonicalEvidence,
  );
  assert.deepEqual(raw.canonicalEvidence, {
    actionIndex: 3,
    target: '0x00000000000000000000000000000000000000AA',
    valueWei: '0',
    calldata: '0x',
    signature: '',
  });

  const withoutEvidence = {
    source: 'canonical',
    kind: 'raw_action',
    displayLabel: 'Raw action',
    actionIndex: 3,
  };
  const withoutCalldata = structuredClone(raw);
  delete withoutCalldata.canonicalEvidence.calldata;
  const withoutDirectFields = ['target', 'valueWei', 'calldata', 'signature'].map((field) => {
    const candidate = structuredClone(raw);
    delete candidate[field];
    return [candidate, new RegExp(field)];
  });

  const invalidFacts = [
    [withoutEvidence, /canonicalEvidence/],
    [withoutCalldata, /calldata/],
    [{ ...structuredClone(raw), actionIndex: 2 }, /actionIndex/],
    [{ ...structuredClone(raw), target: RECIPIENT }, /target/],
    [{ ...structuredClone(raw), valueWei: '1' }, /valueWei/],
    [{ ...structuredClone(raw), calldata: '0x00' }, /calldata/],
    [{ ...structuredClone(raw), signature: 'transfer(address,uint256)' }, /signature/],
    ...withoutDirectFields,
  ];

  for (const [candidate, expectedError] of invalidFacts) {
    assert.throws(() => validateFact(candidate), expectedError);
    assert.throws(() => requireVerificationFact(candidate), expectedError);
    assert.throws(() => serializeVerificationFact(candidate), expectedError);
  }
});
