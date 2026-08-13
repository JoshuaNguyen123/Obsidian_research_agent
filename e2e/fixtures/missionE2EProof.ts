import { createHash } from "node:crypto";
import type { TestInfo } from "@playwright/test";

import type { ArtifactRelevanceV1 } from "./coreMissionRelevance";

export interface MissionE2EProofV1 {
  version: 1;
  scenarioId: "CORE-01";
  promptSha256: string;
  runId: string;
  productionModelCalls: number;
  graphTerminal: boolean;
  noUnrequestedResearch: boolean;
  acceptanceStatus: string | null;
  receipts: Array<{
    toolName: string | null;
    operation: string | null;
    path: string | null;
    toPath: string | null;
    readbackStatus: string | null;
  }>;
  artifacts: Array<{
    kind: "markdown" | "canvas";
    path: string;
    bytes: number;
    sha256: string;
  }>;
  relevance: ArtifactRelevanceV1[];
}

export async function attachMissionE2EProof(
  testInfo: TestInfo,
  proof: MissionE2EProofV1,
): Promise<void> {
  await testInfo.attach("mission-e2e-proof-v1", {
    body: Buffer.from(`${JSON.stringify(proof, null, 2)}\n`, "utf8"),
    contentType: "application/json",
  });
}

export function sha256Text(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
