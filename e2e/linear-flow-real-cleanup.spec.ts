import { writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { laneSelectedV1 } from "./fixtures/laneSelection";
import {
  NATIVE_CORE_PLUGIN_ID,
  startNativeObsidianHarness,
  type NativeObsidianHarness,
} from "./fixtures/nativeObsidianHarness";

const LANE = "linear-flow-real-cleanup";

/**
 * Delete the historical `Flow real` issues left behind by past
 * `compound-flow-real-live` runs, through the product's own Linear tools.
 *
 * Two deliberate properties:
 *
 * 1. **List-only by default.** Without `FLOW_REAL_CLEANUP_APPLY=1` this
 *    reports what it would delete and changes nothing, so a human sees the
 *    exact set before anything is destroyed.
 * 2. **Pattern-anchored.** `compound-flow-real-live.spec.ts` titles its issues
 *    `Flow real FLOW_REAL_<hex>`; only that exact shape is eligible. Anything
 *    else mentioning "Flow real" is reported and left alone.
 *
 * It runs through the app rather than a side script because the Linear
 * credential lives in Obsidian SecretStorage — and because exercising the real
 * delete path is worth more than reaching around it.
 */
/**
 * Anchored at the start and requiring the machine-generated hex marker, so a
 * hand-written title cannot match. The optional trailing text covers the
 * variants the lane produces ("… — pipeline marker", "… — accepted research"),
 * which a strict end-anchor excluded and left behind as residue.
 */
const FLOW_REAL_TITLE = /^Flow real FLOW_REAL_[0-9a-f]+(?:\s|$)/u;
const APPLY = process.env.FLOW_REAL_CLEANUP_APPLY === "1";
const PERMANENT =
  process.env.LINEAR_EXACT_CLEANUP_PERMANENT === "1";
const EXACT_ISSUE_ID =
  process.env.LINEAR_EXACT_CLEANUP_ISSUE_ID?.trim() ?? "";
const EXACT_MARKER =
  process.env.LINEAR_EXACT_CLEANUP_MARKER?.trim() ?? "";
if (Boolean(EXACT_ISSUE_ID) !== Boolean(EXACT_MARKER)) {
  throw new Error(
    "Exact Linear cleanup requires both LINEAR_EXACT_CLEANUP_ISSUE_ID and LINEAR_EXACT_CLEANUP_MARKER.",
  );
}
if (
  EXACT_ISSUE_ID &&
  (!(
    /^[A-Za-z0-9-]{8,200}$/u.test(EXACT_ISSUE_ID) ||
    /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$/u.test(EXACT_ISSUE_ID)
  ) ||
    !/^BYOK_AUTONOMOUS_[a-f0-9]{12}$/u.test(EXACT_MARKER))
) {
  throw new Error("Exact Linear cleanup scope is malformed.");
}
if (PERMANENT && !EXACT_ISSUE_ID) {
  throw new Error(
    "Permanent Linear cleanup is allowed only with an exact issue ID and marker.",
  );
}

test("FLOW-REAL-CLEANUP lists and optionally trashes historical Flow real issues", async (
  {},
  testInfo,
) => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");
  test.skip(!laneSelectedV1(LANE), `Run only with E2E_PLAYWRIGHT_LANE=${LANE}.`);
  test.setTimeout(15 * 60_000);

  let harness: NativeObsidianHarness | null = null;
  try {
    harness = await startNativeObsidianHarness({
      label: "linear-flow-real-cleanup",
      preserveConfiguredLinearCredential: true,
      setup: async ({ page }) => {
        await page.evaluate(async (pluginId) => {
          const app = (window as typeof window & { app?: any }).app;
          if (typeof app?.workspace?.onLayoutReady === "function") {
            await new Promise<void>((resolve) => app.workspace.onLayoutReady(resolve));
          }
          if (!app.plugins.plugins?.[pluginId]) {
            await app.plugins.enablePlugin(pluginId);
          }
        }, NATIVE_CORE_PLUGIN_ID);
        await page.waitForFunction(
          (pluginId) =>
            (window as typeof window & { app?: any }).app?.plugins?.plugins?.[
              pluginId
            ]?.agenticResearcherApi?.state === "ready",
          NATIVE_CORE_PLUGIN_ID,
          { timeout: 30_000 },
        );
      },
    });

    const outcome = await harness.page.evaluate(
      async ({
        pluginId,
        apply,
        permanent,
        titlePattern,
        exactIssueId,
        exactMarker,
      }) => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.[pluginId];
        if (!plugin) throw new Error("Agentic Researcher is unavailable.");

        const connection = await plugin.testLinearConnection();
        if (!connection?.ok) {
          throw new Error(
            `Linear is not connected: ${String(connection?.message ?? "no message").slice(0, 300)}`,
          );
        }
        const snapshot = plugin.getLinearCapabilitySnapshot?.();
        const teamId =
          plugin.settings?.linearDefaultTeamId || snapshot?.teams?.[0]?.id;
        if (!teamId) throw new Error("Linear discovery provided no usable team.");

        const registry = plugin.createToolRegistry?.();
        const client = plugin.createSecretBackedLinearClient?.();
        if (!registry?.prepare || !registry?.executePrepared || !client) {
          throw new Error("The production prepared-action registry is unavailable.");
        }
        const context = plugin.createToolExecutionContext(
          "Clean up historical Flow real e2e issues.",
        );
        const runId = `flow-real-cleanup-${Date.now()}`;
        let sequence = 0;

        // issues.list takes first/after/includeArchived/filter — the team is
        // expressed through the IssueFilter, not as a bare argument.
        const collected: any[] = [];
        let after: string | null = null;
        for (let page = 0; page < 10; page += 1) {
          const listed: any = await registry.execute(
            {
              id: `${runId}-list-${(sequence += 1)}`,
              name: "linear_list_issues",
              arguments: {
                first: 50,
                includeArchived: false,
                filter: { team: { id: { eq: teamId } } },
                ...(after ? { after } : {}),
              },
            },
            context,
          );
          if (!listed?.ok) {
            throw new Error(
              `linear_list_issues failed: ${String(listed?.error?.message ?? "unknown").slice(0, 300)}`,
            );
          }
          // LinearPage is { items, pageInfo } — reading `nodes` here silently
          // reported zero issues, which is indistinguishable from "the team is
          // empty" and would have made a broken query look like a clean team.
          const output: any = listed.output ?? {};
          const pageItems: any[] = Array.isArray(output.items)
            ? output.items
            : Array.isArray(output.nodes)
              ? output.nodes
              : [];
          if (!Array.isArray(output.items) && !Array.isArray(output.nodes)) {
            throw new Error(
              `Unexpected linear_list_issues result shape: ${Object.keys(output).join(",") || "empty"}`,
            );
          }
          collected.push(...pageItems);
          const nextCursor: string =
            output.pageInfo?.hasNextPage === true
              ? String(output.pageInfo?.endCursor ?? "")
              : "";
          if (!nextCursor) break;
          after = nextCursor;
        }
        const nodes = collected;

        const pattern = new RegExp(titlePattern, "u");
        const eligible: any[] = [];
        const alreadyClean: any[] = [];
        const nearMiss: any[] = [];
        const projectIssue = (node: any) => {
          const title = String(node?.title ?? "");
          const record = {
            id: String(node?.id ?? ""),
            identifier: String(node?.identifier ?? ""),
            title,
            url: String(node?.url ?? ""),
          };
          return {
            record,
            owned:
              (record.id === exactIssueId ||
                record.identifier === exactIssueId) &&
              String(node?.team?.id ?? "") === teamId &&
              `${title}\n${String(node?.description ?? "")}`.includes(exactMarker),
            trashed:
              node?.trashed === true || node?.attributes?.trashed === true,
          };
        };
        if (exactIssueId) {
          try {
            const exact: any = await client.execute("issues.get", {
              id: exactIssueId,
            });
            const projected = projectIssue(exact);
            if (!projected.owned) {
              throw new Error(
                "The exact provider issue failed its ID, marker, or team ownership check.",
              );
            }
            if (projected.trashed) {
              if (permanent) {
                eligible.push(projected.record);
              } else {
                alreadyClean.push(projected.record);
              }
            } else {
              eligible.push(projected.record);
            }
          } catch (error) {
            if (String((error as any)?.code ?? "") === "linear_not_found") {
              alreadyClean.push({
                id: exactIssueId,
                identifier: "",
                title: exactMarker,
                url: "",
              });
            } else {
              throw error;
            }
          }
        } else {
          for (const node of nodes) {
            const { record } = projectIssue(node);
            const title = record.title;
            if (pattern.test(title)) eligible.push(record);
            else if (/flow\s*real/iu.test(title)) nearMiss.push(record);
          }
        }

        const trashed: any[] = [];
        const permanentlyDeleted: any[] = [];
        const verifiedAbsent: any[] = [];
        const failures: any[] = [];
        if (apply) {
          for (const issue of eligible) {
            try {
              // prepare() returns a result wrapper, not the action, and the
              // mutation needs an authority grant bound to the prepared
              // payload fingerprint. Passing the wrapper straight to
              // executePrepared reports "Unknown tool: undefined" and changes
              // nothing — a safe failure, but a failure.
              const executeExactMutation = async (
                toolName:
                  | "linear_trash_issue"
                  | "linear_delete_issue_permanently",
              ): Promise<void> => {
                const operationId =
                  `${runId}-${toolName}-${(sequence += 1)}`;
                const opContext = {
                  ...plugin.createToolExecutionContext(
                    "Clean up the exact marker-owned disposable Linear issue.",
                  ),
                  runId,
                  operationId,
                  deadlineAt: Date.now() + 60_000,
                };
                const prepared = await registry.prepare(
                  {
                    id: operationId,
                    name: toolName,
                    arguments: { id: issue.id },
                  },
                  opContext,
                );
                if (!prepared?.ok || prepared.action?.toolName !== toolName) {
                  throw new Error(
                    `${toolName} prepare failed: ${String(
                      prepared?.error?.code ??
                        prepared?.error?.message ??
                        "unknown",
                    ).slice(0, 160)}`,
                  );
                }
                const action = prepared.action;
                const authorization = {
                  preparedActionId: action.id,
                  payloadFingerprint: action.payloadFingerprint,
                  grantId: `flow-real-cleanup-${toolName}-${issue.id}`,
                };
                const result = await registry.executePrepared(
                  action,
                  { ...opContext, authorizedAction: authorization },
                  authorization,
                );
                if (
                  result?.ok !== true ||
                  result?.receipt?.toolName !== toolName ||
                  result?.receipt?.resource?.id !== issue.id ||
                  result?.receipt?.readback?.status !== "verified"
                ) {
                  throw new Error(
                    `${toolName} failed: ${String(
                      result?.error?.code ??
                        result?.error?.message ??
                        "receipt_invalid",
                    ).slice(0, 160)}`,
                  );
                }
              };
              const readState = async (): Promise<
                "active" | "trashed" | "absent"
              > => {
                try {
                  const readback: any = await client.execute("issues.get", {
                    id: issue.id,
                  });
                  return readback?.trashed === true ||
                    readback?.attributes?.trashed === true
                    ? "trashed"
                    : "active";
                } catch (error) {
                  if (
                    String((error as any)?.code ?? "") === "linear_not_found"
                  ) {
                    return "absent";
                  }
                  throw error;
                }
              };

              let state = await readState();
              if (state === "active") {
                await executeExactMutation("linear_trash_issue");
                for (let attempt = 0; attempt < 5; attempt += 1) {
                  state = await readState();
                  if (state !== "active") break;
                  await new Promise((resolve) =>
                    setTimeout(resolve, 250 * (attempt + 1)),
                  );
                }
                if (state === "active") {
                  throw new Error(
                    "provider readback remained active after trash",
                  );
                }
                trashed.push(issue);
              }

              if (permanent && state === "trashed") {
                await executeExactMutation(
                  "linear_delete_issue_permanently",
                );
                permanentlyDeleted.push(issue);
                for (let attempt = 0; attempt < 5; attempt += 1) {
                  state = await readState();
                  if (state === "absent") break;
                  await new Promise((resolve) =>
                    setTimeout(resolve, 250 * (attempt + 1)),
                  );
                }
              }
              if (permanent) {
                if (state !== "absent") {
                  throw new Error(
                    `provider readback remained ${state} after permanent deletion`,
                  );
                }
                verifiedAbsent.push(issue);
              } else if (state !== "trashed" && state !== "absent") {
                throw new Error(
                  `provider readback remained ${state} after trash`,
                );
              }
            } catch (error) {
              failures.push({
                ...issue,
                error: String((error as Error)?.message ?? error).slice(0, 200),
              });
            }
          }
        }

        return {
          teamId,
          totalIssues: nodes.length,
          eligible,
          alreadyClean,
          nearMiss,
          applied: apply,
          trashed,
          permanentlyDeleted,
          verifiedAbsent,
          failures,
        };
      },
      {
        pluginId: NATIVE_CORE_PLUGIN_ID,
        apply: APPLY,
        permanent: PERMANENT,
        titlePattern: FLOW_REAL_TITLE.source,
        exactIssueId: EXACT_ISSUE_ID,
        exactMarker: EXACT_MARKER,
      },
    );

    await testInfo.attach("flow-real-cleanup", {
      body: JSON.stringify(outcome, null, 2),
      contentType: "application/json",
    });
    await writeFile(
      path.join(process.cwd(), "test-results", "flow-real-cleanup.json"),
      JSON.stringify(outcome, null, 2),
      "utf8",
    );

    // eslint-disable-next-line no-console
    console.log(
      `Flow real cleanup (${APPLY ? "APPLIED" : "dry run"}): ` +
        `${outcome.eligible.length} eligible of ${outcome.totalIssues} issues; ` +
        `${outcome.trashed.length} trashed; ${outcome.permanentlyDeleted.length} permanently deleted; ` +
        `${outcome.failures.length} failed; ` +
        `${outcome.nearMiss.length} near-miss retained.`,
    );
    for (const issue of outcome.eligible) {
      // eslint-disable-next-line no-console
      console.log(`  ${issue.identifier} ${issue.title}`);
    }

    if (APPLY) {
      if (EXACT_ISSUE_ID) {
        expect(
          [...outcome.eligible, ...outcome.alreadyClean],
          "the exact marker and provider ID must resolve one owned issue",
        ).toHaveLength(1);
      }
      expect(
        outcome.failures,
        `some Flow real issues could not be trashed: ${JSON.stringify(outcome.failures)}`,
      ).toEqual([]);
      if (PERMANENT) {
        expect(outcome.verifiedAbsent.length).toBe(outcome.eligible.length);
      } else {
        expect(outcome.trashed.length).toBe(outcome.eligible.length);
      }
    }
  } finally {
    await harness?.close().catch(() => undefined);
  }
});
