import { buildVaultMetadataIndex } from "../memory/vaultIndex";
import type { AgentTool } from "./types";
import {
  getOptionalBoolean,
  getOptionalInteger,
  getOptionalString,
} from "./validation";

export function createVaultIndexTools(): AgentTool[] {
  return [inspectVaultIndexTool];
}

export const inspectVaultIndexTool: AgentTool = {
  name: "inspect_vault_index",
  description:
    "Inspect a metadata-only index of markdown files, headings, tags, and links without reading note bodies.",
  parameters: {
    type: "object",
    properties: {
      folder: {
        type: "string",
        description: "Optional vault-relative folder prefix to inspect.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of files to return. Defaults to 300, maximum 1000.",
      },
      includeNonMarkdown: {
        type: "boolean",
        description: "Include non-markdown files as metadata-only entries.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const limit = clampLimit(getOptionalInteger(args, "limit"));
    const folder = getOptionalString(args, "folder");
    const includeNonMarkdown = getOptionalBoolean(args, "includeNonMarkdown") ?? false;
    const index = buildVaultMetadataIndex(context, {
      folder,
      limit,
      includeNonMarkdown,
    });

    return {
      operation: "inspect_vault_index",
      entryCount: index.files.length,
      limit: index.limit,
      folder,
      includeNonMarkdown,
      files: index.files,
      truncated: index.truncated,
      metadataOnly: true,
    };
  },
};

function clampLimit(value: number | undefined): number {
  if (value === undefined) {
    return 300;
  }

  return Math.min(Math.max(value, 1), 1000);
}
