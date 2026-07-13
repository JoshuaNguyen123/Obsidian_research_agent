import { expect, type Locator, type Page } from "@playwright/test";

import {
  NATIVE_CORE_PLUGIN_ID,
  startNativeObsidianHarness,
  type NativeObsidianHarness,
} from "./nativeObsidianHarness";

const COMPANION_PLUGIN_ID = "agentic-researcher-companion";

export interface Phase3EffectfulSnapshot {
  postCount: number;
  providerMutationCount: number;
  foregroundMutationCount: number;
  modelToolCallCount: number;
  walPresentBeforePost: boolean;
  remoteState: string | null;
  receiptStatuses: string[];
  verifiedReconciliationMode: string | null;
  runtimeJournal: {
    state: string;
    nodeId: string | null;
    attemptStatus: string | null;
    jobId: string | null;
    handoffFingerprint: string | null;
    verifiedReceiptFingerprint: string | null;
    transitionStates: string[];
  } | null;
  graphNode: {
    status: string;
    receiptKinds: string[];
    evidenceKinds: string[];
    verifierId: string | null;
  } | null;
  lineage: {
    state: string;
    lastObservedEventSequence: number;
    lastAppliedEventSequence: number;
    reconcileStatus: string;
  } | null;
}

export interface Phase3EffectfulCompanionHarness extends NativeObsidianHarness {
  submitMission(prompt: string): Promise<void>;
  activeApproval(): Locator;
  approve(approval: Locator): Promise<void>;
  waitForRemoteSubmission(): Promise<void>;
  disconnectCompanion(): Promise<void>;
  waitForRemoteCompletion(): Promise<void>;
  reconnectCompanion(): Promise<void>;
  readSnapshot(): Promise<Phase3EffectfulSnapshot>;
}

export async function startPhase3EffectfulCompanionHarness(): Promise<Phase3EffectfulCompanionHarness> {
  const native = await startNativeObsidianHarness({
    label: "phase3-effectful-linear-companion",
    setup: installEffectfulPageHarness,
  });
  try {
    await expect(native.page.locator(".agentic-researcher-view")).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(native.page.getByRole("tab", { name: "Chat" })).toBeVisible();
  } catch (error) {
    await native.close().catch(() => undefined);
    throw error;
  }
  return {
    ...native,
    submitMission: (prompt) => submitMission(native.page, prompt),
    activeApproval: () => activeApproval(native.page),
    approve: (approval) => approve(native.page, approval),
    waitForRemoteSubmission: () => waitForRemoteSubmission(native.page),
    disconnectCompanion: () => disconnectCompanion(native.page),
    waitForRemoteCompletion: () =>
      expect
        .poll(() => readRemoteState(native.page), {
          timeout: 60_000,
          message: "the fake provider should reach delayed verified completion",
        })
        .toBe("complete"),
    reconnectCompanion: () => reconnectCompanion(native.page),
    readSnapshot: () => readSnapshot(native.page),
  };
}

