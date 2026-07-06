import type { MissionIntent } from "../../tools/types";

export type StructuredIntentPrimary =
  | "answer"
  | "write"
  | "edit"
  | "research"
  | "browse"
  | "artifact"
  | "memory";

export type StructuredEvidenceNeed =
  | "current_note"
  | "vault"
  | "web"
  | "graph"
  | "word_count"
  | "browser"
  | "memory";

export type StructuredWriteTarget =
  | "current_note"
  | "section"
  | "path"
  | "template"
  | "artifact"
  | "research_memory";

export type StructuredMutationKind =
  | "append"
  | "replace"
  | "edit"
  | "move"
  | "trash"
  | "create";

export interface StructuredIntent {
  primary: StructuredIntentPrimary;
  evidenceNeeds: StructuredEvidenceNeed[];
  writeTarget?: StructuredWriteTarget;
  mutationKind?: StructuredMutationKind;
  destructive: boolean;
  confidence: number;
  ambiguities: string[];
}

export function classifyStructuredIntent(
  prompt: string,
  missionIntent?: MissionIntent,
): StructuredIntent {
  const evidenceNeeds = dedupeEvidenceNeeds([
    hasCurrentNoteNeed(prompt) ? "current_note" : null,
    hasVaultNeed(prompt, missionIntent) ? "vault" : null,
    hasWebNeed(prompt) ? "web" : null,
    hasGraphNeed(prompt) ? "graph" : null,
    hasWordCountNeed(prompt) ? "word_count" : null,
    hasBrowserNeed(prompt) ? "browser" : null,
    hasMemoryNeed(prompt) ? "memory" : null,
  ]);
  const destructive = hasDestructiveIntent(prompt, missionIntent);
  const mutationKind = getMutationKind(prompt, missionIntent);
  const writeTarget = getWriteTarget(prompt, missionIntent);
  const primary = getPrimaryIntent(prompt, evidenceNeeds, writeTarget, mutationKind);
  const ambiguities = getAmbiguities(prompt, writeTarget, mutationKind, destructive);

  return {
    primary,
    evidenceNeeds,
    writeTarget,
    mutationKind,
    destructive,
    confidence: ambiguities.length > 0 ? 0.68 : 0.86,
    ambiguities,
  };
}

export function formatStructuredIntentForPrompt(intent: StructuredIntent): string {
  return [
    "Structured intent facets:",
    `primary=${intent.primary}`,
    `evidence=${intent.evidenceNeeds.join(",") || "none"}`,
    `writeTarget=${intent.writeTarget ?? "none"}`,
    `mutation=${intent.mutationKind ?? "none"}`,
    `destructive=${intent.destructive ? "yes" : "no"}`,
    `confidence=${intent.confidence}`,
    `ambiguities=${intent.ambiguities.join("; ") || "none"}`,
  ].join(" ");
}

function getPrimaryIntent(
  prompt: string,
  evidenceNeeds: StructuredEvidenceNeed[],
  writeTarget: StructuredWriteTarget | undefined,
  mutationKind: StructuredMutationKind | undefined,
): StructuredIntentPrimary {
  if (hasBrowserNeed(prompt)) return "browse";
  if (hasDesignNeed(prompt) || writeTarget === "artifact") return "artifact";
  if (hasMemoryNeed(prompt) || writeTarget === "research_memory") return "memory";
  if (mutationKind === "edit" || mutationKind === "replace" || mutationKind === "move") {
    return "edit";
  }
  if (writeTarget) return "write";
  if (evidenceNeeds.includes("web") || evidenceNeeds.includes("vault")) return "research";
  return "answer";
}

