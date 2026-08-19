import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAcceptedResearchArtifactFromWorkerHandoff,
  buildResearcherHandoffV1FromWorker,
  formatBridgedHandoffAttachContext,
  resolveAcceptedResearchEvidenceFromWorker,
} from "../src/orchestrator/researchTeamHandoffBridge";
import type { MissionEvidence } from "../src/agent/missionLedger";
import type { WorkerHandoff } from "../src/orchestrator/types";

const NOTE_SHA256 = `sha256:${"b".repeat(64)}`;
const NOTE_RECEIPT_ID = "research-note-verified-checkers";

function acceptedHandoff(): WorkerHandoff {
  return {
    id: "handoff-1",
    fromParticipantId: "researcher-1",
    toParticipantId: "lead-1",
    taskId: "task-research",
    status: "accepted",
    summary: "Gathered checkers rules.",
    sourceIds: ["https://rules.example.org/checkers"],
    evidenceIds: ["web_fetch:https://rules.example.org/checkers"],
    unresolvedQuestions: [],
    confidence: "medium",
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z",
  };
}

function usableEvidence(): MissionEvidence[] {
  return [
    {
      id: "web_fetch:https://rules.example.org/checkers",
      kind: "web_source",
      title: "Official checkers rules",
      url: "https://rules.example.org/checkers",
      sourceId: "https://rules.example.org/checkers",
      passageIds: ["passage-checkers-1"],
      usableSource: true,
      summary: "Fetched official rules passage.",
      confidence: "high",
      contentHash: `sha256:${"a".repeat(64)}`,
    },
  ];
}

test("bridge builds accepted artifact and researcher handoff only from host-accepted, receipt-backed note evidence", () => {
  const handoff = acceptedHandoff();
  const evidence = usableEvidence();
  const artifact = buildAcceptedResearchArtifactFromWorkerHandoff({
    handoff,
    notePath: "Research/Checkers.md",
    noteSha256: NOTE_SHA256,
    noteReceiptId: NOTE_RECEIPT_ID,
    runId: "run-team-1",
    evidence,
  });
  assert.equal("ok" in artifact && artifact.ok === false, false);
  if ("ok" in artifact) return;
  assert.equal(artifact.notePath, "Research/Checkers.md");
  assert.ok(artifact.evidence.length >= 1);
  assert.equal(artifact.evidence[0]?.reference, "https://rules.example.org/checkers");
  assert.doesNotMatch(
    artifact.evidence[0]?.reference ?? "",
    /example\.com\/research/iu,
  );

  const durable = buildResearcherHandoffV1FromWorker({
    handoff,
    runId: "run-team-1",
    taskId: "task-research",
    notePath: artifact.notePath,
    noteSha256: artifact.noteSha256,
    noteReceiptId: artifact.noteReceiptId,
    acceptedArtifactFingerprint: artifact.artifactFingerprint,
    artifact,
    evidence,
  });
  assert.equal("ok" in durable && durable.ok === false, false);
  if ("ok" in durable) return;
  assert.equal(durable.kind, "researcher_to_lead");
  assert.equal(durable.status, "accepted");
  const attach = formatBridgedHandoffAttachContext({
    artifact,
    durableHandoff: durable,
  });
  assert.match(attach, /Host-attached AcceptedResearchArtifact/u);
  assert.match(attach, /https:\/\/rules\.example\.org\/checkers/u);
});

test("bridge never invents example.com provenance for opaque evidence ids", () => {
  const handoff = acceptedHandoff();
  const withoutEvidence = buildAcceptedResearchArtifactFromWorkerHandoff({
    handoff,
    notePath: "Research/Checkers.md",
    noteSha256: NOTE_SHA256,
    noteReceiptId: NOTE_RECEIPT_ID,
    runId: "run-team-1",
  });
  assert.deepEqual(withoutEvidence, {
    ok: false,
    reason: "no_resolvable_evidence_references",
  });

  const resolved = resolveAcceptedResearchEvidenceFromWorker({
    handoff,
    runId: "run-team-1",
    evidence: usableEvidence(),
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.kind, "web");
  assert.equal(resolved[0]?.reference, "https://rules.example.org/checkers");
  assert.doesNotMatch(resolved[0]?.reference ?? "", /example\.com\/research/iu);
});

test("bridge accepts vault markdown paths from mission evidence", () => {
  const handoff = acceptedHandoff();
  handoff.sourceIds = ["Notes/Local source.md"];
  handoff.evidenceIds = ["vault:Notes/Local source.md"];
  const artifact = buildAcceptedResearchArtifactFromWorkerHandoff({
    handoff,
    notePath: "Research/Checkers.md",
    noteSha256: NOTE_SHA256,
    noteReceiptId: NOTE_RECEIPT_ID,
    runId: "run-team-1",
    evidence: [
      {
        id: "vault:Notes/Local source.md",
        kind: "vault_note",
        title: "Local source",
        path: "Notes/Local source.md",
        passageIds: ["passage-local-1"],
        summary: "Vault note evidence.",
        confidence: "medium",
      },
    ],
  });
  assert.equal("ok" in artifact && artifact.ok === false, false);
  if ("ok" in artifact) return;
  assert.equal(artifact.evidence[0]?.kind, "vault");
  assert.equal(artifact.evidence[0]?.reference, "Notes/Local source.md");
});

test("bridge rejects preparing handoff with zero evidence", () => {
  const handoff = acceptedHandoff();
  handoff.status = "preparing";
  handoff.evidenceIds = [];
  handoff.sourceIds = [];
  const artifact = buildAcceptedResearchArtifactFromWorkerHandoff({
    handoff,
    notePath: "Research/Checkers.md",
    noteSha256: NOTE_SHA256,
    noteReceiptId: NOTE_RECEIPT_ID,
    runId: "run-team-1",
  });
  assert.deepEqual(artifact, {
    ok: false,
    reason: "handoff_status_preparing",
  });
});

test("bridge does not promote a merely ready worker handoff to accepted research", () => {
  const handoff = acceptedHandoff();
  handoff.status = "ready";
  const artifact = buildAcceptedResearchArtifactFromWorkerHandoff({
    handoff,
    notePath: "Research/Checkers.md",
    noteSha256: NOTE_SHA256,
    noteReceiptId: NOTE_RECEIPT_ID,
    runId: "run-team-1",
    evidence: usableEvidence(),
  });
  assert.deepEqual(artifact, { ok: false, reason: "handoff_status_ready" });
});

test("bridge requires the exact host-observed note hash and durable receipt", () => {
  const handoff = acceptedHandoff();
  assert.deepEqual(
    buildAcceptedResearchArtifactFromWorkerHandoff({
      handoff,
      notePath: "Research/Checkers.md",
      noteSha256: "",
      noteReceiptId: NOTE_RECEIPT_ID,
      runId: "run-team-1",
      evidence: usableEvidence(),
    }),
    { ok: false, reason: "verified_note_hash_required" },
  );
  assert.deepEqual(
    buildAcceptedResearchArtifactFromWorkerHandoff({
      handoff,
      notePath: "Research/Checkers.md",
      noteSha256: NOTE_SHA256,
      noteReceiptId: "",
      runId: "run-team-1",
      evidence: usableEvidence(),
    }),
    { ok: false, reason: "verified_note_receipt_required" },
  );
});
