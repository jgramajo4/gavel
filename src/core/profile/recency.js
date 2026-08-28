const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function parseTimestamp(value, label) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return timestamp;
}

function recencyWeight(timestamp, asOf, halfLifeDays = 365) {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    throw new RangeError("halfLifeDays must be a positive finite number");
  }
  const voteTime = parseTimestamp(timestamp, "timestamp");
  const referenceTime = parseTimestamp(asOf, "asOf");
  const ageDays = (referenceTime.getTime() - voteTime.getTime()) / MILLISECONDS_PER_DAY;
  if (ageDays < 0) throw new RangeError("timestamp cannot be later than asOf");
  return 0.5 ** (ageDays / halfLifeDays);
}

module.exports = { MILLISECONDS_PER_DAY, recencyWeight };
