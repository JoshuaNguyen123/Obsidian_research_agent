import test from "node:test";
import assert from "node:assert/strict";
import { prepareScheduledDispatch, bindScheduledNoteContext, evaluateScheduledPreflight, scheduledPreparedAuthority } from "../src/agent/scheduledDispatch";
import { resolveCurrentNoteFile } from "../src/tools/currentNote";
import type { ToolExecutionContext } from "../src/tools/types";
import { AuthorityGrantStore, createAuthorityGrantStoreState, createBoundedGrant } from "../src/agent/authority";
import { withPreparedActionFingerprint, type ToolDescriptor } from "../src/agent/actions";
import { createDurableMissionManifest, type DurableMissionManifestV1 } from "../src/agent/durableMission";
import { getDueMissions, latestScheduleOccurrenceAt, MissionScheduler, normalizeScheduledMissions } from "../src/agent/missionScheduler";

test("restart at either dispatch persistence boundary reuses one mission and consumed totals", async () => {
  let schedule = normalizeScheduledMissions([{ id: "scheduled-test", cadence: "daily", hourLocal: 8, prompt: "Research and append", enabled: true }])[0];
  let savedSchedule = "";
  const missions = new Map<string, DurableMissionManifestV1>();
  let failWrite = true;
  const deps = {
    now: new Date(2026, 8, 4, 12), saveSchedule: async () => { savedSchedule = JSON.stringify([schedule]); },
    readMission: async (id: string) => missions.get(id) ?? null,
    createMission: (missionId: string) => createDurableMissionManifest({ missionId, prompt: schedule.prompt }),
    saveMission: async (manifest: DurableMissionManifestV1) => { if (failWrite) throw new Error("crash before manifest write"); missions.set(manifest.missionId, manifest); },
  };
  await assert.rejects(prepareScheduledDispatch(schedule, deps));
  schedule = normalizeScheduledMissions(JSON.parse(savedSchedule))[0];
  failWrite = false;
  const first = await prepareScheduledDispatch(schedule, deps);
  first.usage.modelSteps = 123;
  schedule = normalizeScheduledMissions(JSON.parse(savedSchedule))[0];
  const resumed = await prepareScheduledDispatch(schedule, deps);
  assert.equal(resumed.missionId, first.missionId);
  assert.equal(resumed.usage.modelSteps, 123);
  assert.equal(missions.size, 1);
});

test("missed daily slots coalesce without moving the configured local hour", () => {
  const mission = normalizeScheduledMissions([{ id: "daily", prompt: "Research", cadence: "daily", hourLocal: 8, lastRunAt: new Date(2026, 8, 1, 14).toISOString() }])[0];
  const now = new Date(2026, 8, 4, 10);
  assert.equal(getDueMissions([mission], now).length, 1);
  assert.equal(latestScheduleOccurrenceAt(mission, now)?.getHours(), 8);
  assert.equal(latestScheduleOccurrenceAt(mission, now)?.getDate(), 4);
});

test("overlapping scheduler ticks dispatch only once", async () => {
  let release!: () => void;
  let count = 0;
  const scheduler = new MissionScheduler({ getSchedules: () => normalizeScheduledMissions([{ id: "hourly", prompt: "Research", cadence: "hourly" }]), onDue: async () => {
    count++; await new Promise<void>((resolve) => { release = resolve; });
  } });
  const first = scheduler.tick(new Date());
  await scheduler.tick(new Date());
  assert.equal(count, 1);
  release(); await first;
});

test("scheduled context pins its output and never inherits another focused note", () => {
  const bound = { path: "Bound.md", extension: "md" };
  const ambient = { path: "Unrelated.md", extension: "md" };
  const context = { app: { vault: { getFileByPath: (p: string) => p === bound.path ? bound : null }, workspace: { getActiveFile: () => ambient } },
    getCurrentMarkdownFile: () => ambient } as unknown as ToolExecutionContext;
  const manifest = createDurableMissionManifest({ missionId: "schedule-context", prompt: "Append a summary", currentNotePath: bound.path });
  assert.equal(resolveCurrentNoteFile(bindScheduledNoteContext(context, manifest)), bound);
  manifest.currentNotePath = "Missing.md";
  assert.equal(resolveCurrentNoteFile(bindScheduledNoteContext(context, manifest)), null);
  manifest.currentNotePath = undefined;
  assert.equal(resolveCurrentNoteFile(bindScheduledNoteContext(context, manifest)), null);
  const readiness = evaluateScheduledPreflight({ manifest, readiness: [], noteExists: false, repositoryProfiles: [], store: null });
  assert.ok(readiness.blockers.some((blocker) => blocker.includes("Bind an output note")));
});

test("schedule authority keeps segment identities and exhausts across store restarts", async () => {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60_000);
  const descriptor: ToolDescriptor = {
    version: 1, name: "linear_create_issue", capability: { system: "linear", resourceType: "issue", action: "create" },
    effect: "reversible_mutation", risk: "medium", approval: { allowPromptGrant: false, allowPersistentGrant: true, fallback: "exact" },
    execution: { preparation: "required", cacheable: false, parallelSafe: false },
    durability: { journal: true, receipt: true, readback: "required", reconciliation: "required" }, allowedPrincipals: ["single_agent"],
  };
  const action = await withPreparedActionFingerprint({ version: 1, id: "action", runId: "executing-segment", toolCallId: "call", toolName: descriptor.name,
    target: { system: "linear", resourceType: "issue", id: "new:issue", teamId: "team" }, relatedResources: [], normalizedArgs: { title: "Test" },
    preview: { summary: "Create issue", destination: "team", outboundPayload: { title: "Test" }, warnings: [], outboundBytes: 4 },
    idempotencyKey: "executing-segment:node", preparedAt: now.toISOString(), expiresAt: expiresAt.toISOString() });
  const grant = await createBoundedGrant({ id: "schedule-grant", kind: "scheduled_bounded", subject: { type: "schedule", id: "daily" },
    rules: [{ system: "linear", resourceTypes: ["issue"], actions: ["create"], selector: { teamIds: ["team"] } }],
    limits: { maxActions: 1, maxExternalMutations: 1, maxCreates: 1, maxDeletes: 0, maxOutboundBytes: 10 }, issuedAt: now, expiresAt });
  const store = new AuthorityGrantStore(createAuthorityGrantStoreState(), async () => {});
  await store.upsert(grant);
  assert.equal(await scheduledPreparedAuthority("other", store).resolve({ action, descriptor }), null);
  const authority = scheduledPreparedAuthority("daily", store);
  assert.equal((await authority.resolve({ action, descriptor }))?.id, grant.id);
  await authority.consume({ grantId: grant.id, action, descriptor });
  const restarted = new AuthorityGrantStore(store.snapshot(), async () => {});
  assert.equal(await scheduledPreparedAuthority("daily", restarted).resolve({ action, descriptor }), null);
  assert.equal(restarted.get(grant.id)?.usage.actions, 1);
  assert.equal(action.runId, "executing-segment");
  const expired = await createBoundedGrant({ ...grant, issuedAt: new Date(now.getTime() - 60_000), expiresAt: new Date(now.getTime() - 1), kind: "scheduled_bounded" });
  await store.upsert(expired);
  assert.equal(await scheduledPreparedAuthority("daily", store).resolve({ action, descriptor }), null);
});
