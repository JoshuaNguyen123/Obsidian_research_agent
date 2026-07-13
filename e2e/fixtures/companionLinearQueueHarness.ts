import type { Page } from "@playwright/test";

import {
  createWorkItemSpecV2,
  renderWorkItemSpecV2,
} from "../../src/integrations/linear";
import {
  NATIVE_CORE_PLUGIN_ID,
  startNativeObsidianHarness,
} from "./nativeObsidianHarness";

const COMPANION_PLUGIN_ID = "agentic-researcher-companion";
const COMPANION_RECONCILE_EVENT =
  "agentic-researcher:companion-reconcile";

export interface CompanionLinearQueueScheduledReadback {
  candidateFingerprint: string;
  eventSequence: number;
  issueId: string;
  jobId: string;
  mode: "complete" | "blocked";
  readbackFingerprint: string;
  workItemFingerprint: string;
}

export interface CompanionLinearQueueSnapshot {
  acknowledgedThrough: number[];
  activeGrant: {
    authorityFingerprint: string;
    expiresAt: string;
    id: string;
    issuedAt: string;
    state: string;
    subject: { id: string; type: string };
  } | null;
  authorization: { message: string; ok: boolean } | null;
  companionProviderReadCount: number;
  configuration: Record<string, any> | null;
  configurationDriftCount: number;
  configureBodies: Array<Record<string, any>>;
  eventReplayAfter: number[];
  events: Array<{
    createdAt: string;
    payload: Record<string, any>;
    sequence: number;
    type: string;
  }>;
  foregroundListCount: number;
  foregroundReadCount: number;
  foregroundRestartCount: number;
  foregroundSupervisorRunning: boolean;
  jobGetCounts: Record<string, number>;
  linearCalls: Array<{
    operationKey: string;
    variables: Record<string, unknown>;
  }>;
  mutationCalls: string[];
  rescanBodies: Array<Record<string, any>>;
  secretStoreCalls: Array<{ method: string; path: string }>;
  setupDiagnostic: Record<string, any> | null;
  runtime: {
    linearQueueLastAppliedEventSequence: number;
    linearQueueLastObservedEventSequence: number;
  };
  scanCount: number;
  scheduled: CompanionLinearQueueScheduledReadback[];
  statusLines: string[];
  unexpectedDisableAfterConfigure: number;
}

export interface CompanionLinearQueueHarness {
  page: Page;
  marker: string;
  notePath: string;
  runDueScan(
    mode: "complete" | "blocked",
  ): Promise<CompanionLinearQueueScheduledReadback>;
  requestReconciliation(): Promise<void>;
  readSnapshot(): Promise<CompanionLinearQueueSnapshot>;
  close(): Promise<void>;
}

/**
 * Native core + companion fixture for restart-owned Linear queue polling.
 * The shared native harness snapshots/restores every requested plugin data.json;
 * this fixture only supplies a loopback fake service and a fixed read provider.
 */
export async function startCompanionLinearQueueHarness(): Promise<CompanionLinearQueueHarness> {
  let workItemFingerprint = "";
  const native = await startNativeObsidianHarness({
    label: "companion-linear-queue",
    async setup(context) {
      const workItem = createWorkItemSpecV2({
        schemaVersion: 2,
        ready: true,
        executionClass: "human",
        objective:
          "Review the companion-observed queue candidate without granting mutation authority.",
        acceptanceCriteria: [
          {
            id: "AC-1",
            text: "The candidate is independently read and returned to the foreground supervisor.",
          },
        ],
        validationRequirementKeys: ["linear.readback-only"],
        evidenceRefs: [`research:${context.marker}`],
        riskClass: "low",
        originRunId: `origin-${context.marker.toLowerCase()}`,
        acceptedResearchArtifactFingerprint: `sha256:${"7".repeat(64)}`,
        generation: 0,
      });
      workItemFingerprint = workItem.fingerprint;
      const issueDescription = renderWorkItemSpecV2(workItem, {
        problemImpact:
          "A deterministic companion queue observation must survive foreground reconciliation.",
        proposedWork: [
          "Read the fixed issue snapshot and return only fingerprinted evidence.",
        ],
        scope: ["No Linear issue mutation is authorized by this fixture."],
      });
      await installCompanionLinearQueueFixture(context.page, {
        marker: context.marker,
        notePath: context.notePath,
        issueDescription,
        workItemFingerprint,
      });
    },
    async beforeClose(context) {
      await uninstallCompanionLinearQueueFixture(context.page);
    },
  });

  if (!workItemFingerprint) {
    await native.close();
    throw new Error("The companion Linear queue work item was not installed.");
  }

  return {
    page: native.page,
    marker: native.marker,
    notePath: native.notePath,
    runDueScan: (mode) => runDueScan(native.page, mode),
    requestReconciliation: () => requestReconciliation(native.page),
    readSnapshot: () => readCompanionLinearQueueSnapshot(native.page),
    close: () => native.close(),
  };
}

