/**
 * Host-authoritative notebook + Linear requirements for code_execution.
 * Structural reflection only — no semantic AC→code verifier.
 */

import { createHash } from "node:crypto";
import { tryParseRenderedCompatibleWorkItemSpec } from "../integrations/linear/WorkItemParser";

export const CODE_SPEC_NOTE_EXCERPT_MAX_CHARS = 5000;
export const CODE_SPEC_LINEAR_DESCRIPTION_MAX_CHARS = 3500;
export const CODE_SPEC_AC_MAX_ITEMS = 12;

export const CODE_SPEC_GATED_MUTATION_TOOLS = [
  "code_workspace_create_file",
  "code_workspace_append",
  "code_workspace_patch",
  "code_workspace_write_expected",
  "code_workspace_mkdir",
] as const;

const GATED_MUTATION_SET = new Set<string>(CODE_SPEC_GATED_MUTATION_TOOLS);

const PREFERRED_NOTE_SECTION_RE =
  /^#{1,3}\s*(implementation|acceptance|summary|requirements|acceptance criteria)\b/imu;

export type CodeSpecLinearSliceV1 = {
  issueId?: string;
  identifier?: string;
  url?: string;
  title?: string;
  descriptionExcerpt?: string;
  acceptanceCriteria?: string[];
  objective?: string;
  workItemFingerprint?: string;
};

export type CodeSpecBindingV1 = {
  version: 1;
  notePath?: string;
  noteSha256?: string;
  noteExcerpt?: string;
  linear?: CodeSpecLinearSliceV1;
  fingerprint: string;
  observedAtIso: string;
};

export type CodeSpecSufficiencyV1 = {
  sufficient: boolean;
  hasNote: boolean;
  hasLinear: boolean;
  reason: string;
};

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Prefer ## Implementation / Acceptance / Summary / Requirements sections; else head+headings. */
export function extractBoundedNoteExcerpt(
  markdown: string,
  maxChars: number = CODE_SPEC_NOTE_EXCERPT_MAX_CHARS,
): string {
  const source = String(markdown ?? "");
  if (!source.trim()) return "";

  const lines = source.split(/\r?\n/);
  const preferredBlocks: string[] = [];
  let capturing = false;
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length > 0) {
      preferredBlocks.push(buffer.join("\n").trim());
      buffer = [];
    }
    capturing = false;
  };

  for (const line of lines) {
    if (/^#{1,3}\s+\S/.test(line)) {
      if (capturing) flush();
      if (PREFERRED_NOTE_SECTION_RE.test(line)) {
        capturing = true;
        buffer.push(line);
        continue;
      }
    }
    if (capturing) buffer.push(line);
  }
  if (capturing) flush();

  if (preferredBlocks.length > 0) {
    return truncate(preferredBlocks.join("\n\n"), maxChars);
  }

  const headingLines = lines.filter((line) => /^#{1,3}\s+\S/.test(line)).slice(0, 24);
  const head = lines.slice(0, 80).join("\n");
  const combined = [head, headingLines.length ? `\n\nHeadings:\n${headingLines.join("\n")}` : ""]
    .join("")
    .trim();
  return truncate(combined, maxChars);
}

/** Build linear slice from a verified issue record (id/identifier/url/title/description). */
export function buildCodeSpecLinearSliceFromIssueRecord(
  record: Record<string, unknown>,
): CodeSpecLinearSliceV1 | null {
  const issueId = getString(record.id);
  const identifier = getString(record.identifier);
  const url = getString(record.url);
  const title = getString(record.title);
  const description = getString(record.description) ?? "";
  if (!issueId && !identifier && !url && !title && !description) {
    return null;
  }

  const slice: CodeSpecLinearSliceV1 = {
    issueId,
    identifier,
    url,
    title,
  };

  const parsed = description
    ? tryParseRenderedCompatibleWorkItemSpec(description)
    : null;
  if (parsed?.spec) {
    const ac = Array.isArray(parsed.spec.acceptanceCriteria)
      ? parsed.spec.acceptanceCriteria
          .map((item) => String(item?.text ?? "").trim())
          .filter(Boolean)
          .slice(0, CODE_SPEC_AC_MAX_ITEMS)
      : [];
    if (ac.length > 0) slice.acceptanceCriteria = ac;
    const objective = getString(parsed.spec.objective);
    if (objective) slice.objective = truncate(objective, 800);
    const fingerprint = getString(parsed.spec.fingerprint);
    if (fingerprint) slice.workItemFingerprint = fingerprint;
  }

  if (description) {
    slice.descriptionExcerpt = truncate(
      description,
      CODE_SPEC_LINEAR_DESCRIPTION_MAX_CHARS,
    );
  }
  return slice;
}