async function installEffectfulPageHarness(context: {
  page: Page;
  marker: string;
  notePath: string;
}): Promise<void> {
  await context.page.evaluate(
    async ({ corePluginId, companionPluginId, marker, notePath }) => {
      const effectfulWindow = window as typeof window & {
        app?: any;
        __e2ePhase3Effectful?: any;
      };
      const app = effectfulWindow.app;
      if (!app?.plugins || !app?.vault || !app?.workspace) {
        throw new Error("Obsidian app APIs are unavailable.");
      }
      if (typeof app.workspace.onLayoutReady === "function") {
        await new Promise<void>((resolve) => app.workspace.onLayoutReady(resolve));
      }
      let core: any = null;
      let companion: any = null;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        core = app.plugins.plugins?.[corePluginId] ?? null;
        companion = app.plugins.plugins?.[companionPluginId] ?? null;
        if (
          core?.agenticResearcherApi?.state === "ready" &&
          companion?.pairForegroundCompanion &&
          companion?.companionCoordinator
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (
        core?.agenticResearcherApi?.state !== "ready" ||
        !companion?.pairForegroundCompanion
      ) {
        throw new Error("Core and companion production plugins did not become ready.");
      }

      const ensureFolder = async (folderPath: string) => {
        let current = "";
        for (const part of folderPath.split("/").filter(Boolean)) {
          current = current ? `${current}/${part}` : part;
          if (app.vault.getAbstractFileByPath(current)) continue;
          try {
            await app.vault.createFolder(current);
          } catch (error) {
            if (!/already exists/iu.test(String(error))) throw error;
          }
        }
      };
      await ensureFolder(notePath.split("/").slice(0, -1).join("/"));
      const existingNote = app.vault.getAbstractFileByPath(notePath);
      if (existingNote) await app.vault.delete(existingNote, true);
      const note = await app.vault.create(
        notePath,
        `# Phase 3 effectful companion\n\n${marker}\n`,
      );
      const noteLeaf =
        (app.workspace.getLeavesOfType?.("markdown") ?? [])[0] ??
        (app.workspace.getLeavesOfType?.("empty") ?? [])[0] ??
        app.workspace.getLeaf("tab");
      await noteLeaf.openFile(note);
      app.workspace.setActiveLeaf(noteLeaf, { focus: true });

      const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
      const fingerprint = (character: string) =>
        `sha256:${character.repeat(64)}`;
      const canonicalJson = (value: any): string => {
        if (
          value === null ||
          typeof value === "string" ||
          typeof value === "boolean"
        ) {
          return JSON.stringify(value);
        }
        if (typeof value === "number") {
          if (!Number.isFinite(value)) throw new Error("Non-finite canonical number.");
          return Object.is(value, -0) ? "0" : JSON.stringify(value);
        }
        if (Array.isArray(value)) {
          return `[${value.map(canonicalJson).join(",")}]`;
        }
        if (!value || typeof value !== "object") {
          throw new Error("Unsupported canonical value.");
        }
        return `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
          .join(",")}}`;
      };
      const sha256 = async (value: any) => {
        const bytes = new TextEncoder().encode(canonicalJson(value));
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return `sha256:${[...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("")}`;
      };
      const state: any = {
        marker,
        jobs: {},
        receipts: {},
        events: {},
        postBodies: [],
        requestLog: [],
        postCount: 0,
        providerMutationCount: 0,
        foregroundMutationCount: 0,
        modelToolCallCount: 0,
        walPresentBeforePost: false,
        issue: {
          resourceType: "issue",
          id: "issue-42",
          identifier: "PLAT-42",
          url: "https://linear.app/e2e/issue/PLAT-42",
          title: "Ship effectful background continuation",
          description: "Deterministic Playwright fixture.",
          priority: 0,
          trashed: false,
          labels: [],
          team: { id: "team-platform", name: "Platform", key: "PLAT" },
          state: { id: "state-started", name: "In Progress", type: "started" },
          project: { id: "project-platform", name: "Agentic Researcher" },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          snapshotHash: fingerprint("a"),
        },
      };
      const pageResult = (items: any[]) => ({
        items,
        pageInfo: { hasNextPage: false },
        fetchedAt: new Date().toISOString(),
      });
      const linearClient = {
        async execute(operationKey: string, variables: Record<string, unknown> = {}) {
          switch (operationKey) {
            case "connection.context":
              return {
                viewer: { id: "viewer-e2e", name: "E2E Agent" },
                workspace: { id: "workspace-e2e", name: "E2E Workspace" },
                fetchedAt: new Date().toISOString(),
              };
            case "teams.list":
              return pageResult([
                {
                  resourceType: "team",
                  id: "team-platform",
                  name: "Platform",
                  key: "PLAT",
                  snapshotHash: fingerprint("b"),
                },
              ]);
            case "projects.list":
              return pageResult([
                {
                  resourceType: "project",
                  id: "project-platform",
                  name: "Agentic Researcher",
                  url: "https://linear.app/e2e/project/platform",
                  attributes: { teams: ["team-platform"] },
                  snapshotHash: fingerprint("c"),
                },
              ]);
            case "workflow_states.list":
              return pageResult([
                {
                  resourceType: "workflow_state",
                  id: "state-started",
                  name: "In Progress",
                  type: "started",
                  attributes: { team: "team-platform" },
                  snapshotHash: fingerprint("d"),
                },
                {
                  resourceType: "workflow_state",
                  id: "state-done",
                  name: "Done",
                  type: "completed",
                  attributes: { team: "team-platform" },
                  snapshotHash: fingerprint("e"),
                },
              ]);
            case "issues.get":
              if (String(variables.id ?? "") !== state.issue.id) {
                throw new Error("Unexpected E2E Linear issue id.");
              }
              return clone(state.issue);
            case "issues.update":
              state.foregroundMutationCount += 1;
              state.issue.state = {
                id: String((variables.input as any)?.stateId ?? ""),
                name: "Done",
                type: "completed",
              };
              return {
                success: true,
                operationKey,
                operationName: "IssueUpdate",
                resourceType: "issue",
                acknowledgedAt: new Date().toISOString(),
              };
            default:
              throw new Error(`Unexpected E2E Linear operation: ${operationKey}`);
          }
        },
      };

      core.linearApiKey = "e2e-session-placeholder";
      core.persistLegacyLinearApiKey = true;
      core.createSecretBackedLinearClient = () => linearClient;
      core.settings.linearEnabled = true;
      core.settings.linearQueueEnabled = false;
      core.settings.enableStreaming = false;
      core.settings.thinkingMode = "off";
      core.settings.modelRouterMode = "off";
      core.settings.orchestratorEnabled = false;
      core.settings.orchestratorPreviewEnabled = false;
      core.settings.agenticReflexEnabled = false;
      core.settings.semanticIndexEnabled = false;
      core.settings.streamWritebackMode = "off";
      core.settings.maxAgentSteps = 8;
      core.saveSettings = async () => undefined;
      const connection = await core.testLinearConnection();
      if (!connection?.ok) {
        throw new Error(`Fixed Linear discovery failed: ${String(connection?.message)}`);
      }
      core.linearCredentialReference = {
        version: 1,
        referenceId: "credential_linear1234",
        label: "E2E Linear credential",
        backend: "e2e-secure-store",
        persistent: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: { provider: "linear" },
      };

      const modelSteps = new Map<string, number>();
      const createModelClient = () => ({
        playwrightE2EMock: true,
        async chat(request: any) {
          const requestText = (request.messages ?? [])
            .map((message: any) => String(message.content ?? ""))
            .join("\n");
          const tools = (request.tools ?? [])
            .map((tool: any) => tool.function?.name)
            .filter((name: unknown): name is string => typeof name === "string");
          if (!requestText.includes("E2E_EFFECTFUL_LINEAR_BACKGROUND")) {
            throw new Error("Phase 3 model received an unsupported mission.");
          }
          if (request.format !== undefined) {
            return {
              message: { role: "assistant", content: "{}" },
              toolCalls: [],
              raw: { playwrightPhase3Effectful: true },
            };
          }
          const step = modelSteps.get(marker) ?? 0;
          if (step === 0) {
            if (!tools.includes("linear_update_issue")) {
              throw new Error(
                `Background Linear mission omitted linear_update_issue. Tools: ${tools.join(", ")}`,
              );
            }
            modelSteps.set(marker, 1);
            state.modelToolCallCount += 1;
            const toolCall = {
              id: `phase3-effectful-${marker}`,
              index: 0,
              name: "linear_update_issue",
              arguments: { id: "issue-42", stateId: "state-done" },
            };
            return {
              message: { role: "assistant", content: "", toolCalls: [toolCall] },
              toolCalls: [toolCall],
              raw: { playwrightPhase3Effectful: true },
            };
          }
          return {
            message: {
              role: "assistant",
              content: "The approved background Linear update is pending verified readback.",
            },
            toolCalls: [],
            raw: { playwrightPhase3Effectful: true },
          };
        },
        async streamChat() {
          throw new Error("Phase 3 effectful tests disable streaming.");
        },
      });
      const installModel = (target: any) => {
        if (!target) return;
        target.createModelClient = createModelClient;
        target.__playwrightE2EMockInstalled = true;
        const prototype = Object.getPrototypeOf(target);
        if (prototype) prototype.createModelClient = createModelClient;
      };
      installModel(core);
      await core.activateView?.();
      installModel(app.plugins.plugins?.[corePluginId]);
      for (const leaf of app.workspace.getLeavesOfType?.(
        "agentic-researcher-view",
      ) ?? []) {
        installModel(leaf.view?.plugin);
      }

      const parseRuntimeSnapshot = (markdown: string) => {
        const match = /## Runtime Snapshot\r?\n```json\r?\n([\s\S]*?)\r?\n```/u.exec(
          markdown,
        );
        return match ? JSON.parse(match[1]) : null;
      };
      const findRuntimeByJobId = async (jobId: string) => {
        for (const file of app.vault.getMarkdownFiles()) {
          if (!/^Agent Runs\/[^/]+\.md$/iu.test(file.path)) continue;
          const runtime = parseRuntimeSnapshot(await app.vault.cachedRead(file));
          if (
            runtime?.operationJournal?.some(
              (record: any) =>
                record.externalActionDispatchAttempt?.jobId === jobId,
            )
          ) {
            return runtime;
          }
        }
        return null;
      };
      const receiptFingerprint = async (
        remote: any,
        status: string,
        payload: Record<string, unknown>,
      ) =>
        sha256({
          version: 1,
          job: {
            id: remote.id,
            missionId: remote.missionId,
            nodeId: remote.nodeId,
            idempotencyKey: remote.idempotencyKey,
            capabilityEnvelopeFingerprint: remote.capabilityEnvelope.fingerprint,
            authorizationFingerprint: remote.payload.authorization.fingerprint,
          },
          provider: "linear",
          operation: "linear_issue_state_update_v1",
          status,
          payload,
        });
      const appendEvent = (jobId: string, type: string, payload: any = {}) => {
        const events = state.events[jobId] ?? [];
        events.push({
          sequence: events.length + 1,
          jobId,
          type,
          payload,
          createdAt: new Date().toISOString(),
        });
        state.events[jobId] = events;
      };
      const transitionAmbiguous = async (jobId: string) => {
        const remote = state.jobs[jobId];
        if (!remote || remote.state === "complete") return;
        const handoff = remote.payload.preparedExternalActionHandoff;
        if (!handoff) throw new Error("Effectful remote job omitted its handoff.");
        if (!(state.receipts[jobId] ?? []).some((item: any) => item.status === "dispatched")) {
          state.providerMutationCount += 1;
          state.issue.state = { id: "state-done", name: "Done", type: "completed" };
          state.issue.updatedAt = new Date().toISOString();
          const attemptId = await sha256({
            version: 1,
            jobId,
            handoffFingerprint: handoff.fingerprint,
            preparedActionFingerprint: handoff.preparedActionFingerprint,
            reconciliationKey: handoff.reconciliationKey,
          });
          const basePayload = {
            attemptId,
            handoffFingerprint: handoff.fingerprint,
            preparedActionFingerprint: handoff.preparedActionFingerprint,
            issueId: handoff.payload.issueId,
            targetStateId: handoff.payload.stateId,
            preconditionFingerprint: handoff.payload.preconditionFingerprint,
          };
          const dispatchedAt = new Date().toISOString();
          const dispatched = {
            id: `receipt-${jobId}-dispatched`,
            jobId,
            provider: "linear",
            operation: "linear_issue_state_update_v1",
            status: "dispatched",
            fingerprint: await receiptFingerprint(remote, "dispatched", basePayload),
            payload: basePayload,
            createdAt: dispatchedAt,
          };
          const ambiguousPayload = {
            ...basePayload,
            observedStateId: "state-started",
            observedUpdatedAt: dispatchedAt,
            readbackFingerprint: fingerprint("8"),
            reconciliationMode: "dispatch",
          };
          const ambiguous = {
            id: `receipt-${jobId}-ambiguous`,
            jobId,
            provider: "linear",
            operation: "linear_issue_state_update_v1",
            status: "ambiguous",
            fingerprint: await receiptFingerprint(remote, "ambiguous", ambiguousPayload),
            payload: ambiguousPayload,
            createdAt: new Date().toISOString(),
          };
          state.receipts[jobId] = [dispatched, ambiguous];
          appendEvent(jobId, "external_receipt_recorded", {
            status: "dispatched",
            fingerprint: dispatched.fingerprint,
          });
          appendEvent(jobId, "external_receipt_recorded", {
            status: "ambiguous",
            fingerprint: ambiguous.fingerprint,
          });
        }
      };
      const transitionComplete = async (jobId: string) => {
        await transitionAmbiguous(jobId);
        const remote = state.jobs[jobId];
        if (!remote || remote.state === "complete") return;
        const handoff = remote.payload.preparedExternalActionHandoff;
        const dispatched = (state.receipts[jobId] ?? []).find(
          (item: any) => item.status === "dispatched",
        );
        const basePayload = dispatched.payload;
        const verifiedPayload = {
          ...basePayload,
          observedStateId: handoff.payload.stateId,
          observedUpdatedAt: new Date().toISOString(),
          readbackFingerprint: fingerprint("9"),
          reconciliationMode: "readback_only",
        };
        const verified = {
          id: `receipt-${jobId}-verified`,
          jobId,
          provider: "linear",
          operation: "linear_issue_state_update_v1",
          status: "verified",
          fingerprint: await receiptFingerprint(remote, "verified", verifiedPayload),
          payload: verifiedPayload,
          createdAt: new Date().toISOString(),
        };
        state.receipts[jobId].push(verified);
        const completion = {
          status: "complete",
          outputs: {
            issueId: handoff.payload.issueId,
            state: handoff.payload.stateId,
            workItemFingerprint: verified.fingerprint,
            summary: "Linear issue state update verified by independent readback.",
          },
          evidence: [
            {
              kind: "linear_readback",
              id: handoff.payload.issueId,
              fingerprint: verified.fingerprint,
              status: "verified",
            },
          ],
          receiptIds: [verified.id],
          blocker: null,
        };
        const resultFingerprint = await sha256({
          version: 1,
          job: {
            id: remote.id,
            missionId: remote.missionId,
            nodeId: remote.nodeId,
            idempotencyKey: remote.idempotencyKey,
            capabilityEnvelopeFingerprint: remote.capabilityEnvelope.fingerprint,
            authorizationFingerprint: remote.payload.authorization.fingerprint,
          },
          result: completion,
        });
        remote.state = "complete";
        remote.output = { ...completion, resultFingerprint };
        remote.updatedAt = new Date().toISOString();
        appendEvent(jobId, "external_receipt_recorded", {
          status: "verified",
          fingerprint: verified.fingerprint,
        });
        appendEvent(jobId, "job_completed", { status: "complete" });
      };
      const jsonResponse = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      const companionFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        state.requestLog.push({
          method: String(init?.method ?? "GET").toUpperCase(),
          path: `${url.pathname}${url.search}`,
          at: new Date().toISOString(),
        });
        if (url.pathname === "/health") {
          return jsonResponse({
            ok: true,
            host: "127.0.0.1",
            port: 18789,
            loopbackOnly: true,
            authRequired: true,
            bodyLimitBytes: 1_048_576,
            coordinatorReady: true,
            workerReady: true,
            workerDiagnostic: null,
            installedExecutorDomains: ["linear"],
            executorCatalogVersion: 1,
            secureStorePersistent: true,
            backgroundEnabled: true,
            backgroundBlocker: null,
            version: "phase3-effectful-e2e",
          });
        }
        if (url.pathname === "/jobs" && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          state.postCount += 1;
          state.postBodies.push(clone(body));
          state.walPresentBeforePost = Boolean(await findRuntimeByJobId(body.id));
          const existing = state.jobs[body.id];
          if (existing) return jsonResponse(existing);
          const now = new Date().toISOString();
          const remote = {
            id: body.id,
            missionId: body.missionId,
            nodeId: body.nodeId,
            executionHost: body.executionHost,
            state: "running",
            payload: body.payload,
            capabilityEnvelope: body.capabilityEnvelope,
            idempotencyKey: body.idempotencyKey,
            ownerCoordinatorId: "phase3-effectful-worker",
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            attempts: 1,
            createdAt: now,
            updatedAt: now,
          };
          state.jobs[body.id] = remote;
          state.receipts[body.id] = [];
          state.events[body.id] = [];
          appendEvent(body.id, "job_accepted", {});
          appendEvent(body.id, "job_started", {});
          setTimeout(() => void transitionAmbiguous(body.id), 800);
          setTimeout(() => void transitionComplete(body.id), 2_000);
          return jsonResponse(remote);
        }
        const segments = url.pathname.split("/").filter(Boolean);
        const jobId = decodeURIComponent(segments[1] ?? "");
        const remote = state.jobs[jobId];
        if (!remote) return jsonResponse({ detail: "not found" }, 404);
        if (segments.length === 2) return jsonResponse(remote);
        if (segments[2] === "receipts") {
          return jsonResponse({ receipts: state.receipts[jobId] ?? [] });
        }
        if (segments[2] === "events") {
          const after = Number(url.searchParams.get("after") ?? 0);
          const frames = (state.events[jobId] ?? [])
            .filter((event: any) => event.sequence > after)
            .map(
              (event: any) =>
                `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join("");
          return new Response(frames, {
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return jsonResponse({ detail: "unsupported" }, 404);
      };
      state.fetchImpl = companionFetch;
      state.readRuntime = async () => {
        const jobId = Object.keys(state.jobs)[0] ?? "";
        return jobId ? findRuntimeByJobId(jobId) : null;
      };
      effectfulWindow.__e2ePhase3Effectful = state;
      await companion.pairForegroundCompanion({
        baseUrl: "http://127.0.0.1:18789",
        acquireBootstrapToken: async () =>
          "phase3-effectful-companion-bootstrap-token-0123456789abcdef",
        fetchImpl: companionFetch,
      });
    },
    {
      corePluginId: NATIVE_CORE_PLUGIN_ID,
      companionPluginId: COMPANION_PLUGIN_ID,
      marker: context.marker,
      notePath: context.notePath,
    },
  );
}

async function waitForRemoteSubmission(page: Page): Promise<void> {
  try {
    await expect
      .poll(() => readEffectfulCounter(page, "postCount"), {
        timeout: 30_000,
        message: "the exact companion job should be submitted once",
      })
      .toBe(1);
  } catch (error) {
    const diagnostics = await readDispatchDiagnostics(page);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nDispatch diagnostics:\n${JSON.stringify(diagnostics, null, 2)}`,
    );
  }
}

async function readDispatchDiagnostics(page: Page): Promise<unknown> {
  return page.evaluate(async ({ companionPluginId }) => {
    const effectfulWindow = window as typeof window & {
      app?: any;
      __e2ePhase3Effectful?: any;
    };
    const app = effectfulWindow.app;
    const state = effectfulWindow.__e2ePhase3Effectful;
    const companion = app?.plugins?.plugins?.[companionPluginId];
    const matchingArtifacts: Array<Record<string, unknown>> = [];
    for (const file of app?.vault?.getMarkdownFiles?.() ?? []) {
      if (!/^Agent Runs\/.+\.md$/iu.test(file.path)) continue;
      const markdown = await app.vault.cachedRead(file);
      if (!markdown.includes(state.marker)) continue;
      const runtimeMatch =
        /## Runtime Snapshot\r?\n```json\r?\n([\s\S]*?)\r?\n```/u.exec(markdown);
      const graphMatch =
        /## Mission Graph Store\r?\n```json\r?\n([\s\S]*?)\r?\n```/u.exec(markdown);
      const runtime = runtimeMatch ? JSON.parse(runtimeMatch[1]) : null;
      const graphRecord = graphMatch ? JSON.parse(graphMatch[1]) : null;
      matchingArtifacts.push({
        path: file.path,
        runtime: runtime
          ? {
              runId: runtime.runId,
              status: runtime.status,
              stopReason: runtime.stopReason,
              operationJournal: runtime.operationJournal,
              missionGraphRef: runtime.missionGraphRef,
            }
          : null,
        graph: graphRecord?.graph
          ? {
              missionId: graphRecord.graph.missionId,
              revision: graphRecord.graph.revision,
              nodes: graphRecord.graph.nodes,
            }
          : null,
      });
    }
    return {
      requestLog: state?.requestLog ?? [],
      postCount: state?.postCount ?? 0,
      foregroundMutationCount: state?.foregroundMutationCount ?? 0,
      modelToolCallCount: state?.modelToolCallCount ?? 0,
      coordinatorSnapshot: companion?.companionCoordinator?.snapshot?.() ?? null,
      coordinatorRuntime:
        companion?.companionCoordinator?.getRuntimeState?.() ?? null,
      matchingArtifacts,
      runDetailsText:
        document.querySelector(".agentic-researcher-view")?.textContent?.slice(-12_000) ??
        null,
    };
  }, { companionPluginId: COMPANION_PLUGIN_ID });
}

async function submitMission(page: Page, prompt: string): Promise<void> {
  await page.getByRole("tab", { name: "Chat" }).click();
  const input = page.locator("textarea.agentic-researcher-prompt");
  await input.fill(prompt);
  await expect(input).toHaveValue(prompt);
  await page.locator("button.agentic-researcher-run").click();
  await expect(
    page.locator(".agentic-researcher-log-user .agentic-researcher-log-message", {
      hasText: prompt,
    }),
  ).toBeVisible({ timeout: 10_000 });
}

function activeApproval(page: Page): Locator {
  return page
    .locator(".agentic-researcher-approval-card", {
      hasText: "linear_update_issue",
    })
    .filter({
      has: page.locator("button.agentic-researcher-approval-approve:enabled"),
    })
    .last();
}

async function approve(page: Page, approval: Locator): Promise<void> {
  await expect(approval).toBeVisible({ timeout: 60_000 });
  await expect(approval).toContainText("exact_payload_approval");
  await expect(approval).toContainText("confirmation=1/1");
  await approval
    .locator("button.agentic-researcher-approval-approve:enabled")
    .click();
  await expect(approval).toHaveCount(0, { timeout: 15_000 });
}

async function disconnectCompanion(page: Page): Promise<void> {
  await page.evaluate(({ companionPluginId }) => {
    const extension = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[companionPluginId];
    if (!extension?.companionCoordinator) {
      throw new Error("Companion coordinator is unavailable for disconnect.");
    }
    extension.companionCoordinator.clearSession();
  }, { companionPluginId: COMPANION_PLUGIN_ID });
}

async function reconnectCompanion(page: Page): Promise<void> {
  await page.evaluate(async ({ companionPluginId }) => {
    const effectfulWindow = window as typeof window & {
      app?: any;
      __e2ePhase3Effectful?: any;
    };
    const extension = effectfulWindow.app?.plugins?.plugins?.[companionPluginId];
    const state = effectfulWindow.__e2ePhase3Effectful;
    if (!extension?.pairForegroundCompanion || !state?.fetchImpl) {
      throw new Error("Companion reconnect fixture is unavailable.");
    }
    await extension.pairForegroundCompanion({
      baseUrl: "http://127.0.0.1:18789",
      acquireBootstrapToken: async () =>
        "phase3-effectful-companion-bootstrap-token-0123456789abcdef",
      fetchImpl: state.fetchImpl,
    });
  }, { companionPluginId: COMPANION_PLUGIN_ID });
}

async function readEffectfulCounter(
  page: Page,
  key: "postCount" | "providerMutationCount" | "foregroundMutationCount",
): Promise<number> {
  return page.evaluate((counterKey) => {
    const state = (window as typeof window & { __e2ePhase3Effectful?: any })
      .__e2ePhase3Effectful;
    return Number(state?.[counterKey] ?? 0);
  }, key);
}

async function readRemoteState(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const state = (window as typeof window & { __e2ePhase3Effectful?: any })
      .__e2ePhase3Effectful;
    const jobId = Object.keys(state?.jobs ?? {})[0];
    return jobId ? String(state.jobs[jobId]?.state ?? "") : null;
  });
}

