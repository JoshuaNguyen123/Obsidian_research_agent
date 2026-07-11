export const RESEARCH_TEMPLATE_WORKFLOW_VERSION = 1 as const;

export type ResearchTemplatePhase =
  | "discover"
  | "research"
  | "resolve"
  | "preview"
  | "create"
  | "verify"
  | "complete";

export type ResearchTemplateWorkflowStatus =
  | "running"
  | "waiting"
  | "blocked"
  | "failed"
  | "complete";

export interface TemplateResearchFinding {
  id: string;
  summary: string;
  sourceIds: string[];
  confidence: "low" | "medium" | "high";
}

export interface TransactionalPackArtifact {
  id: string;
  role: "brief" | "sources" | "synthesis" | "index";
  path: string;
  content: string;
  contentHash: string;
  dependencyIds: string[];
  mustNotExist: true;
}

export interface TransactionalResearchPackPlan {
  transactionId: string;
  rootPath: string;
  artifacts: TransactionalPackArtifact[];
  createOrder: string[];
  verifyPaths: string[];
  rollback: "trash_created_artifacts";
}

export interface ResearchTemplateWorkflowV1 {
  version: typeof RESEARCH_TEMPLATE_WORKFLOW_VERSION;
  id: string;
  runId: string;
  phase: ResearchTemplatePhase;
  status: ResearchTemplateWorkflowStatus;
  sequence: number;
  completedPhases: ResearchTemplatePhase[];
  templatePath?: string;
  findings: TemplateResearchFinding[];
  fieldValues: Record<string, string>;
  missingFieldGroups: Record<string, string[]>;
  previewContent?: string;
  approvedPreviewHash?: string;
  packPlan?: TransactionalResearchPackPlan;
  createdPaths: string[];
  verifiedPaths: string[];
  blocker?: string;
  createdAt: string;
  updatedAt: string;
}

interface WorkflowEventBase {
  runId: string;
  sequence: number;
  occurredAt: string;
}

export type ResearchTemplateWorkflowEvent =
  | (WorkflowEventBase & {
      kind: "template_selected";
      templatePath: string;
    })
  | (WorkflowEventBase & {
      kind: "research_completed";
      findings: TemplateResearchFinding[];
    })
  | (WorkflowEventBase & {
      kind: "fields_resolved";
      values: Record<string, string>;
      missingFieldGroups?: Record<string, string[]>;
    })
  | (WorkflowEventBase & {
      kind: "preview_prepared";
      content: string;
    })
  | (WorkflowEventBase & {
      kind: "preview_approved";
      approvedHash: string;
    })
  | (WorkflowEventBase & {
      kind: "pack_created";
      plan: TransactionalResearchPackPlan;
      createdPaths: string[];
    })
  | (WorkflowEventBase & {
      kind: "verification_completed";
      passed: boolean;
      verifiedPaths: string[];
      blocker?: string;
    })
  | (WorkflowEventBase & {
      kind: "workflow_blocked";
      blocker: string;
    })
  | (WorkflowEventBase & {
      kind: "workflow_resumed";
    })
  | (WorkflowEventBase & {
      kind: "workflow_failed";
      error: string;
    });

