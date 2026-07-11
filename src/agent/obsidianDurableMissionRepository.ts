import type { ToolExecutionContext } from "../tools/types";
import {
  normalizeDurableMissionManifest,
  type DurableMissionManifestV1,
} from "./durableMission";
import {
  listRecoverableDurableMissions,
  readDurableMissionManifestById,
  writeDurableMissionManifest,
} from "./durableMissionStore";
import type { DurableMissionManifestRepository } from "./durableMissionSupervisor";

/** Bridges the pure durable supervisor to the native Obsidian vault store. */
export function createObsidianDurableMissionRepository(
  getContext: () => ToolExecutionContext,
): DurableMissionManifestRepository {
  return {
    async load(missionId) {
      return (
        (await readDurableMissionManifestById(getContext(), missionId))
          ?.manifest ?? null
      );
    },

    async save(manifest, expectedRevision) {
      const result = await writeDurableMissionManifest(getContext(), manifest, {
        expectedRevision,
      });
      if (!result) {
        throw new Error(
          "Durable mission persistence is unavailable in this Obsidian vault.",
        );
      }
      const persisted = normalizeDurableMissionManifest(
        JSON.parse(JSON.stringify(manifest)),
      );
      if (!persisted) {
        throw new Error("Durable mission persistence returned invalid state.");
      }
      return persisted;
    },

    async listRecoverable(now) {
      return (await listRecoverableDurableMissions(getContext(), now)).map(
        ({ manifest }) => cloneManifest(manifest),
      );
    },
  };
}

function cloneManifest(
  manifest: DurableMissionManifestV1,
): DurableMissionManifestV1 {
  const clone = normalizeDurableMissionManifest(
    JSON.parse(JSON.stringify(manifest)),
  );
  if (!clone) {
    throw new Error("Cannot clone an invalid durable mission manifest.");
  }
  return clone;
}