function getWriteTarget(
  prompt: string,
  missionIntent: MissionIntent | undefined,
): StructuredWriteTarget | undefined {
  if (hasDesignNeed(prompt)) return "artifact";
  if (/\btemplate|boilerplate|form\b/i.test(prompt)) return "template";
  if (/\bresearch memory|remember|save this memory|persist\b/i.test(prompt)) {
    return "research_memory";
  }
  if (/\bsection|heading\b/i.test(prompt) && /\b(write|append|edit|revise|update)\b/i.test(prompt)) {
    return "section";
  }
  if (/\.md\b|\/[A-Za-z0-9 .@()_-]+\.md\b/i.test(prompt)) return "path";
  if (missionIntent?.noteOutput || /\b(current|active|this)\s+(note|page|file|document)\b/i.test(prompt)) {
    return "current_note";
  }
  return undefined;
}

function getMutationKind(
  prompt: string,
  missionIntent: MissionIntent | undefined,
): StructuredMutationKind | undefined {
  if (missionIntent?.explicitDelete || /\b(delete|remove|trash)\b/i.test(prompt)) return "trash";
  if (/\b(move|rename|relocate)\b/i.test(prompt)) return "move";
  if (/\b(replace|rewrite|overwrite|reset|start fresh|clear)\b/i.test(prompt)) return "replace";
  if (/\b(edit|revise|update|improve)\b/i.test(prompt)) return "edit";
  if (/\b(create|new|make)\b/i.test(prompt)) return "create";
  if (/\b(append|add|insert|write|save|put)\b/i.test(prompt)) return "append";
  return undefined;
}

function getAmbiguities(
  prompt: string,
  writeTarget: StructuredWriteTarget | undefined,
  mutationKind: StructuredMutationKind | undefined,
  destructive: boolean,
): string[] {
  const ambiguities: string[] = [];
  if (destructive && !writeTarget && !/\.md\b|\bcurrent|active|this\b/i.test(prompt)) {
    ambiguities.push("destructive_target_unclear");
  }
  if (mutationKind && !writeTarget && /\b(note|file|page|document)\b/i.test(prompt)) {
    ambiguities.push("write_target_unclear");
  }
  if (/\b(date|deadline|tomorrow|yesterday|next week)\b/i.test(prompt) && !/\b\d{4}\b/.test(prompt)) {
    ambiguities.push("relative_date_without_year");
  }
  return ambiguities;
}

function hasCurrentNoteNeed(prompt: string): boolean {
  return /\b(current|active|this)\s+(note|page|file|document)\b|\bread\s+(this|the)\s+(note|page)\b/i.test(prompt);
}

function hasVaultNeed(prompt: string, missionIntent: MissionIntent | undefined): boolean {
  return Boolean(
    missionIntent?.vaultContext ||
      /\b(vault|my notes|across notes|other folders|search notes|related notes)\b/i.test(prompt),
  );
}

function hasWebNeed(prompt: string): boolean {
  return /\b(web|online|sources?|citations?|latest|current facts?|verify|fact[-\s]?check)\b/i.test(prompt);
}

function hasGraphNeed(prompt: string): boolean {
  return /\b(graph|backlinks?|related notes?|connect|link notes?)\b/i.test(prompt);
}

function hasWordCountNeed(prompt: string): boolean {
  return /\b(word count|count words|verify length|\d{2,5}\s+words?)\b/i.test(prompt);
}

function hasBrowserNeed(prompt: string): boolean {
  return /\b(browser|click|scroll|open page|web page|screenshot|extract page)\b/i.test(prompt);
}

function hasMemoryNeed(prompt: string): boolean {
  return /\b(memory|remember|recall|experience|procedure|learned)\b/i.test(prompt);
}

function hasDesignNeed(prompt: string): boolean {
  return /\b(canvas|diagram|svg|wireframe|design package|flowchart|mind map)\b/i.test(prompt);
}

function hasDestructiveIntent(
  prompt: string,
  missionIntent: MissionIntent | undefined,
): boolean {
  return Boolean(
    missionIntent?.explicitDelete ||
      /\b(delete|remove|trash|overwrite|replace|clear|reset)\b/i.test(prompt),
  );
}

function dedupeEvidenceNeeds(
  values: Array<StructuredEvidenceNeed | null>,
): StructuredEvidenceNeed[] {
  return [...new Set(values.filter((value): value is StructuredEvidenceNeed => value !== null))];
}
