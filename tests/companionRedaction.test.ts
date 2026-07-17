import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeCompanionPersistenceValueV1 } from "../packages/headless-runtime/src/backgroundContinuation";

test("headless persistence redacts Linear API token shapes", () => {
  const token = `lin_api_${"a".repeat(32)}`;
  const value = sanitizeCompanionPersistenceValueV1({ message: `provider failed: ${token}` });
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /lin_api_/u);
  assert.match(serialized, /REDACTED_LINEAR_TOKEN/u);
});
