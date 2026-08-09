import {
  renderHumanCompatibleWorkItemSpec,
  WORK_ITEM_CONTRACT_END,
  WORK_ITEM_CONTRACT_START,
  type WorkItemRenderDetailsV1,
} from "../../src/integrations/linear/WorkItemRenderer";
import type { WorkItemSpecV1 } from "../../src/integrations/linear/WorkItemSpecV1";

/**
 * Build a legacy v1 issue body: canonical human sections followed by one signed
 * v1 contract block. Queue ingestion still has to parse v1 descriptions that
 * predate the v2 contract, and only tests need to synthesize them — production
 * emits v2 through `renderQueueExecutableHumanWorkItemSpecV2`.
 */
export function renderContractBoundIssueBodyV1(
  spec: WorkItemSpecV1,
  renderDetails: WorkItemRenderDetailsV1 = {},
): string {
  return [
    renderHumanCompatibleWorkItemSpec(spec, renderDetails),
    [
      WORK_ITEM_CONTRACT_START,
      "```json",
      JSON.stringify(spec, null, 2),
      "```",
      WORK_ITEM_CONTRACT_END,
    ].join("\n"),
  ].join("\n\n");
}
