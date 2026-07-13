import type {
  ResourceAction,
  ResourceSystem,
  ToolDescriptor,
} from "../agent/actions";
import type { AgentTool } from "./types";

const VAULT_READS = new Set([
  "count_words",
  "find_related_notes",
  "get_note_graph_context",
  "get_path_info",
  "inspect_semantic_index",
  "inspect_vault_context",
  "inspect_vault_index",
  "list_current_folder",
  "list_folder",
  "list_markdown_files",
  "list_templates",
  "prepare_edit_current_section",
  "read_current_file",
  "read_file",
  "read_markdown_files",
  "read_research_memory",
  "read_template",
  "read_design_canvas",
  "read_svg_design",
  "read_mermaid_block",
  "review_research_memory",
  "search_markdown_files",
  "search_research_memory",
  "semantic_search_notes",
  "suggest_note_links",
]);
const WEB_READS = new Set([
  "read_source_section",
  "web_fetch",
  "web_search",
]);
const BROWSER_READS = new Set([
  "browser_extract_markdown",
  "browser_observe",
  "browser_screenshot",
]);
const BROWSER_ACTIONS = new Set([
  "browser_click",
  "browser_keypress",
  "browser_open_page",
  "browser_scroll",
  "browser_type",
]);
const WORKSPACE_READS = new Set([
  "list_workspace_files",
  "preview_workspace_html",
  "read_workspace_file",
]);
const MEMORY_READS = new Set(["memory_search"]);
const CREATE_TOOLS = new Set([
  "create_design_canvas",
  "create_design_package",
  "create_file",
  "create_folder",
  "create_research_pack",
  "create_svg_design",
  "create_template",
  "export_workspace_artifact",
  "fill_template",
  "open_web_source",
  "seed_default_templates",
]);
const APPEND_TOOLS = new Set([
  "append_file",
  "append_research_memory",
  "append_to_current_file",
  "append_to_current_section",
  "memory_write_observation",
  "memory_write_procedural",
  "memory_write_source",
  "memory_write_task_summary",
]);
const UPDATE_TOOLS = new Set([
  "compact_research_memory",
  "edit_current_section",
  "highlight_current_file_phrase",
  "link_related_notes_in_current_file",
  "rebuild_semantic_index",
  "rename_current_file",
  "replace_workspace_text",
  "retitle_current_file",
  "update_design_canvas",
  "update_svg_design",
  "upsert_mermaid_block",
  "write_workspace_file",
]);
const REPLACE_TOOLS = new Set(["replace_current_file", "replace_file"]);
const MOVE_TOOLS = new Set(["move_path"]);
const RESTORE_TOOLS = new Set(["restore_current_file_from_backup"]);
const DELETE_TOOLS = new Set([
  "delete_current_file",
  "delete_path",
  "delete_research_memory_entry",
]);
const EXECUTE_TOOLS = new Set(["render_html_preview", "run_code_block"]);
const INSTALL_TOOLS = new Set(["install_code_dependency"]);

/**
 * Adds explicit metadata to the legacy tool catalog. Unknown names throw so a
 * newly registered tool cannot silently inherit read or mutation authority.
 */
export function withExplicitToolDescriptor(tool: AgentTool): AgentTool {
  if (tool.descriptor) {
    return tool;
  }
  return { ...tool, descriptor: descriptorFor(tool.name) };
}

