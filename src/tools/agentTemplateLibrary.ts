/**
 * Managed, vault-local templates that are available in every vault where the
 * plugin runs. The library is intentionally no-overwrite: users own the files
 * after their first creation and startup only repairs missing defaults.
 */

export const AGENT_WORK_FOLDER = "Agent Work";
export const AGENT_TEMPLATE_FOLDER = `${AGENT_WORK_FOLDER}/templates`;
export const LINEAR_ISSUE_TEMPLATE_NAME = "Linear issue.md";
export const LINEAR_ISSUE_TEMPLATE_PATH =
  `${AGENT_TEMPLATE_FOLDER}/${LINEAR_ISSUE_TEMPLATE_NAME}`;

export const LINEAR_ISSUE_TEMPLATE_V1 = `# {{title}}

## Problem / impact

{{problem_impact}}

## Evidence / source links

{{evidence}}

## Confidence / limitations

{{confidence_limitations}}

## Proposed work

{{proposed_work}}

## Non-goals

{{non_goals}}

## Scope

{{scope}}

## Dependencies

{{dependencies}}

## Acceptance criteria

{{acceptance_criteria}}

## Validation

{{validation}}
`;

export const DEFAULT_AGENT_TEMPLATE_SEEDS: Readonly<Record<string, string>> =
  Object.freeze({
    [LINEAR_ISSUE_TEMPLATE_NAME]: LINEAR_ISSUE_TEMPLATE_V1,
    "Research brief.md": `# {{topic}}

## Research question

{{research_question}}

## Why this matters

{{purpose}}

## Scope

{{scope}}

## Credible sources

{{sources}}

## Findings

{{findings}}

## Limitations and open questions

{{limitations}}

## Recommended next steps

{{next_steps}}
`,
    "Project brief.md": `# {{project_name}}

## Outcome

{{outcome}}

## Users and stakeholders

{{stakeholders}}

## Scope

{{scope}}

## Non-goals

{{non_goals}}

## Constraints and dependencies

{{constraints}}

## Success criteria

{{success_criteria}}

## Open questions

{{open_questions}}
`,
    "Implementation plan.md": `# {{work_title}}

## Objective

{{objective}}

## Current state

{{current_state}}

## Implementation steps

{{implementation_steps}}

## Risks and mitigations

{{risks}}

## Validation plan

{{validation_plan}}

## Completion evidence

{{completion_evidence}}
`,
    "Validation checklist.md": `# Validation: {{work_title}}

## Acceptance criteria

{{acceptance_criteria}}

## Automated checks

{{automated_checks}}

## Manual checks

{{manual_checks}}

## Evidence and receipts

{{evidence}}

## Remaining limitations

{{limitations}}
`,
  });

interface VaultEntryLike {
  path: string;
  children?: unknown[];
}

export interface AgentTemplateVaultPort {
  getAbstractFileByPath(path: string): VaultEntryLike | null;
  adapter?: {
    stat(path: string): Promise<{ type: "file" | "folder" } | null>;
  };
  createFolder(path: string): Promise<unknown>;
  create(path: string, content: string): Promise<unknown>;
}

export interface EnsureAgentTemplateLibraryResult {
  folder: typeof AGENT_TEMPLATE_FOLDER;
  createdTemplates: string[];
  skippedExisting: string[];
  bytesWritten: number;
}

export type AgentTemplateLibraryErrorCode =
  | "folder_path_conflict"
  | "template_path_conflict"
  | "vault_write_failed";

export class AgentTemplateLibraryError extends Error {
  constructor(
    readonly code: AgentTemplateLibraryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentTemplateLibraryError";
  }
}

/**
 * Creates the managed folder and any missing defaults. Existing template files
 * are never read, modified, or replaced.
 */
export async function ensureAgentTemplateLibrary(
  vault: AgentTemplateVaultPort,
): Promise<EnsureAgentTemplateLibraryResult> {
  try {
    await ensureFolder(vault, AGENT_WORK_FOLDER);
    await ensureFolder(vault, AGENT_TEMPLATE_FOLDER);

    const result: EnsureAgentTemplateLibraryResult = {
      folder: AGENT_TEMPLATE_FOLDER,
      createdTemplates: [],
      skippedExisting: [],
      bytesWritten: 0,
    };

    for (const [name, content] of Object.entries(DEFAULT_AGENT_TEMPLATE_SEEDS)) {
      const path = `${AGENT_TEMPLATE_FOLDER}/${name}`;
      const existing = vault.getAbstractFileByPath(path);
      const adapterEntry = existing ? null : await vault.adapter?.stat(path);
      if (existing || adapterEntry) {
        if (existing ? isFolder(existing) : adapterEntry?.type === "folder") {
          throw new AgentTemplateLibraryError(
            "template_path_conflict",
            "A managed template path is occupied by a folder.",
          );
        }
        result.skippedExisting.push(path);
        continue;
      }

      await vault.create(path, content);
      result.createdTemplates.push(path);
      result.bytesWritten += new TextEncoder().encode(content).byteLength;
    }

    return result;
  } catch (error) {
    if (error instanceof AgentTemplateLibraryError) throw error;
    throw new AgentTemplateLibraryError(
      "vault_write_failed",
      "The vault rejected a managed template write.",
    );
  }
}

export function getAgentTemplateLibraryErrorCode(
  error: unknown,
): AgentTemplateLibraryErrorCode | "unknown_error" {
  return error instanceof AgentTemplateLibraryError
    ? error.code
    : "unknown_error";
}

async function ensureFolder(
  vault: AgentTemplateVaultPort,
  path: string,
): Promise<void> {
  const existing = vault.getAbstractFileByPath(path);
  if (existing) {
    if (!isFolder(existing)) {
      throw new AgentTemplateLibraryError(
        "folder_path_conflict",
        "A managed template folder path is occupied by a file.",
      );
    }
    return;
  }

  const adapterEntry = await vault.adapter?.stat(path);
  if (adapterEntry) {
    if (adapterEntry.type !== "folder") {
      throw new AgentTemplateLibraryError(
        "folder_path_conflict",
        "A managed template folder path is occupied by a file.",
      );
    }
    return;
  }

  try {
    await vault.createFolder(path);
  } catch (error) {
    // Obsidian can briefly omit an existing empty folder from its in-memory
    // abstract-file index during cold vault startup. Accept only an adapter-
    // verified folder after an already-exists race; every other failure stays
    // fail-closed.
    const readBack = await vault.adapter?.stat(path).catch(() => null);
    if (readBack?.type === "folder") {
      return;
    }
    throw error;
  }
}

function isFolder(entry: VaultEntryLike): boolean {
  return Array.isArray(entry.children);
}
