import test from "node:test";
import assert from "node:assert/strict";
import {
  capabilitySetupLabel,
  inferCapabilitySetupTarget,
} from "../src/agent/capabilitySetup";

test("capability setup inference routes integration and provider blockers", () => {
  assert.equal(
    inferCapabilitySetupTarget({ summary: "Connect Linear before creating the issue." }),
    "linear",
  );
  assert.equal(
    inferCapabilitySetupTarget({ reason: "GitHub authentication is required for this PR." }),
    "github",
  );
  assert.equal(
    inferCapabilitySetupTarget({ blockerCategory: "provider_auth", missing: ["API key"] }),
    "model",
  );
});

test("capability setup inference routes local and background capability blockers", () => {
  assert.equal(
    inferCapabilitySetupTarget({ toolName: "workspace_apply_patch", reason: "sandbox unavailable" }),
    "code",
  );
  assert.equal(
    inferCapabilitySetupTarget({ summary: "Companion service is required for background work." }),
    "background",
  );
  assert.equal(
    inferCapabilitySetupTarget({ summary: "Enable supervised browser actions." }),
    "browser_web",
  );
  assert.equal(
    inferCapabilitySetupTarget({ summary: "Vault writeback is disabled." }),
    "notes_research",
  );
});

test("capability setup inference is bounded and labels consolidated targets", () => {
  assert.equal(inferCapabilitySetupTarget({ summary: "Try the next proof step." }), null);
  assert.equal(capabilitySetupLabel("notes_research"), "Notes & research");
  assert.equal(capabilitySetupLabel("github"), "GitHub");
});
