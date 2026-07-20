/**
 * Normalize provider tool arguments without guessing mutation values.
 * Some OpenAI-compatible endpoints wrap an otherwise valid argument object in
 * one redundant arguments, args, input, or parameters envelope, and a few
 * double-encode that object as JSON. Unwrap only a single-key envelope so real
 * tool fields with those names remain untouched.
 */
export function parseProviderToolArguments(
  value: unknown,
): Record<string, unknown> | null {
  if (value === undefined || value === null || value === "") return {};
  let current = value;
  for (let depth = 0; depth < 2; depth += 1) {
    if (typeof current !== "string") break;
    if (!current.trim()) return {};
    try {
      current = JSON.parse(current);
    } catch {
      return null;
    }
  }
  if (!isRecord(current)) return null;
  return unwrapSingleEnvelope(current);
}

function unwrapSingleEnvelope(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const keys = Object.keys(value);
  if (keys.length !== 1) return value;
  const key = keys[0];
  if (!["arguments", "args", "input", "parameters"].includes(key)) return value;
  const nested = value[key];
  return isRecord(nested) ? nested : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