async function installCompanionLinearQueueFixture(
  page: Page,
  input: {
    issueDescription: string;
    marker: string;
    notePath: string;
    workItemFingerprint: string;
  },
): Promise<void> {
  await page.evaluate(
    async ({
      companionPluginId,
      corePluginId,
      issueDescription,
      marker,
      notePath,
      workItemFingerprint,
    }) => {
      const fixtureWindow = window as typeof window & {
        app?: any;
        __e2eCompanionLinearQueue?: any;
      };
      const app = fixtureWindow.app;
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
          core?.testLinearConnection &&
          core?.authorizeLinearQueueForFourHours &&
          companion?.pairForegroundCompanion &&
          companion?.companionCoordinator
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (
        core?.agenticResearcherApi?.state !== "ready" ||
        !companion?.companionCoordinator
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
        `# Companion Linear queue polling\n\n${marker}\n`,
      );
      const noteLeaf =
        (app.workspace.getLeavesOfType?.("markdown") ?? [])[0] ??
        (app.workspace.getLeavesOfType?.("empty") ?? [])[0] ??
        app.workspace.getLeaf("tab");
      await noteLeaf.openFile(note);
      app.workspace.setActiveLeaf(noteLeaf, { focus: true });

      const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
      const canonicalJson = (value: any): string => {
        if (
          value === null ||
          typeof value === "string" ||
          typeof value === "boolean"
        ) {
          return JSON.stringify(value);
        }
        if (typeof value === "number") {
          if (!Number.isFinite(value)) {
            throw new Error("Non-finite canonical number.");
          }
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
      const pageResult = (items: any[]) => ({
        items: clone(items),
        pageInfo: { hasNextPage: false },
        fetchedAt: new Date().toISOString(),
      });
      const originalFetch = window.fetch.bind(window);
      const baseUrl = "http://127.0.0.1:18791";
      const credentialReferenceId = "credential_linearqueuee2e";
      const credentialBackend = "e2e-keyring";
      const createdAt = new Date(Date.now() - 60_000).toISOString();
      const fixedIssue = {
        resourceType: "issue",
        id: "issue-companion-linear-queue-e2e",
        identifier: "E2E-QUEUE-71",
        url: "https://linear.app/e2e/issue/E2E-QUEUE-71",
        title: "Companion-owned queue polling proof",
        description: issueDescription,
        priority: 0,
        trashed: false,
        labels: [],
        team: { id: "e2e-team", name: "E2E Team", key: "E2E" },
        state: { id: "e2e-backlog", name: "Backlog", type: "unstarted" },
        project: { id: "e2e-project", name: "E2E Agent Queue" },
        createdAt,
        updatedAt: new Date(Date.now() - 30_000).toISOString(),
        snapshotHash: `sha256:${"1".repeat(64)}`,
      };
      const state: any = {
        acknowledgedThrough: [],
        authorization: null,
        companionProviderReadCount: 0,
        configuration: null,
        configurationDriftCount: 0,
        configureBodies: [],
        eventReplayAfter: [],
        events: [],
        foregroundRestartCount: 0,
        jobGetCounts: {},
        jobs: {},
        linearCalls: [],
        marker,
        mutationCalls: [],
        originalAcknowledge: null,
        originalFetch,
        originalRestart: null,
        receipts: {},
        requestLog: [],
        rescanBodies: [],
        scanCount: 0,
        secretStoreCalls: [],
        setupDiagnostic: null,
        scheduled: [],
        trackForegroundRestarts: false,
        unexpectedDisableAfterConfigure: 0,
      };

      const fakeLinearClient = {
        async execute(
          operationKey: string,
          variables: Record<string, unknown> = {},
        ) {
          state.linearCalls.push({ operationKey, variables: clone(variables) });
          switch (operationKey) {
            case "connection.context":
              return {
                viewer: { id: "e2e-viewer", name: "E2E Queue Agent" },
                workspace: { id: "e2e-workspace", name: "E2E Workspace" },
                fetchedAt: new Date().toISOString(),
              };
            case "teams.list":
              return pageResult([
                {
                  resourceType: "team",
                  id: "e2e-team",
                  name: "E2E Team",
                  key: "E2E",
                  snapshotHash: `sha256:${"2".repeat(64)}`,
                },
              ]);
            case "projects.list":
              return pageResult([
                {
                  resourceType: "project",
                  id: "e2e-project",
                  name: "E2E Agent Queue",
                  url: "https://linear.app/e2e/project/agent-queue",
                  attributes: { teams: ["e2e-team"] },
                  snapshotHash: `sha256:${"3".repeat(64)}`,
                },
              ]);
            case "workflow_states.list":
              return pageResult([
                {
                  resourceType: "workflow_state",
                  id: "e2e-backlog",
                  name: "Backlog",
                  type: "unstarted",
                  attributes: { team: "e2e-team" },
                  snapshotHash: `sha256:${"4".repeat(64)}`,
                },
                {
                  resourceType: "workflow_state",
                  id: "e2e-started",
                  name: "In Progress",
                  type: "started",
                  attributes: { team: "e2e-team" },
                  snapshotHash: `sha256:${"5".repeat(64)}`,
                },
                {
                  resourceType: "workflow_state",
                  id: "e2e-completed",
                  name: "Done",
                  type: "completed",
                  attributes: { team: "e2e-team" },
                  snapshotHash: `sha256:${"6".repeat(64)}`,
                },
                {
                  resourceType: "workflow_state",
                  id: "e2e-blocked",
                  name: "Blocked",
                  type: "canceled",
                  attributes: { team: "e2e-team" },
                  snapshotHash: `sha256:${"8".repeat(64)}`,
                },
              ]);
            case "issues.list":
              return pageResult([fixedIssue]);
            case "issues.get":
              if (String(variables.id ?? "") !== fixedIssue.id) {
                throw new Error("The fixed Linear provider received another issue id.");
              }
              return clone(fixedIssue);
            default:
              if (/\.(?:create|update|delete|archive)$/u.test(operationKey)) {
                state.mutationCalls.push(operationKey);
                throw new Error(
                  `The read-only companion queue fixture rejected ${operationKey}.`,
                );
              }
              throw new Error(`Unexpected fixed Linear operation: ${operationKey}`);
          }
        },
      };

      const queueStatus = () => {
        const configuration = state.configuration;
        const candidateEvents = state.events.filter(
          (event: any) => event.type === "linear_queue_candidate_scheduled",
        );
        const latestScan = state.scheduled.at(-1) ?? null;
        return {
          enabled: Boolean(configuration),
          configurationFingerprint:
            configuration?.configurationFingerprint ?? null,
          queueProjectId: configuration?.queueProjectId ?? null,
          authorityExpiresAt: configuration?.authority?.expiresAt ?? null,
          cursor: latestScan
            ? {
                updatedAt: latestScan.remoteUpdatedAt,
                issueId: latestScan.issueId,
              }
            : null,
          nextScanAt: configuration
            ? new Date(Date.now() + 15 * 60_000).toISOString()
            : null,
          lastScanStartedAt: latestScan?.scanStartedAt ?? null,
          lastScanCompletedAt: latestScan?.scanCompletedAt ?? null,
          lastErrorCode: null,
          candidateCount: candidateEvents.length,
          scheduledReadbackCount: candidateEvents.length,
          latestEventSequence: state.events.at(-1)?.sequence ?? 0,
        };
      };
      const jsonResponse = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          // SecretStoreV1 fails closed unless authenticated secret metadata
          // responses explicitly prohibit caching. Applying no-store to every
          // fake companion response keeps the fixture stricter and simpler.
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
          },
        });
      const requestUrl = (request: RequestInfo | URL) =>
        request instanceof Request ? request.url : String(request);
      const requestMethod = (
        request: RequestInfo | URL,
        init?: RequestInit,
      ) =>
        String(
          init?.method ?? (request instanceof Request ? request.method : "GET"),
        ).toUpperCase();
      const parseBody = (init?: RequestInit) =>
        init?.body ? JSON.parse(String(init.body)) : {};

      const companionFetch = async (
        request: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const rawUrl = requestUrl(request);
        if (!rawUrl.startsWith(baseUrl)) {
          return originalFetch(request, init);
        }
        const url = new URL(rawUrl);
        const method = requestMethod(request, init);
        const requestRecord = {
          method,
          path: `${url.pathname}${url.search}`,
        };
        state.requestLog.push(requestRecord);
        if (url.pathname === "/status" || url.pathname.startsWith("/secrets/")) {
          state.secretStoreCalls.push(requestRecord);
        }
        if (url.pathname === "/health" && method === "GET") {
          return jsonResponse({
            ok: true,
            service: "agentic-researcher-companion-e2e",
            browserReady: false,
            memoryReady: false,
            coordinatorReady: true,
            workerReady: true,
            workerDiagnostic: null,
            installedExecutorDomains: ["linear"],
            executorCatalogVersion: 1,
            secureStorePersistent: true,
            backgroundEnabled: true,
            backgroundBlocker: null,
            version: "companion-linear-queue-e2e",
          });
        }
        if (url.pathname === "/status" && method === "GET") {
          return jsonResponse({
            ok: true,
            coordinatorId: "companion-linear-queue-e2e-worker",
            queuedJobs: 0,
            leasedJobs: 0,
            eventCount: state.events.length,
            receiptCount: Object.values(state.receipts).flat().length,
            secureStorePersistent: true,
            secureStoreBackend: credentialBackend,
            backgroundRequested: true,
            backgroundEnabled: true,
            backgroundBlocker: null,
            workerReady: true,
            workerDiagnostic: null,
            installedExecutorDomains: ["linear"],
            executorCatalogVersion: 1,
          });
        }
        if (
          url.pathname === `/secrets/${credentialReferenceId}` &&
          method === "GET"
        ) {
          return jsonResponse({
            version: 1,
            referenceId: credentialReferenceId,
            label: "E2E Linear queue credential",
            metadata: { provider: "linear" },
            backend: credentialBackend,
            persistent: true,
            createdAt,
            updatedAt: createdAt,
          });
        }
        if (url.pathname === "/linear-queue/configuration" && method === "PUT") {
          const configuration = parseBody(init);
          state.configureBodies.push(clone(configuration));
          if (
            state.configuration &&
            canonicalJson(state.configuration) !== canonicalJson(configuration)
          ) {
            state.configurationDriftCount += 1;
            return jsonResponse({ detail: "configuration drift" }, 409);
          }
          state.configuration = clone(configuration);
          return jsonResponse(queueStatus());
        }
        if (
          url.pathname === "/linear-queue/configuration" &&
          method === "DELETE"
        ) {
          if (state.configuration) {
            state.unexpectedDisableAfterConfigure += 1;
          }
          state.configuration = null;
          return jsonResponse(queueStatus());
        }
        if (url.pathname === "/linear-queue/status" && method === "GET") {
          return jsonResponse(queueStatus());
        }
        if (url.pathname === "/linear-queue/events" && method === "GET") {
          const after = Number(url.searchParams.get("after") ?? 0);
          state.eventReplayAfter.push(after);
          return jsonResponse({
            events: state.events.filter(
              (event: any) => event.sequence > after,
            ),
          });
        }
        if (url.pathname === "/linear-queue/rescan" && method === "POST") {
          const body = parseBody(init);
          state.rescanBodies.push(clone(body));
          if (
            body.configurationFingerprint !==
            state.configuration?.configurationFingerprint
          ) {
            return jsonResponse({ detail: "configuration drift" }, 409);
          }
          state.events.push({
            sequence: state.events.length + 1,
            type: "linear_queue_rescan_requested",
            payload: {
              configurationFingerprint: body.configurationFingerprint,
              reason: body.reason,
            },
            createdAt: new Date().toISOString(),
          });
          return jsonResponse(queueStatus());
        }
        const segments = url.pathname.split("/").filter(Boolean);
        if (segments[0] === "jobs" && segments.length >= 2) {
          const jobId = decodeURIComponent(segments[1]);
          const job = state.jobs[jobId];
          if (!job) return jsonResponse({ detail: "not found" }, 404);
          if (segments.length === 2 && method === "GET") {
            state.jobGetCounts[jobId] =
              Number(state.jobGetCounts[jobId] ?? 0) + 1;
            return jsonResponse(job);
          }
          if (
            segments.length === 3 &&
            segments[2] === "receipts" &&
            method === "GET"
          ) {
            return jsonResponse({ receipts: state.receipts[jobId] ?? [] });
          }
        }
        return jsonResponse({ detail: "unsupported companion fixture request" }, 404);
      };

      state.runDueScan = async (mode: "complete" | "blocked") => {
        const configuration = state.configuration;
        if (!configuration) {
          throw new Error("The exact companion queue configuration is missing.");
        }
        if (Date.parse(configuration.authority.expiresAt) <= Date.now()) {
          throw new Error("The exact companion queue authority expired.");
        }
        state.scanCount += 1;
        state.companionProviderReadCount += 1;
        const scanStartedAt = new Date().toISOString();
        const remoteUpdatedAt = new Date(
          Date.parse(fixedIssue.updatedAt) + state.scanCount * 1_000,
        ).toISOString();
        const remoteStateId =
          mode === "complete" ? fixedIssue.state.id : "e2e-blocked";
        const readbackFingerprint = await sha256({
          version: 1,
          issueId: fixedIssue.id,
          projectId: configuration.queueProjectId,
          stateId: remoteStateId,
          updatedAt: remoteUpdatedAt,
          workItemFingerprint,
        });
        const observation = {
          issueId: fixedIssue.id,
          identifier: fixedIssue.identifier,
          queueProjectId: configuration.queueProjectId,
          remoteStateId,
          remoteUpdatedAt,
          workItemFingerprint,
          readbackFingerprint,
        };
        const candidateFingerprint = await sha256(observation);
        const configurationSuffix = configuration.configurationFingerprint
          .slice("sha256:".length, "sha256:".length + 32);
        const candidateSuffix = candidateFingerprint.slice(
          "sha256:".length,
          "sha256:".length + 32,
        );
        const missionId = `linear-queue-${configurationSuffix}`;
        const nodeId = `linear-candidate-${candidateSuffix}`;
        const capabilityFingerprint = await sha256({
          version: 1,
          kind: "linear_queue_candidate_readback",
          configurationFingerprint: configuration.configurationFingerprint,
          queueBindingFingerprint: configuration.queueBindingFingerprint,
          candidateFingerprint,
          authorityFingerprint: configuration.authority.fingerprint,
        });
        const idempotencyKey = await sha256({
          version: 1,
          missionId,
          nodeId,
          graphRevision: 0,
          capabilityEnvelopeFingerprint: capabilityFingerprint,
          authorizationFingerprint: configuration.authority.fingerprint,
        });
        const jobId = `companion-${idempotencyKey.slice(
          "sha256:".length,
          "sha256:".length + 32,
        )}`;
        const now = new Date().toISOString();
        const job: any = {
          id: jobId,
          missionId,
          nodeId,
          executionHost: "linear",
          state: mode,
          payload: {
            version: 1,
            graphRevision: 0,
            executionHost: "headless_runtime",
            objective:
              "Read back one fingerprinted issue from the configured trusted Linear queue.",
            inputs: {
              issueId: fixedIssue.id,
              credentialReferenceId: configuration.credentialReferenceId,
              projectBindingId: configuration.queueProjectId,
              contractFingerprint: workItemFingerprint,
              queueCandidateFingerprint: candidateFingerprint,
            },
            allowedTools: ["linear_get_issue"],
            requiredCapabilities: ["linear.issue.read"],
            bindings: [
              {
                id: configuration.queueProjectId,
                kind: "linear-project",
                destinationFingerprint: configuration.queueBindingFingerprint,
              },
            ],
            authorization: clone(configuration.authority),
            preparedExternalActionHandoff: null,
            createdAt: now,
            updatedAt: now,
          },
          capabilityEnvelope: {
            fingerprint: capabilityFingerprint,
            authorizationFingerprint: configuration.authority.fingerprint,
          },
          idempotencyKey,
          ownerCoordinatorId: "companion-linear-queue-e2e-worker",
          leaseExpiresAt: null,
          attempts: 1,
          createdAt: now,
          updatedAt: now,
        };
        const jobFingerprintIdentity = {
          id: job.id,
          missionId: job.missionId,
          nodeId: job.nodeId,
          idempotencyKey: job.idempotencyKey,
          capabilityEnvelopeFingerprint: capabilityFingerprint,
          authorizationFingerprint: configuration.authority.fingerprint,
        };
        if (mode === "complete") {
          const receiptPayload = {
            issueId: fixedIssue.id,
            identifier: fixedIssue.identifier,
            updatedAt: remoteUpdatedAt,
            readbackFingerprint,
            candidateFingerprint,
            workItemFingerprint,
          };
          const receipt = {
            id: `receipt-linear-${candidateSuffix}`,
            jobId,
            provider: "linear",
            operation: "linear_issue_readback",
            status: "verified",
            fingerprint: await sha256({
              version: 1,
              job: jobFingerprintIdentity,
              provider: "linear",
              operation: "linear_issue_readback",
              status: "verified",
              payload: receiptPayload,
            }),
            payload: receiptPayload,
            createdAt: now,
          };
          const completion = {
            status: "complete",
            outputs: {
              issueId: fixedIssue.id,
              state: remoteStateId,
              candidateFingerprint,
              workItemFingerprint,
              readbackFingerprint,
            },
            evidence: [
              {
                kind: "linear_issue_readback",
                issueId: fixedIssue.id,
                readbackFingerprint,
              },
            ],
            receiptIds: [receipt.id],
            blocker: null,
          };
          job.output = {
            ...completion,
            resultFingerprint: await sha256({
              version: 1,
              job: jobFingerprintIdentity,
              result: completion,
            }),
          };
          state.receipts[jobId] = [receipt];
        } else {
          const completion = {
            status: "blocked",
            outputs: {},
            evidence: [],
            receiptIds: [],
            blocker: {
              code: "linear_queue_candidate_changed",
              message:
                "The fixed issue changed before independent readback completed.",
              requiredAction: "Request a fresh read-only queue scan.",
            },
          };
          job.output = {
            ...completion,
            resultFingerprint: await sha256({
              version: 1,
              job: jobFingerprintIdentity,
              result: completion,
            }),
          };
          state.receipts[jobId] = [];
        }
        state.jobs[jobId] = job;
        const event = {
          sequence: state.events.length + 1,
          type: "linear_queue_candidate_scheduled",
          payload: {
            configurationFingerprint: configuration.configurationFingerprint,
            queueProjectId: configuration.queueProjectId,
            issueId: fixedIssue.id,
            identifier: fixedIssue.identifier,
            candidateFingerprint,
            workItemFingerprint,
            readbackFingerprint,
            jobId,
          },
          createdAt: now,
        };
        state.events.push(event);
        const scheduled = {
          mode,
          eventSequence: event.sequence,
          issueId: fixedIssue.id,
          jobId,
          candidateFingerprint,
          workItemFingerprint,
          readbackFingerprint,
          remoteUpdatedAt,
          scanStartedAt,
          scanCompletedAt: new Date().toISOString(),
        };
        state.scheduled.push(scheduled);
        return clone(scheduled);
      };

      fixtureWindow.__e2eCompanionLinearQueue = state;
      window.fetch = companionFetch;

      const isolatedRuntime = {
        version: 1,
        serviceInstalled: false,
        baseUrl,
        linearQueueLastObservedEventSequence: 0,
        linearQueueLastAppliedEventSequence: 0,
        jobs: {},
      };
      const companionData = (await companion.loadData()) ?? {};
      await companion.saveData({
        ...companionData,
        companionRuntimeState: isolatedRuntime,
      });
      await companion.companionCoordinator.hydratePersistence();

      state.originalAcknowledge =
        companion.companionCoordinator.acknowledgeAppliedLinearQueueEvents.bind(
          companion.companionCoordinator,
        );
      companion.companionCoordinator.acknowledgeAppliedLinearQueueEvents = async (
        throughSequence: number,
      ) => {
        state.acknowledgedThrough.push(throughSequence);
        return state.originalAcknowledge(throughSequence);
      };

      core.linearApiKey = "e2e-linear-queue-session-credential";
      core.persistLegacyLinearApiKey = true;
      core.linearCredentialReference = {
        version: 1,
        referenceId: credentialReferenceId,
        label: "E2E Linear queue credential",
        metadata: { provider: "linear" },
        backend: credentialBackend,
        persistent: true,
        createdAt,
        updatedAt: createdAt,
      };
      core.createSecretBackedLinearClient = () => fakeLinearClient;
      core.settings.companionBaseUrl = baseUrl;
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

      state.originalRestart = core.restartLinearQueueRuntime.bind(core);
      core.restartLinearQueueRuntime = async (scanImmediately: boolean) => {
        if (state.trackForegroundRestarts) {
          state.foregroundRestartCount += 1;
        }
        return state.originalRestart(scanImmediately);
      };

      await companion.pairForegroundCompanion({
        baseUrl,
        acquireBootstrapToken: async () =>
          "companion-linear-queue-bootstrap-token-0123456789abcdef",
        fetchImpl: companionFetch,
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (!core.companionReconcileInFlight) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const connection = await core.testLinearConnection();
      if (!connection?.ok) {
        throw new Error(`Fixed Linear discovery failed: ${connection?.message}`);
      }
      core.settings.linearQueueEnabled = true;
      await core.savePluginData?.();
      const authorization = await core.authorizeLinearQueueForFourHours();
      state.authorization = clone(authorization);
      if (!authorization?.ok) {
        throw new Error(`Queue authorization failed: ${authorization?.message}`);
      }
      await core.linearQueueRuntimeTail;
      await new Promise((resolve) => setTimeout(resolve, 800));
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (!core.companionReconcileInFlight) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await core.stopLinearQueueRuntime();
      await core.linearQueueRuntimeTail;
      const readSetupDiagnostic = async () => {
        const grants = (core.authorityGrantStore?.snapshot()?.grants ?? []).map(
          (grant: any) => ({
            authorityFingerprint: grant.authorityFingerprint,
            expiresAt: grant.expiresAt,
            id: grant.id,
            issuedAt: grant.issuedAt,
            state: grant.state,
            subject: grant.subject,
          }),
        );
        const diagnostic: any = {
          authorization: clone(state.authorization),
          companion: clone(companion.companionCoordinator.snapshot()),
          companionConfigurationPresent: Boolean(state.configuration),
          coreConfigurationStatus: clone(
            core.getLinearQueueConfigurationStatus?.() ?? null,
          ),
          currentBinding: {
            credentialReferenceId:
              core.linearOAuthRuntimeState?.credential?.accessTokenReferenceId ??
              core.linearCredentialReference?.referenceId ??
              null,
            integrationWorkspaceId:
              core.linearIntegrationState?.workspaceId ?? null,
            queueProjectId: core.settings.linearQueueProjectId ?? null,
            queueWorkspaceId: core.linearQueueState?.workspaceId ?? null,
            teamId: core.settings.linearDefaultTeamId ?? null,
          },
          grants,
          requestLog: clone(state.requestLog),
          secretStoreCalls: clone(state.secretStoreCalls),
          secretStoreProbe: null,
        };
        if (!state.configuration) {
          try {
            const store = core.createCompanionSecretStore();
            const health = await store.health();
            const referenceId =
              core.linearOAuthRuntimeState?.credential?.accessTokenReferenceId ??
              core.linearCredentialReference?.referenceId ??
              null;
            diagnostic.secretStoreProbe = {
              health: clone(health),
              description: referenceId
                ? clone(await store.describe(referenceId))
                : null,
              error: null,
            };
          } catch (error) {
            diagnostic.secretStoreProbe = {
              health: null,
              description: null,
              error: String(
                error instanceof Error
                  ? error.message
                  : "Secret-store probe failed.",
              )
                .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
                .replace(
                  /(token|secret|password)\s*[=:]\s*[^\s,;}]+/giu,
                  "$1=[REDACTED]",
                )
                .slice(0, 1_000),
            };
          }
        }
        return diagnostic;
      };
      state.setupDiagnostic = await readSetupDiagnostic();
      if (!state.configuration) {
        throw new Error(
          `The authorized core did not configure companion-owned queue polling. setup_diagnostic=${JSON.stringify(state.setupDiagnostic)}`,
        );
      }
      state.linearCalls = [];
      state.foregroundRestartCount = 0;
      state.trackForegroundRestarts = true;

      await core.activateView?.();
    },
    {
      companionPluginId: COMPANION_PLUGIN_ID,
      corePluginId: NATIVE_CORE_PLUGIN_ID,
      issueDescription: input.issueDescription,
      marker: input.marker,
      notePath: input.notePath,
      workItemFingerprint: input.workItemFingerprint,
    },
  );
}

