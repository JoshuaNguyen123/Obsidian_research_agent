import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";

/**
 * Durable Linear queue project provisioning for live compound lanes.
 *
 * The shared e2e Linear team decays to zero projects: other lanes create
 * their own disposable projects and trash them at cleanup, and no lane leaves
 * a durable one behind. `configureRecommendedLinearQueue` only SELECTS from
 * existing projects, so an empty team fails the compound readiness gate
 * before the mission ever runs ("Linear queue project is unresolved").
 *
 * This fixture makes the queue destination self-healing: reuse the durable
 * project by exact name when it exists, otherwise create it with a
 * host-pinned UUID (projects.create only acknowledges success, so the id must
 * be supplied via input.id — same pattern as the DU-06 evidence project).
 * The project is then PINNED as settings.linearQueueProjectId so a leftover
 * disposable project from a crashed run can never win queue selection.
 *
 * The durable project must NEVER be registered in a cleanup manifest. Its
 * name deliberately contains "Agent Queue" so projectSetupRank also prefers
 * it deterministically for every other lane that relies on recommended
 * queue selection.
 */
export const DURABLE_LINEAR_QUEUE_PROJECT_NAME = "Agent Queue E2E Durable";

export interface DurableLinearQueueResult {
  ok: boolean;
  projectId?: string;
  created?: boolean;
  message: string;
}

export async function ensureDurableLinearQueueProject(
  page: Page,
  options: { pluginId: string; teamId: string },
): Promise<DurableLinearQueueResult> {
  const candidateProjectId = randomUUID();
  return await page.evaluate(
    async ({ pluginId, teamId, durableName, candidateProjectId }) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      if (!plugin) {
        throw new Error("Agentic Researcher plugin is unavailable.");
      }
      plugin.settings.linearEnabled = true;
      plugin.settings.linearDefaultTeamId = teamId;
      await plugin.saveSettings?.();
      const connection = await plugin.testLinearConnection();
      if (!connection?.ok) {
        return {
          ok: false as const,
          message: `Linear discovery failed before queue provisioning: ${String(
            connection?.message ?? connection?.error ?? "unknown",
          ).slice(0, 300)}`,
        };
      }
      const findDurable = () => {
        const snapshot = plugin.getLinearCapabilitySnapshot?.();
        return (snapshot?.projects ?? []).find((project: any) => {
          if (String(project?.name ?? "").trim() !== durableName) {
            return false;
          }
          const teamIds = Array.isArray(project?.teamIds)
            ? project.teamIds.map((id: unknown) => String(id ?? "").trim())
            : [];
          return teamIds.length === 0 || teamIds.includes(teamId);
        });
      };
      let durable = findDurable();
      let created = false;
      if (!durable) {
        if (!plugin.createSecretBackedLinearClient) {
          return {
            ok: false as const,
            message:
              "Native Linear client unavailable to create the durable queue project.",
          };
        }
        const acknowledged = await plugin
          .createSecretBackedLinearClient()
          .execute("projects.create", {
            input: {
              id: candidateProjectId,
              name: durableName,
              teamIds: [teamId],
            },
          });
        if ((acknowledged as { success?: boolean } | null)?.success !== true) {
          return {
            ok: false as const,
            message:
              "Linear did not acknowledge creating the durable queue project.",
          };
        }
        created = true;
        const refreshed = await plugin.testLinearConnection();
        if (!refreshed?.ok) {
          return {
            ok: false as const,
            message:
              "Linear rediscovery failed after creating the durable queue project.",
          };
        }
        durable =
          findDurable() ??
          ({ id: candidateProjectId, name: durableName, teamIds: [teamId] } as {
            id: string;
          });
      }
      // Resolve Ready/started/completed workflow-state ids now that at least
      // one project exists, then pin the queue destination to the durable
      // project regardless of which project the ranking picked.
      await plugin.configureRecommendedLinearQueue?.();
      const projectId = String((durable as { id?: unknown })?.id ?? "").trim();
      if (!projectId) {
        return {
          ok: false as const,
          message: "Durable queue project id did not resolve after discovery.",
        };
      }
      plugin.settings.linearQueueProjectId = projectId;
      await plugin.saveSettings?.();
      return {
        ok: true as const,
        projectId,
        created,
        message: created ? "created" : "reused",
      };
    },
    {
      pluginId: options.pluginId,
      teamId: options.teamId,
      durableName: DURABLE_LINEAR_QUEUE_PROJECT_NAME,
      candidateProjectId,
    },
  );
}