async function readSnapshot(page: Page): Promise<Phase3EffectfulSnapshot> {
  return page.evaluate(async ({ companionPluginId }) => {
    const effectfulWindow = window as typeof window & {
      app?: any;
      __e2ePhase3Effectful?: any;
    };
    const app = effectfulWindow.app;
    const state = effectfulWindow.__e2ePhase3Effectful;
    const jobId = Object.keys(state?.jobs ?? {})[0] ?? "";
    const remote = jobId ? state.jobs[jobId] : null;
    const runtime = await state?.readRuntime?.();
    const journal = runtime?.operationJournal?.find(
      (record: any) => record.externalActionDispatchAttempt?.jobId === jobId,
    );
    let graphNode: any = null;
    if (runtime?.missionGraphRef?.path) {
      const graphFile = app.vault.getAbstractFileByPath(runtime.missionGraphRef.path);
      if (graphFile) {
        const markdown = await app.vault.cachedRead(graphFile);
        const match = /## Mission Graph Store\r?\n```json\r?\n([\s\S]*?)\r?\n```/u.exec(
          markdown,
        );
        const record = match ? JSON.parse(match[1]) : null;
        graphNode = journal?.nodeId ? record?.graph?.nodes?.[journal.nodeId] : null;
      }
    }
    const lineage = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[companionPluginId]?.companionCoordinator?.getRuntimeState?.()
      ?.jobs?.[jobId];
    const receipts = jobId ? state.receipts[jobId] ?? [] : [];
    const verified = receipts.find((receipt: any) => receipt.status === "verified");
    return {
      postCount: Number(state?.postCount ?? 0),
      providerMutationCount: Number(state?.providerMutationCount ?? 0),
      foregroundMutationCount: Number(state?.foregroundMutationCount ?? 0),
      modelToolCallCount: Number(state?.modelToolCallCount ?? 0),
      walPresentBeforePost: state?.walPresentBeforePost === true,
      remoteState: remote?.state ?? null,
      receiptStatuses: receipts.map((receipt: any) => String(receipt.status)),
      verifiedReconciliationMode:
        verified?.payload?.reconciliationMode ?? null,
      runtimeJournal: journal
        ? {
            state: String(journal.state),
            nodeId: journal.nodeId ?? null,
            attemptStatus:
              journal.externalActionDispatchAttempt?.status ?? null,
            jobId: journal.externalActionDispatchAttempt?.jobId ?? null,
            handoffFingerprint:
              journal.preparedExternalActionHandoff?.fingerprint ?? null,
            verifiedReceiptFingerprint:
              journal.externalActionDispatchAttempt
                ?.verifiedReceiptFingerprint ?? null,
            transitionStates: (journal.transitions ?? []).map((item: any) =>
              String(item.state),
            ),
          }
        : null,
      graphNode: graphNode
        ? {
            status: String(graphNode.status),
            receiptKinds: (graphNode.receipts ?? []).map((item: any) =>
              String(item.kind),
            ),
            evidenceKinds: (graphNode.evidence ?? []).map((item: any) =>
              String(item.kind),
            ),
            verifierId: graphNode.verification?.verifierId ?? null,
          }
        : null,
      lineage: lineage
        ? {
            state: String(lineage.state),
            lastObservedEventSequence: Number(
              lineage.lastObservedEventSequence ?? 0,
            ),
            lastAppliedEventSequence: Number(
              lineage.lastAppliedEventSequence ?? 0,
            ),
            reconcileStatus: String(lineage.reconcileStatus),
          }
        : null,
    };
  }, { companionPluginId: COMPANION_PLUGIN_ID });
}