export function createResearchTemplateWorkflow(input: {
  id: string;
  runId: string;
  now?: Date;
}): ResearchTemplateWorkflowV1 {
  const now = (input.now ?? new Date()).toISOString();
  return {
    version: RESEARCH_TEMPLATE_WORKFLOW_VERSION,
    id: input.id,
    runId: input.runId,
    phase: "discover",
    status: "running",
    sequence: 0,
    completedPhases: [],
    findings: [],
    fieldValues: Object.create(null) as Record<string, string>,
    missingFieldGroups: Object.create(null) as Record<string, string[]>,
    createdPaths: [],
    verifiedPaths: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function reduceResearchTemplateWorkflow(
  state: ResearchTemplateWorkflowV1,
  event: ResearchTemplateWorkflowEvent,
): ResearchTemplateWorkflowV1 {
  if (event.runId !== state.runId) {
    throw new Error("Research template event belongs to a different run.");
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= state.sequence) {
    return state;
  }

  if (event.kind === "workflow_blocked") {
    return updateState(state, event, {
      status: "blocked",
      blocker: normalizeText(event.blocker),
    });
  }
  if (event.kind === "workflow_failed") {
    return updateState(state, event, {
      status: "failed",
      blocker: normalizeText(event.error),
    });
  }
  if (event.kind === "workflow_resumed") {
    if (state.status !== "blocked") return state;
    return updateState(state, event, { status: "running", blocker: undefined });
  }
  if (state.status === "blocked" || state.status === "failed" || state.status === "complete") {
    throw new Error(`Cannot apply ${event.kind} while workflow is ${state.status}.`);
  }

  switch (event.kind) {
    case "template_selected":
      assertPhase(state, "discover", event.kind);
      return advancePhase(state, event, "research", {
        templatePath: normalizeVaultMarkdownPath(event.templatePath),
      });
    case "research_completed":
      assertPhase(state, "research", event.kind);
      return advancePhase(state, event, "resolve", {
        findings: normalizeFindings(event.findings),
      });
    case "fields_resolved": {
      assertPhase(state, "resolve", event.kind);
      const missing = normalizeMissingGroups(event.missingFieldGroups ?? {});
      const hasMissing = Object.values(missing).some((names) => names.length > 0);
      if (hasMissing) {
        return updateState(state, event, {
          fieldValues: normalizeFieldValues(event.values),
          missingFieldGroups: missing,
          status: "waiting",
        });
      }
      return advancePhase(state, event, "preview", {
        fieldValues: normalizeFieldValues(event.values),
        missingFieldGroups: missing,
        status: "running",
      });
    }
    case "preview_prepared":
      assertPhase(state, "preview", event.kind);
      if (!event.content.trim()) throw new Error("Template preview cannot be empty.");
      return updateState(state, event, {
        previewContent: event.content,
        status: "waiting",
      });
    case "preview_approved":
      assertPhase(state, "preview", event.kind);
      if (!state.previewContent) throw new Error("A preview must be prepared before approval.");
      if (stableContentHash(state.previewContent) !== event.approvedHash) {
        throw new Error("Approved preview hash does not match the current preview.");
      }
      return advancePhase(state, event, "create", {
        approvedPreviewHash: event.approvedHash,
        status: "running",
      });
    case "pack_created":
      assertPhase(state, "create", event.kind);
      assertCreatedPackMatchesPlan(event.plan, event.createdPaths);
      return advancePhase(state, event, "verify", {
        packPlan: event.plan,
        createdPaths: uniqueSortedPaths(event.createdPaths),
      });
    case "verification_completed":
      assertPhase(state, "verify", event.kind);
      if (!event.passed) {
        return updateState(state, event, {
          status: "blocked",
          blocker: normalizeText(event.blocker ?? "Read-back verification failed."),
          verifiedPaths: uniqueSortedPaths(event.verifiedPaths),
        });
      }
      assertVerificationComplete(state, event.verifiedPaths);
      return advancePhase(state, event, "complete", {
        status: "complete",
        verifiedPaths: uniqueSortedPaths(event.verifiedPaths),
      });
  }
}

export function replayResearchTemplateWorkflow(
  initial: ResearchTemplateWorkflowV1,
  events: ResearchTemplateWorkflowEvent[],
): ResearchTemplateWorkflowV1 {
  return [...events]
    .sort((left, right) => left.sequence - right.sequence)
    .reduce(reduceResearchTemplateWorkflow, initial);
}

export function buildTransactionalResearchPackPlan(input: {
  transactionId: string;
  baseFolder: string;
  title: string;
  brief: string;
  sources: Array<{ id: string; title: string; url?: string; passage?: string }>;
  synthesis: string;
  existingPaths?: Iterable<string>;
}): TransactionalResearchPackPlan {
  const baseFolder = normalizeVaultFolderPath(input.baseFolder);
  const safeTitle = toSafeBasename(input.title) || "Research Pack";
  const rootPath = selectCollisionFreePackRoot(
    baseFolder,
    safeTitle,
    input.existingPaths ?? [],
  );
  const indexPath = `${rootPath}/Index.md`;
  const briefPath = `${rootPath}/Brief.md`;
  const sourcesPath = `${rootPath}/Sources.md`;
  const synthesisPath = `${rootPath}/Synthesis.md`;
  const artifacts: TransactionalPackArtifact[] = [
    createArtifact("brief", "brief", briefPath, input.brief, []),
    createArtifact(
      "sources",
      "sources",
      sourcesPath,
      renderSourceIndex(input.sources),
      [],
    ),
    createArtifact(
      "synthesis",
      "synthesis",
      synthesisPath,
      ensureTitle(input.synthesis, "Synthesis"),
      ["brief", "sources"],
    ),
    createArtifact(
      "index",
      "index",
      indexPath,
      [
        `# ${safeTitle}`,
        "",
        `- [[${withoutMarkdownExtension(briefPath)}|Brief]]`,
        `- [[${withoutMarkdownExtension(sourcesPath)}|Sources]]`,
        `- [[${withoutMarkdownExtension(synthesisPath)}|Synthesis]]`,
        "",
      ].join("\n"),
      ["brief", "sources", "synthesis"],
    ),
  ];
  return {
    transactionId: normalizeIdentifier(input.transactionId, "transaction"),
    rootPath,
    artifacts,
    createOrder: artifacts.map((artifact) => artifact.id),
    verifyPaths: artifacts.map((artifact) => artifact.path),
    rollback: "trash_created_artifacts",
  };
}

export function verifyTransactionalResearchPack(
  plan: TransactionalResearchPackPlan,
  readBack: Record<string, string | undefined>,
): { passed: boolean; missingPaths: string[]; mismatchedPaths: string[] } {
  const missingPaths: string[] = [];
  const mismatchedPaths: string[] = [];
  for (const artifact of plan.artifacts) {
    const actual = readBack[artifact.path];
    if (actual === undefined) {
      missingPaths.push(artifact.path);
    } else if (stableContentHash(actual) !== artifact.contentHash) {
      mismatchedPaths.push(artifact.path);
    }
  }
  return {
    passed: missingPaths.length === 0 && mismatchedPaths.length === 0,
    missingPaths,
    mismatchedPaths,
  };
}

export function stableContentHash(content: string): string {
  const normalized = content.replace(/\r\n?/g, "\n");
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function advancePhase(
  state: ResearchTemplateWorkflowV1,
  event: ResearchTemplateWorkflowEvent,
  nextPhase: ResearchTemplatePhase,
  patch: Partial<ResearchTemplateWorkflowV1>,
): ResearchTemplateWorkflowV1 {
  const completedPhases = state.completedPhases.includes(state.phase)
    ? state.completedPhases
    : [...state.completedPhases, state.phase];
  return updateState(state, event, {
    ...patch,
    phase: nextPhase,
    completedPhases,
  });
}

function updateState(
  state: ResearchTemplateWorkflowV1,
  event: ResearchTemplateWorkflowEvent,
  patch: Partial<ResearchTemplateWorkflowV1>,
): ResearchTemplateWorkflowV1 {
  return {
    ...state,
    ...patch,
    sequence: event.sequence,
    updatedAt: event.occurredAt,
  };
}

function assertPhase(
  state: ResearchTemplateWorkflowV1,
  expected: ResearchTemplatePhase,
  eventKind: string,
): void {
  if (state.phase !== expected) {
    throw new Error(`${eventKind} requires ${expected} phase, not ${state.phase}.`);
  }
}

function assertCreatedPackMatchesPlan(
  plan: TransactionalResearchPackPlan,
  createdPaths: string[],
): void {
  const expected = uniqueSortedPaths(plan.verifyPaths);
  const actual = uniqueSortedPaths(createdPaths);
  if (expected.length !== actual.length || expected.some((path, index) => path !== actual[index])) {
    throw new Error("Created paths do not match the approved transactional pack plan.");
  }
}

function assertVerificationComplete(
  state: ResearchTemplateWorkflowV1,
  verifiedPaths: string[],
): void {
  if (!state.packPlan) throw new Error("A pack plan is required before verification.");
  const expected = uniqueSortedPaths(state.packPlan.verifyPaths);
  const actual = uniqueSortedPaths(verifiedPaths);
  if (expected.length !== actual.length || expected.some((path, index) => path !== actual[index])) {
    throw new Error("Verification must read back every artifact in the pack.");
  }
}

function createArtifact(
  id: string,
  role: TransactionalPackArtifact["role"],
  path: string,
  content: string,
  dependencyIds: string[],
): TransactionalPackArtifact {
  const normalizedContent = ensureTitle(content, humanize(role));
  return {
    id,
    role,
    path: normalizeVaultMarkdownPath(path),
    content: normalizedContent,
    contentHash: stableContentHash(normalizedContent),
    dependencyIds,
    mustNotExist: true,
  };
}

function renderSourceIndex(
  sources: Array<{ id: string; title: string; url?: string; passage?: string }>,
): string {
  const sections = ["# Sources", ""];
  for (const source of sources) {
    const title = normalizeText(source.title) || source.id;
    sections.push(`## ${title}`);
    if (source.url) sections.push(`- URL: ${source.url.trim()}`);
    sections.push(`- Source ID: ${source.id}`);
    if (source.passage?.trim()) sections.push("", source.passage.trim());
    sections.push("");
  }
  return sections.join("\n");
}

function ensureTitle(content: string, title: string): string {
  const trimmed = content.trim();
  return /^#\s+/m.test(trimmed) ? `${trimmed}\n` : `# ${title}\n\n${trimmed}\n`;
}

function normalizeFindings(findings: TemplateResearchFinding[]): TemplateResearchFinding[] {
  const seen = new Set<string>();
  const result: TemplateResearchFinding[] = [];
  for (const finding of findings) {
    const id = normalizeIdentifier(finding.id, "finding");
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      summary: normalizeText(finding.summary),
      sourceIds: Array.from(new Set(finding.sourceIds.map((value) => value.trim()).filter(Boolean))),
      confidence:
        finding.confidence === "high" || finding.confidence === "medium"
          ? finding.confidence
          : "low",
    });
  }
  return result;
}

function normalizeFieldValues(values: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(values)) {
    const safeKey = key.trim();
    if (/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(safeKey)) result[safeKey] = String(value);
  }
  return result;
}

