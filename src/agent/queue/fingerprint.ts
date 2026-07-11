export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

/**
 * Serialize JSON-compatible data with recursively sorted object keys.
 *
 * Persisted contracts use this instead of relying on object insertion order.
 * Values that JSON would silently discard or coerce are rejected so the same
 * logical contract cannot acquire multiple fingerprints.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(toCanonicalJson(value, new Set<object>()));
}

export function fingerprintCanonicalJson(value: unknown): string {
  return `sha256:${sha256Text(canonicalJsonStringify(value))}`;
}

export function sha256Text(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  const highBits = Math.floor(bitLength / 0x1_0000_0000);
  const lowBits = bitLength >>> 0;
  view.setUint32(paddedLength - 8, highBits, false);
  view.setUint32(paddedLength - 4, lowBits, false);

  const state = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ]);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15];
      const right = words[index - 2];
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = add32(words[index - 16], sigma0, words[index - 7], sigma1);
    }

    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = add32(h, sum1, choice, SHA_256_CONSTANTS[index], words[index]);
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = add32(sum0, majority);

      h = g;
      g = f;
      f = e;
      e = add32(d, temp1);
      d = c;
      c = b;
      b = a;
      a = add32(temp1, temp2);
    }

    state[0] = add32(state[0], a);
    state[1] = add32(state[1], b);
    state[2] = add32(state[2], c);
    state[3] = add32(state[3], d);
    state[4] = add32(state[4], e);
    state[5] = add32(state[5], f);
    state[6] = add32(state[6], g);
    state[7] = add32(state[7], h);
  }

  return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}

function toCanonicalJson(value: unknown, ancestors: Set<object>): CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON does not permit non-finite numbers.");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`Canonical JSON does not permit ${typeof value} values.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError("Canonical JSON does not permit cyclic values.");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => toCanonicalJson(entry, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON only permits arrays and plain objects.");
    }
    const canonical: { [key: string]: CanonicalJsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      canonical[key] = toCanonicalJson((value as Record<string, unknown>)[key], ancestors);
    }
    return canonical;
  } finally {
    ancestors.delete(value);
  }
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function add32(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    total = (total + value) >>> 0;
  }
  return total;
}

const SHA_256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