async function runDueScan(
  page: Page,
  mode: "complete" | "blocked",
): Promise<CompanionLinearQueueScheduledReadback> {
  return page.evaluate(
    async ({ mode: requestedMode, reconcileEvent }) => {
      const fixtureWindow = window as typeof window & {
        app?: any;
        __e2eCompanionLinearQueue?: any;
      };
      const state = fixtureWindow.__e2eCompanionLinearQueue;
      if (!state?.runDueScan) {
        throw new Error("The companion Linear queue fixture is unavailable.");
      }
      const scheduled = await state.runDueScan(requestedMode);
      fixtureWindow.app?.workspace?.trigger(reconcileEvent);
      return scheduled;
    },
    { mode, reconcileEvent: COMPANION_RECONCILE_EVENT },
  );
}

async function requestReconciliation(page: Page): Promise<void> {
  await page.evaluate(
    async ({ corePluginId, reconcileEvent }) => {
      const fixtureWindow = window as typeof window & { app?: any };
      const core = fixtureWindow.app?.plugins?.plugins?.[corePluginId];
      fixtureWindow.app?.workspace?.trigger(reconcileEvent);
      await new Promise((resolve) => setTimeout(resolve, 25));
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (!core?.companionReconcileInFlight && !core?.companionReconcileTimer) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Companion reconciliation did not become idle.");
    },
    {
      corePluginId: NATIVE_CORE_PLUGIN_ID,
      reconcileEvent: COMPANION_RECONCILE_EVENT,
    },
  );
}