/** Merge note + linear into binding; fingerprint = hash of path|sha|issueId|acDigest. */
export function buildCodeSpecBindingV1(input: {
  notePath?: string | null;
  noteSha256?: string | null;
  noteMarkdown?: string | null;
  linearRecord?: Record<string, unknown> | null;
  nowIso?: string;
}): CodeSpecBindingV1 | null {
  const notePath = getString(input.notePath ?? undefined);
  const noteSha256 = getString(input.noteSha256 ?? undefined);
  const noteMarkdown = typeof input.noteMarkdown === "string" ? input.noteMarkdown : "";
  const noteExcerpt = noteMarkdown.trim()
    ? extractBoundedNoteExcerpt(noteMarkdown)
    : undefined;
  const linear =
    input.linearRecord && typeof input.linearRecord === "object"
      ? buildCodeSpecLinearSliceFromIssueRecord(input.linearRecord)
      : undefined;

  if (!notePath && !noteExcerpt && !noteSha256 && !linear) {
    return null;
  }

  const acDigest = (linear?.acceptanceCriteria ?? []).join("|");
  const fingerprint = sha256Hex(
    [
      notePath ?? "",
      noteSha256 ?? "",
      linear?.issueId ?? linear?.identifier ?? "",
      linear?.url ?? "",
      acDigest,
      noteExcerpt?.slice(0, 200) ?? "",
    ].join("|"),
  );

  return {
    version: 1,
    notePath,
    noteSha256,
    noteExcerpt,
    linear: linear ?? undefined,
    fingerprint,
    observedAtIso: input.nowIso ?? new Date().toISOString(),
  };
}

/**
 * Sufficient when required sides are present.
 * Note: excerpt OR path+sha. Linear: title/description/AC OR identifier+url.
 */
export function evaluateCodeSpecSufficiency(input: {
  binding: CodeSpecBindingV1 | null;
  requireNote: boolean;
  requireLinear: boolean;
}): CodeSpecSufficiencyV1 {
  const binding = input.binding;
  const hasNote = Boolean(
    binding &&
      (binding.noteExcerpt?.trim() ||
        (binding.notePath?.trim() && binding.noteSha256?.trim())),
  );
  const linear = binding?.linear;
  const hasLinear = Boolean(
    linear &&
      ((linear.title?.trim() ||
        linear.descriptionExcerpt?.trim() ||
        (linear.acceptanceCriteria?.length ?? 0) > 0) ||
        (linear.identifier?.trim() && linear.url?.trim()) ||
        (linear.issueId?.trim() && linear.url?.trim())),
  );

  const missing: string[] = [];
  if (input.requireNote && !hasNote) missing.push("note");
  if (input.requireLinear && !hasLinear) missing.push("linear");
  const sufficient = missing.length === 0;
  return {
    sufficient,
    hasNote,
    hasLinear,
    reason: sufficient
      ? "code_spec_binding_sufficient"
      : `code_spec_binding_insufficient=${missing.join("|")}`,
  };
}

/** Compact block for system/frontier injection. */
export function formatCodeSpecBindingTurnContext(
  binding: CodeSpecBindingV1,
): string {
  const lines = [
    "CODE SPEC BINDING (host-authoritative; implement against this, not chat memory):",
  ];
  if (binding.notePath) lines.push(`notePath=${binding.notePath}`);
  if (binding.noteSha256) lines.push(`noteSha256=${binding.noteSha256}`);
  if (binding.noteExcerpt) {
    lines.push("noteExcerpt:");
    lines.push("---");
    lines.push(binding.noteExcerpt);
    lines.push("---");
  }
  const linear = binding.linear;
  if (linear) {
    if (linear.identifier) {
      lines.push(`linearIssueIdentifier=${linear.identifier}`);
    }
    if (linear.issueId) lines.push(`linearIssueId=${linear.issueId}`);
    if (linear.url) lines.push(`linearIssueUrl=${linear.url}`);
    if (linear.title) lines.push(`linearTitle=${linear.title}`);
    if (linear.objective) lines.push(`linearObjective=${linear.objective}`);
    if (linear.acceptanceCriteria?.length) {
      lines.push("acceptanceCriteria:");
      for (const item of linear.acceptanceCriteria) {
        lines.push(`- ${item}`);
      }
    }
    if (linear.descriptionExcerpt) {
      lines.push("linearDescriptionExcerpt:");
      lines.push("---");
      lines.push(linear.descriptionExcerpt);
      lines.push("---");
    }
  }
  lines.push(`fingerprint=${binding.fingerprint}`);
  return lines.join("\n");
}

/** Strip gated mutation tools when insufficient; leave reads/validate/status. */
export function filterToolsUntilCodeSpecSufficient(input: {
  offeredToolNames: readonly string[];
  sufficiency: CodeSpecSufficiencyV1;
}): string[] {
  if (input.sufficiency.sufficient) {
    return [...input.offeredToolNames];
  }
  return input.offeredToolNames.filter((name) => !GATED_MUTATION_SET.has(name));
}

/**
 * Set-loose Soft-union code-spec gate: once Linear delivery is paid (or the
 * host already observes the initiating note), do not withhold workspace
 * mutations because Continue/compaction lost a prior read_current_file parse.
 */
export function resolveSetLooseCodeSpecSufficiencyForSoftUnion(input: {
  sufficiency: CodeSpecSufficiencyV1;
  requireNote: boolean;
  requireLinear: boolean;
  linearDeliveryPaid: boolean;
  /** Host-observed initiating note path and/or loaded markdown. */
  hostNoteObserved?: boolean;
}): CodeSpecSufficiencyV1 {
  const hasNote =
    input.sufficiency.hasNote || input.hostNoteObserved === true;
  const hasLinear =
    input.sufficiency.hasLinear || input.linearDeliveryPaid === true;
  const noteOk =
    !input.requireNote || hasNote || input.linearDeliveryPaid === true;
  const linearOk = !input.requireLinear || hasLinear;
  const sufficient = noteOk && linearOk;
  return {
    sufficient,
    hasNote,
    hasLinear,
    reason: sufficient
      ? "code_spec_binding_sufficient"
      : input.sufficiency.reason,
  };
}
