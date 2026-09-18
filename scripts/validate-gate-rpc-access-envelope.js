'use strict';

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MIN_PAYLOAD_BYTES = 29; // 12-byte nonce + at least 1 ciphertext byte + 16-byte tag.
const MAX_PAYLOAD_BYTES = 8192;
const MAX_ENCODED_PAYLOAD_LENGTH = 10923;

function invalid() {
  throw new TypeError('encrypted RPC access envelope is invalid');
}

function validateRpcAccessEnvelope(value) {
  if (typeof value !== 'string') invalid();
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== 'enc' || parts[1] !== 'v1' || !KEY_ID.test(parts[2])
      || parts[3].length > MAX_ENCODED_PAYLOAD_LENGTH || !BASE64URL.test(parts[3])) invalid();
  const payload = Buffer.from(parts[3], 'base64url');
  if (payload.toString('base64url') !== parts[3]
      || payload.length < MIN_PAYLOAD_BYTES || payload.length > MAX_PAYLOAD_BYTES) invalid();
  return value;
}

module.exports = { validateRpcAccessEnvelope };
