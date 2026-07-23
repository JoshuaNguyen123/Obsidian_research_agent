import assert from "node:assert/strict";
import test from "node:test";
import {
  TOOL_USAGE_POLICY,
  TOOL_USAGE_POLICY_MAX_CHARS,
} from "../src/agent/toolUsagePolicy";

test("TOOL_USAGE_POLICY stays under the char cap", () => {
  assert.ok(TOOL_USAGE_POLICY.length <= TOOL_USAGE_POLICY_MAX_CHARS);
});

test("TOOL_USAGE_POLICY includes compound sequence and exact-name rules", () => {
  assert.match(TOOL_USAGE_POLICY, /exact names/i);
  assert.match(TOOL_USAGE_POLICY, /code_commit_verified/);
  assert.match(TOOL_USAGE_POLICY, /publish_verified_code_to_github/);
  assert.match(TOOL_USAGE_POLICY, /code_workspace_create/);
  assert.equal(/CRM|refund|calendar/i.test(TOOL_USAGE_POLICY), false);
});
