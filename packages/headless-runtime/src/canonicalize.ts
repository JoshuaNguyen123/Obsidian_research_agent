/** Environment-neutral canonical JSON used for durable mission fingerprints. */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, "$", new Set<object>());
}

export async function sha256Fingerprint(value: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("SHA-256 is unavailable in this runtime.");
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

function serializeCanonical(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${path}.`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError(`Unsafe integer at ${path}.`);
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Unsupported value at ${path}: ${typeof value}.`);
  }
  if (ancestors.has(value)) throw new TypeError(`Circular value at ${path}.`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new TypeError(`Sparse array entry at ${path}[${index}].`);
        entries.push(serializeCanonical(value[index], `${path}[${index}]`, ancestors));
      }
      return `[${entries.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Non-plain object at ${path}.`);
    }
    return `{${Object.keys(value as object)
      .sort()
      .map((key) => {
        const entry = (value as Record<string, unknown>)[key];
        return `${JSON.stringify(key)}:${serializeCanonical(entry, `${path}.${key}`, ancestors)}`;
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
