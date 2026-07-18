import { expect, test } from "@playwright/test";

import {
  NATIVE_CORE_PLUGIN_ID,
  startNativeObsidianHarness,
  type NativeObsidianHarness,
} from "./fixtures/nativeObsidianHarness";

const CONFIGURED_LINEAR_LIVE_LANE = "configured-linear-live";

test.describe.serial("configured native Linear live proof", () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");

  test("uses the persisted opaque credential through production tools and cleans every disposable resource", async () => {
    test.skip(
      process.env.E2E_PLAYWRIGHT_LANE !== CONFIGURED_LINEAR_LIVE_LANE,
      "Run only through npm run test:e2e:configured-linear.",
    );
    test.setTimeout(10 * 60_000);

    let harness: NativeObsidianHarness | null = null;
    try {
      harness = await startNativeObsidianHarness({
        label: "configured-linear-live",
        preserveConfiguredLinearCredential: true,
        setup: async ({ page }) => {
          await page.evaluate(async (pluginId) => {
            const app = (window as typeof window & { app?: any }).app;
            if (!app?.workspace || !app?.plugins) {
              throw new Error("Obsidian app services are unavailable.");
            }
            if (typeof app.workspace.onLayoutReady === "function") {
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

      const proof = await harness.page.evaluate(async (pluginId) => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.[pluginId];
        if (!plugin) throw new Error("Agentic Researcher is unavailable.");

        const credential = plugin.getLinearCredentialStatus?.();
        const oauth = plugin.getLinearOAuthStatus?.();
        if (
          oauth?.connected !== true &&
          (credential?.configured !== true || credential?.secure !== true)
        ) {
          throw new Error(
            "A persistent opaque Linear OAuth or personal-key credential is required; plaintext fallback is not accepted.",
          );
        }

        const connection = await plugin.testLinearConnection();
        if (!connection?.ok) {
          throw new Error(
            `The configured Linear credential failed live discovery: ${String(
              connection?.message ?? "no provider message",
            ).slice(0, 500)}`,
          );
        }
        const snapshot = plugin.getLinearCapabilitySnapshot?.();
        const teamId = plugin.settings?.linearDefaultTeamId || snapshot?.teams?.[0]?.id;
        if (!teamId || !Array.isArray(snapshot?.teams) || snapshot.teams.length < 1) {
          throw new Error("Linear discovery did not provide a usable team.");
        }

        // Prepared creates prove target absence before mutation. Verify the
        // provider's missing-resource response is classified correctly so a
        // schema/error-shape drift cannot be mistaken for a safe no-op.
        try {
          await plugin
            .createSecretBackedLinearClient()
            .execute("issues.get", { id: crypto.randomUUID() });
          throw new Error("A random Linear issue ID unexpectedly resolved.");
        } catch (error) {
          if ((error as any)?.code !== "linear_not_found") {
            const details = Array.isArray((error as any)?.details)
              ? (error as any).details
                  .slice(0, 3)
                  .map((detail: any) => ({
                    message: String(detail?.message ?? "").slice(0, 300),
                    code: String(detail?.code ?? "").slice(0, 80),
                    path: Array.isArray(detail?.path) ? detail.path.slice(0, 12) : [],
                  }))
              : [];
            throw new Error(
              `Linear missing-resource classification failed: code=${String(
                (error as any)?.code ?? "unknown",
              )}; details=${JSON.stringify(details)}`,
            );
          }
        }

        const registry = plugin.createToolRegistry?.();
        if (!registry?.prepare || !registry?.executePrepared) {
          throw new Error("The production prepared-action registry is unavailable.");
        }
        const requiredTools = [
          "linear_create_issue",
          "linear_get_issue",
          "linear_search_issues",
          "linear_create_comment",
          "linear_delete_comment",
          "linear_trash_issue",
        ];
        const definitions = new Set(
          (registry.getDefinitions?.() ?? []).map(
            (definition: any) => definition?.function?.name,
          ),
        );
        for (const toolName of requiredTools) {
          if (!definitions.has(toolName)) {
            throw new Error(`Required production Linear tool is unavailable: ${toolName}.`);
          }
        }

        const suffix = crypto.randomUUID();
        const title = `Agentic configured live ${suffix}`;
        const runId = `configured-linear-live-${suffix}`;
        let operationSequence = 0;
        let issueId: string | null = null;
        let commentId: string | null = null;
        const cleanupErrors: string[] = [];
        let primaryError: unknown = null;

        const contextFor = (toolName: string) => ({
          ...plugin.createToolExecutionContext(
            `Configured native Linear live proof for ${suffix}.`,
          ),
          runId,
          operationId: `${toolName}-${++operationSequence}-${suffix}`,
          deadlineAt: Date.now() + 60_000,
        });
        const executeRead = async (
          name: string,
          args: Record<string, unknown>,
        ) => {
          const result = await registry.execute(
            { id: `${name}-read-${suffix}`, name, arguments: args },
            contextFor(name),
          );
          if (!result?.ok) {
            let providerDetails = "";
            if (name === "linear_search_issues") {
              try {
                await plugin.createSecretBackedLinearClient().execute("issues.search", args);
              } catch (error) {
                const details = Array.isArray((error as any)?.details)
                  ? (error as any).details.slice(0, 3)
                  : [];
                providerDetails = `; provider=${JSON.stringify({
                  code: String((error as any)?.code ?? "unknown"),
                  details,
                }).slice(0, 1_000)}`;
              }
            }
            throw new Error(
              `${name} failed: ${String(result?.error?.code ?? "unknown")}: ${String(
                result?.error?.message ?? "no message",
              ).slice(0, 500)}${providerDetails}`,
            );
          }
          return result.output;
        };
        const executeMutation = async (
          name: string,
          args: Record<string, unknown>,
          grantId: string,
        ) => {
          const context = contextFor(name);
          const prepared = await registry.prepare(
            { id: context.operationId, name, arguments: args },
            context,
          );
          if (!prepared?.ok) {
            throw new Error(
              `${name} preparation failed: ${String(prepared?.error?.code ?? "unknown")}`,
            );
          }
          const action = prepared.action;
          const authorization = {
            preparedActionId: action.id,
            payloadFingerprint: action.payloadFingerprint,
            grantId,
          };
          const authorizedContext = { ...context, authorizedAction: authorization };
          const executed = await registry.executePrepared(
            action,
            authorizedContext,
            authorization,
          );
          if (executed?.ok && executed.receipt) return executed;
          if (
            (executed?.mutationState === "may_have_applied" ||
              executed?.mutationState === "unknown") &&
            registry.reconcile
          ) {
            const reconciled = await registry.reconcile(action, authorizedContext);
            if (reconciled?.outcome === "committed" && reconciled.receipt) {
              return { ok: true, receipt: reconciled.receipt, output: { reconciled: true } };
            }
          }
          throw new Error(
            `${name} failed: ${String(executed?.error?.code ?? "unknown")}`,
          );
        };

        try {
          const requestedIssueId = crypto.randomUUID();
          issueId = requestedIssueId;
          const created = await executeMutation(
            "linear_create_issue",
            {
              id: requestedIssueId,
              teamId,
              title,
              description: [
                "Disposable production-path proof created by Agentic Researcher.",
                `Run marker: ${suffix}`,
                "The same test must trash this issue before it exits.",
              ].join("\n\n"),
            },
            `configured-linear-create-${suffix}`,
          );
          issueId = created.receipt.resource.id;
          if (
            created.receipt.readback?.status !== "verified" ||
            issueId !== requestedIssueId
          ) {
            throw new Error("Linear issue creation lacked exact verified readback.");
          }

          const issue = (await executeRead("linear_get_issue", { id: issueId })) as any;
          if (issue?.id !== issueId || issue?.title !== title) {
            throw new Error("Independent Linear issue readback did not match creation.");
          }
          const search = (await executeRead("linear_search_issues", {
            query: suffix,
            first: 10,
            after: null,
            includeArchived: false,
          })) as any;
          const matches = Array.isArray(search?.items)
            ? search.items.filter((candidate: any) => candidate?.id === issueId)
            : [];
          if (matches.length !== 1) {
            throw new Error(`Linear duplicate search returned ${matches.length} exact matches.`);
          }

          const requestedCommentId = crypto.randomUUID();
          commentId = requestedCommentId;
          const commented = await executeMutation(
            "linear_create_comment",
            {
              id: requestedCommentId,
              issueId,
              body: `Disposable configured-credential comment ${suffix}`,
            },
            `configured-linear-comment-${suffix}`,
          );
          commentId = commented.receipt.resource.id;
          if (
            commented.receipt.readback?.status !== "verified" ||
            commentId !== requestedCommentId
          ) {
            throw new Error("Linear comment creation lacked exact verified readback.");
          }

          const deleted = await executeMutation(
            "linear_delete_comment",
            { id: commentId },
            `configured-linear-delete-comment-${suffix}`,
          );
          if (deleted.receipt.readback?.status !== "verified") {
            throw new Error("Linear comment deletion lacked verified absence readback.");
          }
          commentId = null;

          const trashed = await executeMutation(
            "linear_trash_issue",
            { id: issueId },
            `configured-linear-trash-issue-${suffix}`,
          );
          if (trashed.receipt.readback?.status !== "verified") {
            throw new Error("Linear issue trash lacked verified readback.");
          }
          issueId = null;
        } catch (error) {
          primaryError = error;
        } finally {
          if (commentId) {
            try {
              await executeMutation(
                "linear_delete_comment",
                { id: commentId },
                `configured-linear-clean-comment-${suffix}`,
              );
              commentId = null;
            } catch (error) {
              cleanupErrors.push(`comment: ${String(error)}`);
            }
          }
          if (issueId) {
            try {
              await executeMutation(
                "linear_trash_issue",
                { id: issueId },
                `configured-linear-clean-issue-${suffix}`,
              );
              issueId = null;
            } catch (error) {
              cleanupErrors.push(`issue: ${String(error)}`);
            }
          }
        }

        if (primaryError || issueId || commentId || cleanupErrors.length > 0) {
          const primary = primaryError ? String(primaryError) : "none";
          const cleanup = cleanupErrors.length
            ? cleanupErrors.join("; ")
            : issueId || commentId
              ? "resource identifiers remain"
              : "complete";
          throw new Error(
            `Configured Linear live proof failed: primary=${primary}; cleanup=${cleanup}`,
          );
        }

        return {
          credentialConfigured:
            oauth?.connected === true || credential?.configured === true,
          credentialSecure:
            oauth?.connected === true || credential?.secure === true,
          teamCount: snapshot.teams.length,
          projectCount: snapshot.projects.length,
          workflowStateCount: snapshot.workflowStates.length,
          cleaned: issueId === null && commentId === null,
        };
      }, NATIVE_CORE_PLUGIN_ID);

      expect(proof).toMatchObject({
        credentialConfigured: true,
        credentialSecure: true,
        cleaned: true,
      });
      expect(proof.teamCount).toBeGreaterThan(0);
      expect(proof.workflowStateCount).toBeGreaterThan(0);
      test.info().annotations.push({
        type: "live-provider-proof",
        description:
          "Used the Obsidian-persisted opaque Linear credential to discover capabilities, create/read/search/comment, and clean the disposable issue through the production tool registry.",
      });
    } finally {
      await harness?.close();
    }
  });
});