async function readCompanionLinearQueueSnapshot(
  page: Page,
): Promise<CompanionLinearQueueSnapshot> {
  return page.evaluate(
    ({ companionPluginId, corePluginId }) => {
      const fixtureWindow = window as typeof window & {
        app?: any;
        __e2eCompanionLinearQueue?: any;
      };
      const state = fixtureWindow.__e2eCompanionLinearQueue;
      const core = fixtureWindow.app?.plugins?.plugins?.[corePluginId];
      const companion =
        fixtureWindow.app?.plugins?.plugins?.[companionPluginId];
      if (!state || !core || !companion?.companionCoordinator) {
        throw new Error("The companion Linear queue snapshot is unavailable.");
      }
      const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
      const configuration = state.configuration;
      const activeGrant = configuration
        ? core.authorityGrantStore
            ?.snapshot()
            .grants.find(
              (grant: any) =>
                grant.state === "active" &&
                grant.subject?.type === "schedule" &&
                grant.subject?.id === configuration.authoritySubjectId,
            ) ?? null
        : null;
      const runtime = companion.companionCoordinator.getRuntimeState();
      const foregroundListCount = state.linearCalls.filter(
        (call: any) => call.operationKey === "issues.list",
      ).length;
      const foregroundReadCount = state.linearCalls.filter(
        (call: any) => call.operationKey === "issues.get",
      ).length;
      return clone({
        acknowledgedThrough: state.acknowledgedThrough,
        activeGrant,
        authorization: state.authorization,
        companionProviderReadCount: state.companionProviderReadCount,
        configuration,
        configurationDriftCount: state.configurationDriftCount,
        configureBodies: state.configureBodies,
        eventReplayAfter: state.eventReplayAfter,
        events: state.events,
        foregroundListCount,
        foregroundReadCount,
        foregroundRestartCount: state.foregroundRestartCount,
        foregroundSupervisorRunning: Boolean(
          core.linearQueueSupervisor?.isRunning,
        ),
        jobGetCounts: state.jobGetCounts,
        linearCalls: state.linearCalls,
        mutationCalls: state.mutationCalls,
        rescanBodies: state.rescanBodies,
        secretStoreCalls: state.secretStoreCalls,
        setupDiagnostic: state.setupDiagnostic,
        runtime: {
          linearQueueLastAppliedEventSequence:
            runtime.linearQueueLastAppliedEventSequence,
          linearQueueLastObservedEventSequence:
            runtime.linearQueueLastObservedEventSequence,
        },
        scanCount: state.scanCount,
        scheduled: state.scheduled,
        statusLines: core.getExtensionStatusLines(),
        unexpectedDisableAfterConfigure:
          state.unexpectedDisableAfterConfigure,
      });
    },
    {
      companionPluginId: COMPANION_PLUGIN_ID,
      corePluginId: NATIVE_CORE_PLUGIN_ID,
    },
  );
}