export function descriptorFor(toolName: string): ToolDescriptor {
  if (VAULT_READS.has(toolName)) {
    return readDescriptor(toolName, "vault", "markdown");
  }
  if (WEB_READS.has(toolName)) {
    return readDescriptor(toolName, "web", "source");
  }
  if (BROWSER_READS.has(toolName)) {
    return readDescriptor(toolName, "browser", "page", false);
  }
  if (BROWSER_ACTIONS.has(toolName)) {
    return legacyActionDescriptor(toolName, "browser", "page", "execute", {
      effect: "execution",
      risk: toolName === "browser_type" || toolName === "browser_click" ? "medium" : "low",
      journal: false,
      receipt: false,
    });
  }
  if (WORKSPACE_READS.has(toolName)) {
    return readDescriptor(toolName, "workspace", "file");
  }
  if (MEMORY_READS.has(toolName)) {
    return readDescriptor(toolName, "workspace", "memory");
  }
  if (CREATE_TOOLS.has(toolName)) {
    return legacyMutationDescriptor(toolName, "create");
  }
  if (APPEND_TOOLS.has(toolName)) {
    return legacyMutationDescriptor(toolName, "append");
  }
  if (UPDATE_TOOLS.has(toolName)) {
    return legacyMutationDescriptor(
      toolName,
      toolName === "link_related_notes_in_current_file" ? "link" : "update",
    );
  }
  if (REPLACE_TOOLS.has(toolName)) {
    return legacyActionDescriptor(toolName, "vault", "markdown", "replace", {
      effect: "reversible_mutation",
      risk: "high",
      journal: true,
      receipt: true,
      approvalFallback: "exact",
      preparation: "required",
    });
  }
  if (MOVE_TOOLS.has(toolName)) {
    return legacyMutationDescriptor(toolName, "move", "medium");
  }
  if (RESTORE_TOOLS.has(toolName)) {
    return legacyMutationDescriptor(toolName, "restore", "medium");
  }
  if (DELETE_TOOLS.has(toolName)) {
    return legacyActionDescriptor(toolName, "vault", "markdown", "delete", {
      effect: "destructive_mutation",
      risk: "critical",
      journal: true,
      receipt: true,
      approvalFallback: "double_exact",
      preparation: "required",
    });
  }
  if (EXECUTE_TOOLS.has(toolName)) {
    return legacyActionDescriptor(toolName, "workspace", "process", "execute", {
      effect: "execution",
      risk: "medium",
      journal: false,
      receipt: true,
      desktopOnly: true,
    });
  }
  if (INSTALL_TOOLS.has(toolName)) {
    return legacyActionDescriptor(toolName, "workspace", "dependency", "install", {
      effect: "execution",
      risk: "critical",
      journal: true,
      receipt: true,
      desktopOnly: true,
      approvalFallback: "exact",
    });
  }
  throw new TypeError(`Missing explicit tool descriptor: ${toolName}`);
}

function readDescriptor(
  name: string,
  system: ResourceSystem,
  resourceType: string,
  cacheable = true,
): ToolDescriptor {
  return {
    version: 1,
    name,
    capability: { system, resourceType, action: "read" },
    effect: "read",
    risk: "low",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: true,
      fallback: "none",
    },
    execution: {
      preparation: "none",
      cacheable,
      parallelSafe: true,
    },
    durability: {
      journal: false,
      receipt: false,
      readback: "none",
      reconciliation: "none",
    },
    allowedPrincipals: ["single_agent", "lead", "researcher"],
  };
}

function legacyMutationDescriptor(
  name: string,
  action: ResourceAction,
  risk: ToolDescriptor["risk"] = "medium",
): ToolDescriptor {
  const system: ResourceSystem =
    name.includes("workspace") || name.includes("design")
      ? "workspace"
      : "vault";
  return legacyActionDescriptor(name, system, "markdown", action, {
    effect: "reversible_mutation",
    risk,
    journal: true,
    receipt: true,
  });
}

function legacyActionDescriptor(
  name: string,
  system: ResourceSystem,
  resourceType: string,
  action: ResourceAction,
  options: {
    effect: ToolDescriptor["effect"];
    risk: ToolDescriptor["risk"];
    journal: boolean;
    receipt: boolean;
    desktopOnly?: boolean;
    approvalFallback?: ToolDescriptor["approval"]["fallback"];
    preparation?: ToolDescriptor["execution"]["preparation"];
  },
): ToolDescriptor {
  return {
    version: 1,
    name,
    capability: { system, resourceType, action },
    effect: options.effect,
    risk: options.risk,
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: options.effect !== "destructive_mutation",
      fallback: options.approvalFallback ?? "exact",
    },
    execution: {
      // Destructive replace/delete vault tools require side-effect-free prepare.
      // Other legacy mutations stay optional until each gains a prepare hook.
      preparation: options.preparation ?? "optional",
      desktopOnly: options.desktopOnly,
      cacheable: false,
      parallelSafe: false,
    },
    durability: {
      journal: options.journal,
      receipt: options.receipt,
      readback: options.receipt ? "optional" : "none",
      reconciliation: options.journal ? "optional" : "none",
    },
    allowedPrincipals: ["single_agent", "lead"],
    receiptKind:
      system === "vault"
        ? "vault_write"
        : system === "workspace"
          ? "artifact"
          : undefined,
  };
}
