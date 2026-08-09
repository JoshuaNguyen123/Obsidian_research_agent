import type { AgentRunReceipt } from "../AgentRunner";
import type { NoteOutputPlan } from "./noteOutputPolicy";

export interface NoteDeliveryChatSummaryInputV1 {
  fullContent: string;
  noteOutputPlan?: NoteOutputPlan | null;
  receipts: readonly AgentRunReceipt[];
}

/** Keep a report in its new note while Chat retains its link and write proof. */
export function buildNoteDeliveryChatSummaryV1(
  input: NoteDeliveryChatSummaryInputV1,
): string {
  if (input.noteOutputPlan?.destination !== "new_note") {
    return input.fullContent;
  }
  const receipt = [...input.receipts]
    .reverse()
    .find(
      (candidate) =>
        candidate.readback?.status === "verified" &&
        typeof candidate.path === "string" &&
        candidate.path.trim().length > 0,
    );
  if (!receipt?.path) {
    return input.fullContent;
  }
  const path = receipt.path.trim();
  const title = path.replace(/^.*\//u, "").replace(/\.md$/iu, "");
  const bytes =
    typeof receipt.bytesWritten === "number"
      ? ` · ${receipt.bytesWritten} bytes written`
      : "";
  return [
    `Created [[${path}|${title}]].`,
    "The generated report is in the note.",
    `Receipt: ${receipt.operation}${bytes} · readback verified.`,
  ].join("\n\n");
}