async function uninstallCompanionLinearQueueFixture(page: Page): Promise<void> {
  if (page.isClosed()) return;
  await page.evaluate(
    async ({ companionPluginId, corePluginId }) => {
      const fixtureWindow = window as typeof window & {
        app?: any;
        __e2eCompanionLinearQueue?: any;
      };
      const state = fixtureWindow.__e2eCompanionLinearQueue;
      const core = fixtureWindow.app?.plugins?.plugins?.[corePluginId];
      const companion =
        fixtureWindow.app?.plugins?.plugins?.[companionPluginId];
      await core?.stopLinearQueueRuntime?.().catch(() => undefined);
      if (core && state?.originalRestart) {
        core.restartLinearQueueRuntime = state.originalRestart;
      }
      if (companion?.companionCoordinator && state?.originalAcknowledge) {
        companion.companionCoordinator.acknowledgeAppliedLinearQueueEvents =
          state.originalAcknowledge;
      }
      companion?.companionCoordinator?.clearSession?.();
      if (state?.originalFetch) window.fetch = state.originalFetch;
      delete fixtureWindow.__e2eCompanionLinearQueue;
    },
    {
      companionPluginId: COMPANION_PLUGIN_ID,
      corePluginId: NATIVE_CORE_PLUGIN_ID,
    },
  );
}
