import { createScheduleOccurrence, type ScheduledMission } from "./missionScheduler";
import type { DurableMissionManifestV1 } from "./durableMission";
import type { PreparedAction, ToolDescriptor } from "./actions";
import type { AuthorityGrantStore } from "./authority/AuthorityGrantStore";
import { evaluateAuthorityGrant } from "./authority/grants";
import { evaluateMissionReadinessPreflightV1 } from "./missionReadinessPreflight";
import type { CapabilityReadinessV2 } from "./capabilityReadiness";
import type { ToolExecutionContext } from "../tools/types";

export function bindScheduledNoteContext(context: ToolExecutionContext, manifest: DurableMissionManifestV1): ToolExecutionContext {
  return { ...context, getCurrentMarkdownFile: () => {
    const file = manifest.currentNotePath ? context.app.vault.getFileByPath(manifest.currentNotePath) : null;
    return file?.extension === "md" ? file : null;
  } };
}

export function scheduledPreparedAuthority(scheduleId: string, store: AuthorityGrantStore) {
  const subject = { type: "schedule" as const, id: scheduleId };
  return {
    subject,
    resolve: async ({ action, descriptor }: { action: PreparedAction; descriptor: ToolDescriptor }) => {
      for (const grant of store.snapshot().grants) {
        const result = await evaluateAuthorityGrant({ grant, action, descriptor, subject, now: new Date() });
        if (result.allowed) return result.grant;
      }
      return null;
    },
    consume: (input: { grantId: string; action: PreparedAction; descriptor: ToolDescriptor }) => store.authorizeAndConsume({ ...input, subject, now: new Date() }),
  };
}

export function evaluateScheduledPreflight(input: {
  manifest: DurableMissionManifestV1; readiness: readonly CapabilityReadinessV2[];
  noteExists: boolean; repositoryProfiles: readonly string[]; store: AuthorityGrantStore | null;
}) {
  const { manifest } = input;
  const preflight = evaluateMissionReadinessPreflightV1({ prompt: manifest.prompt, readiness: input.readiness,
    activeNote: { hasActiveMarkdown: input.noteExists, path: manifest.currentNotePath } });
  const blockers = preflight.missing.map((item) => `${item.label}: ${item.reason}`);
  if (input.readiness.find((row) => row.id === "model")?.status !== "Ready") blockers.push("Model connection must be verified before unattended execution.");
  if (manifest.currentNotePath && !input.noteExists) blockers.push("The bound destination note is missing.");
  if (!manifest.currentNotePath && /\b(?:append|replace|current note|this note)\b/iu.test(manifest.prompt)) blockers.push("Bind an output note for unattended current-note work.");
  const codeRequired = preflight.stages.includes("code_execution");
  if (codeRequired && input.repositoryProfiles.length === 0) blockers.push("Bind a trusted repository profile before code execution.");
  const grants = input.store?.snapshot().grants.filter((grant) => grant.subject.type === "schedule" &&
    grant.subject.id === manifest.scheduleId && grant.state === "active" && Date.parse(grant.expiresAt) > Date.now() && grant.usage.actions < grant.limits.maxActions) ?? [];
  if (preflight.compound && grants.length === 0) blockers.push("Review bounded authority for this schedule before unattended external actions.");
  for (const system of ["linear", "github"] as const) {
    if (preflight.checks.some((check) => check.id === system && check.required) && !grants.some((grant) =>
      grant.usage.externalMutations < grant.limits.maxExternalMutations &&
      grant.rules.some((rule) => rule.system === system && rule.actions.some((action) => ["create", "update", "publish"].includes(action))))) {
      blockers.push(`Review unexpired ${system} mutation authority for this schedule.`);
    }
  }
  const authorization = grants.map((grant) => ({ id: grant.id, expiresAt: grant.expiresAt,
    remainingActions: Math.max(0, grant.limits.maxActions - grant.usage.actions),
    systems: [...new Set(grant.rules.map((rule) => rule.system))] }));
  return { ok: blockers.length === 0, blockers, authorization, deadlineAt: manifest.deadlineAt, budget: manifest.policy };
}

/** Persist the occurrence before allocating its durable mission. A restart
 * between the two writes recreates only the same deterministic mission id. */
export async function prepareScheduledDispatch(mission: ScheduledMission, dependencies: {
  now: Date;
  saveSchedule(): Promise<void>;
  readMission(id: string): Promise<DurableMissionManifestV1 | null>;
  createMission(id: string): DurableMissionManifestV1;
  saveMission(manifest: DurableMissionManifestV1): Promise<void>;
}): Promise<DurableMissionManifestV1> {
  if (mission.occurrence?.status !== "pending") {
    mission.occurrence = createScheduleOccurrence(mission, dependencies.now);
  }
  // Also retry this write after an earlier ambiguous/failed settings save.
  await dependencies.saveSchedule();
  const existing = await dependencies.readMission(mission.occurrence.missionId);
  if (existing) return existing;
  const manifest = dependencies.createMission(mission.occurrence.missionId);
  await dependencies.saveMission(manifest);
  return manifest;
}
