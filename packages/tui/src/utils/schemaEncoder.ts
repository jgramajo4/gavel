/**
 * SchemaEncoder — a tiny viem-only replacement for the EAS SDK's SchemaEncoder.
 * EAS attestation data is just ABI-encoded values in the order the schema
 * declares them. We parse the schema string (e.g. "uint256 propId,bool isFinal")
 * into ordered types + names, then encode/decode with viem's ABI primitives.
 *
 * No EAS SDK dependency — the SDK pulls ethers v6; Gavel is viem-only.
 */
import {
  encodeAbiParameters,
  decodeAbiParameters,
  type AbiParameter,
} from 'viem';

export interface SchemaField {
  name: string;
  type: string;
}

export type SchemaValues = Record<string, unknown>;

/** Parse "uint256 propId,string title,bool isFinal" → ordered fields. */
export function parseSchema(schema: string): SchemaField[] {
  return schema
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const segments = part.split(/\s+/);
      const type = segments[0];
      const name = segments[1] ?? '';
      return { type, name };
    });
}

function toAbiParams(fields: SchemaField[]): AbiParameter[] {
  return fields.map((f) => ({ name: f.name, type: f.type }) as AbiParameter);
}

/** Encode named values into the packed `data` bytes an EAS attestation expects. */
export function encodeSchemaData(schema: string, values: SchemaValues): `0x${string}` {
  const fields = parseSchema(schema);
  const params = toAbiParams(fields);
  const ordered = fields.map((f) => {
    if (!(f.name in values)) {
      throw new Error(`schemaEncoder: missing value for field "${f.name}"`);
    }
    return values[f.name];
  });
  return encodeAbiParameters(params, ordered);
}

/** Decode EAS `data` bytes back into a named record. */
export function decodeSchemaData(
  schema: string,
  data: `0x${string}`,
): SchemaValues {
  const fields = parseSchema(schema);
  const params = toAbiParams(fields);
  const decoded = decodeAbiParameters(params, data);
  const out: SchemaValues = {};
  fields.forEach((f, i) => {
    out[f.name] = decoded[i];
  });
  return out;
}