function normalizeMissingGroups(
  groups: Record<string, string[]>,
): Record<string, string[]> {
  const result: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const [group, fields] of Object.entries(groups)) {
    const safeGroup = normalizeText(group) || "Required";
    const safeFields = Array.from(
      new Set(fields.map((field) => field.trim()).filter((field) => /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(field))),
    );
    if (safeFields.length > 0) result[safeGroup] = safeFields;
  }
  return result;
}

function uniqueSortedPaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map(normalizeVaultMarkdownPath))).sort();
}

function selectCollisionFreePackRoot(
  baseFolder: string,
  title: string,
  existingPaths: Iterable<string>,
): string {
  const existing = [...existingPaths].map((path) =>
    path.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/").toLowerCase(),
  );
  for (let suffix = 1; suffix <= 1_000; suffix += 1) {
    const root = `${baseFolder}/${title}${suffix === 1 ? "" : ` ${suffix}`}`;
    const normalizedRoot = root.toLowerCase();
    const occupied = existing.some(
      (path) => path === normalizedRoot || path.startsWith(`${normalizedRoot}/`),
    );
    if (!occupied) return root;
  }
  throw new Error(`Could not find a collision-free research pack folder for ${title}.`);
}

function normalizeVaultMarkdownPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (!normalized || normalized.includes("..") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error("Research pack path must be vault-relative and traversal-free.");
  }
  return normalized.toLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
}

function normalizeVaultFolderPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  if (!normalized || normalized.includes("..") || /^[a-zA-Z]:/.test(normalized) || normalized.toLowerCase().endsWith(".md")) {
    throw new Error("Research pack folder must be a safe vault-relative folder.");
  }
  return normalized;
}

function toSafeBasename(value: string): string {
  return value.replace(/[\\/:*?"<>|\r\n\0]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

function withoutMarkdownExtension(path: string): string {
  return path.replace(/\.md$/i, "");
}

function normalizeIdentifier(value: string, fallback: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 120) || fallback;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function humanize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
