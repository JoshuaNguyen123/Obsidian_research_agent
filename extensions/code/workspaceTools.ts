import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import type {
  ActionReceiptV1,
  ExtensionToolContributionV1,
  ExtensionToolV1,
  JsonSchemaObjectV1,
  JsonValueV1,
  PreparedActionV1,
  PreparedActionResultV1,
  ResourceActionV1,
  ScopedExtensionContextV1,
  ToolDescriptorV1,
} from "../../packages/core-api/src";
import {
  WorkspaceManagerErrorV2,
  WorkspaceManagerV2,
  assertWorkspaceRelativePathV2,
  isSha256FingerprintV2,
  type WorkspaceManifestV2,
  type WorkspaceMutationReceiptV2,
} from "./workspaces";
import {
  classifyProtectedControlChangesV2,
  type RepositoryFileChangeV2,
  type RepositoryProfileV2,
} from "./repositories";
import { canonicalJson } from "../../packages/headless-runtime/src/canonicalize";
import {
  CODE_CREATION_LANGUAGE_SUMMARY_V1,
  detectCodeCreationLanguageV1,
} from "./CodeCreationLanguagesV1";
import {
  buildJupyterNotebookV1,
  flattenNotebookCellsToPlainContentV1,
  validateJupyterNotebookContentV1,
} from "./JupyterNotebookV1";

export const CODE_WORKSPACE_TOOL_NAMES_V2 = [
  "code_workspace_create",
  "code_workspace_status",
  "code_workspace_stat",
  "code_workspace_list",
  "code_workspace_read",
  "code_workspace_search",
  "code_workspace_mkdir",
  "code_workspace_create_file",
  "code_workspace_export_directory",
  "code_workspace_append",
  "code_workspace_write_expected",
  "code_workspace_patch",
  "code_workspace_move",
  "code_workspace_copy",
  "code_workspace_trash",
  "code_workspace_restore",
  "write_workspace_file",
  "read_workspace_file",
  "list_workspace_files",
  "replace_workspace_text",
  "preview_workspace_html",
  "export_workspace_artifact",
] as const;

type CodeWorkspaceToolNameV2 = typeof CODE_WORKSPACE_TOOL_NAMES_V2[number];
const HOST_EXPORT_MAX_ENTRIES_V2 = 200;
const HOST_EXPORT_MAX_BYTES_V2 = 10 * 1024 * 1024;

interface WorkspaceDirectoryExportEntryV2 {
  path: string;
  kind: "file" | "directory";
  bytes: number;
  sha256: string | null;
}

interface WorkspaceDirectoryExportSnapshotV2 {
  sourcePath: string;
  entries: WorkspaceDirectoryExportEntryV2[];
  files: number;
  directories: number;
  bytes: number;
  fingerprint: string;
}

export interface RepositoryInspectionV2 {
  repositoryRoot: string;
  baseSha: string;
  branch: string;
  clean: boolean;
}

export interface RepositoryWorktreeProvisionV2 extends RepositoryInspectionV2 {
  worktreeRoot: string;
  profileKey: string;
  bindingFingerprint: string;
}

export interface WorkspaceRepositoryProvisionerV2 {
  resolveProfile?(profileKey: string, context: ScopedExtensionContextV1): Promise<string | null>;
  resolveProfileContract?(profileKey: string, context: ScopedExtensionContextV1): Promise<RepositoryProfileV2 | null>;
  resolveProfileByRoot?(repositoryRoot: string, context: ScopedExtensionContextV1): Promise<RepositoryProfileV2 | null>;
  redetectProfile?(profileKey: string, workspaceId: string, context: ScopedExtensionContextV1): Promise<void>;
  inspect(repositoryRoot: string, context: ScopedExtensionContextV1): Promise<RepositoryInspectionV2>;
  provision(input: {
    workspaceId: string;
    profileKey: string;
    inspection: RepositoryInspectionV2;
    context: ScopedExtensionContextV1;
  }): Promise<RepositoryWorktreeProvisionV2>;
}

export interface CodeWorkspaceToolFactoryOptionsV2 {
  manager: WorkspaceManagerV2;
  repositoryProvisioner?: WorkspaceRepositoryProvisionerV2;
  isForegroundUserMission?: (
    repositoryRoot: string,
    context: ScopedExtensionContextV1,
  ) => boolean;
  resolveKnownHostDirectory?: (
    directory: KnownHostDirectoryV2,
    context: ScopedExtensionContextV1,
  ) => Promise<string>;
}

export type KnownHostDirectoryV2 =
  | "desktop"
  | "documents"
  | "downloads"
  | "vault_sibling_projects";

export function createCodeWorkspaceToolContributionsV2(
  options: CodeWorkspaceToolFactoryOptionsV2,
): ExtensionToolContributionV1[] {
  const runtime = new WorkspaceToolRuntimeV2(
    options.manager,
    options.repositoryProvisioner ?? new LocalGitWorkspaceProvisionerV2(options.manager),
    options.isForegroundUserMission ?? ((root, context) => Boolean(
      context.originalPrompt && context.originalPrompt.includes(root),
    )),
    options.resolveKnownHostDirectory ?? ((directory) =>
      resolveKnownHostDirectoryV2(directory)),
  );
  return CODE_WORKSPACE_TOOL_NAMES_V2.map((name) => contribution(name, runtime));
}

class WorkspaceToolRuntimeV2 {
  private readonly leases = new Map<string, string>();

  constructor(
    private readonly manager: WorkspaceManagerV2,
    private readonly repositories: WorkspaceRepositoryProvisionerV2,
    private readonly isForegroundUserMission: (
      repositoryRoot: string,
      context: ScopedExtensionContextV1,
    ) => boolean,
    private readonly resolveKnownHostDirectory: (
      directory: KnownHostDirectoryV2,
      context: ScopedExtensionContextV1,
    ) => Promise<string>,
  ) {}

  async execute(
    name: CodeWorkspaceToolNameV2,
    args: Record<string, unknown>,
    context: ScopedExtensionContextV1,
  ): Promise<unknown> {
    context.reportProgress(`Workspace tool ${name}.`);
    if (!isReadWorkspaceTool(name)) throw preparationRequired(name);
    const workspaceId = workspaceIdFrom(args, context);
    if (name === "code_workspace_status") return this.manager.status(workspaceId);
    if (name === "code_workspace_stat") return this.manager.stat(workspaceId, requiredPath(args, "path"));
    if (name === "code_workspace_list" || name === "list_workspace_files") {
      return this.manager.list(workspaceId, optionalString(args.path) ?? "");
    }
    if (name === "code_workspace_read" || name === "read_workspace_file") {
      return this.manager.read(workspaceId, requiredPath(args, "path"));
    }
    if (name === "code_workspace_search") {
      return this.manager.search(workspaceId, requiredString(args.query, "query"), {
        path: optionalString(args.path) ?? undefined,
        caseSensitive: args.caseSensitive === true,
        limit: optionalInteger(args.limit),
      });
    }
    if (name === "preview_workspace_html") {
      const htmlPath = requiredPath(args, "htmlPath");
      const html = await this.manager.read(workspaceId, htmlPath);
      if (!/\.html?$/iu.test(htmlPath)) throw new WorkspaceManagerErrorV2("preview_type_blocked", "HTML preview accepts .html files only.");
      const cssPath = optionalString(args.cssPath);
      const css = cssPath ? await this.manager.read(workspaceId, assertWorkspaceRelativePathV2(cssPath)) : null;
      return {
        operation: "preview_workspace_html",
        workspaceId,
        html,
        css,
        execution: "blocked",
        sandbox: "readback_only",
      };
    }
    if (name === "export_workspace_artifact") {
      const artifactPath = requiredPath(args, "workspacePath", "path");
      const read = await this.manager.read(workspaceId, artifactPath);
      return {
        operation: "export_workspace_artifact",
        workspaceId,
        artifact: {
          kind: "workspace_text_readback",
          path: read.path,
          sha256: read.sha256,
          bytes: read.bytes,
          content: read.content,
        },
      };
    }
    throw new WorkspaceManagerErrorV2("unknown_workspace_tool", `Unsupported workspace tool: ${name}.`);
  }

  async prepare(
    name: CodeWorkspaceToolNameV2,
    args: Record<string, unknown>,
    context: ScopedExtensionContextV1,
  ): Promise<PreparedActionResultV1> {
    try {
      if (name === "code_workspace_create") {
        const repository = optionalString(args.kind) === "repository" || Boolean(args.repositoryProfileKey) || Boolean(args.repositoryRoot);
        return {
          ok: true,
          action: repository
            ? await this.prepareRepositoryCreate(args, context)
            : await this.prepareScratchCreate(args, context),
        };
      }
      if (isReadWorkspaceTool(name)) {
        return { ok: false, error: { code: "preparation_not_required", message: `${name} executes directly with readback.` } };
      }
      if (name === "code_workspace_export_directory") {
        return {
          ok: true,
          action: await this.prepareDirectoryExport(args, context),
        };
      }
      const workspaceId = workspaceIdFrom(args, context);
      const leaseId = await this.ensureLease(workspaceId, context);
      const ownerRunId = runId(context);
      const leaseOwnerId = `extension:${ownerRunId}`;
      const manifest = await this.assertBoundWorkspace(workspaceId, ownerRunId, leaseId, leaseOwnerId);
      const normalizedArgs: Record<string, JsonValueV1> = {
        workspaceId,
        leaseId,
        leaseOwnerId,
        ownerRunId,
      };
      let targetPath: string;
      let expected: string;
      let summary: string;
      let outboundBytes = 0;
      let action: ResourceActionV1 = "update";

      if (name === "code_workspace_restore") {
        const trashId = requiredString(args.trashId, "trashId");
        const trash = await this.manager.inspectTrash(workspaceId, trashId);
        targetPath = trash.originalPath;
        await assertMissing(this.manager, workspaceId, targetPath);
        expected = trash.fingerprint;
        normalizedArgs.trashId = trashId;
        normalizedArgs.expectedTrashFingerprint = expected;
        normalizedArgs.expectedTargetState = "absent";
        normalizedArgs.payloadBytes = 0;
        summary = `Restore ${targetPath} from workspace trash ${trashId}.`;
        action = "restore";
      } else {
        targetPath = requiredPath(args, "path", "sourcePath");
        normalizedArgs.path = targetPath;
        if (name === "code_workspace_mkdir") {
          const current = await statOrMissing(this.manager, workspaceId, targetPath);
          if (current && current.kind !== "directory") {
            throw new WorkspaceManagerErrorV2("path_conflict", `${targetPath} is not a directory.`);
          }
          expected = current?.sha256 ?? absentFingerprint(workspaceId, targetPath);
          normalizedArgs.expectedTargetState = current ? "existing" : "absent";
          normalizedArgs.expectedSha256 = current?.sha256 ?? null;
          normalizedArgs.expectedKind = "directory";
          normalizedArgs.payloadBytes = 0;
          summary = current
            ? `Confirm existing directory ${targetPath} only if its fingerprint remains ${expected}.`
            : `Create directory ${targetPath} only while the target remains absent.`;
          action = "create";
        } else if (name === "code_workspace_create_file") {
          // A retried mission may find debris from its own prior run at the
          // prepared path. Mirror the mkdir confirm-existing pattern only for
          // byte-identical content. Differing content remains a hard collision:
          // the model must read it and request a separate hash-bound
          // write_expected operation, so create never becomes an overwrite.
          const current = await statOrMissing(this.manager, workspaceId, targetPath);
          const resolvedContent = resolveCreateFileContentV1(args, targetPath);
          const content = resolvedContent.content;
          const sourceLanguage = detectCodeCreationLanguageV1(targetPath);
          const incomingSha256 = sha256Text(content);
          if (sourceLanguage) normalizedArgs.creationLanguage = sourceLanguage.id;
          if (resolvedContent.notebookMetadata)
            normalizedArgs.notebookMetadata = resolvedContent.notebookMetadata;
          if (current && current.sha256 === incomingSha256) {
            expected = current.sha256;
            normalizedArgs.expectedTargetState = "existing";
            normalizedArgs.expectedSha256 = current.sha256;
            normalizedArgs.expectedKind = "file";
            normalizedArgs.expectedAfterSha256 = current.sha256;
            normalizedArgs.payloadBytes = 0;
            summary = `Confirm existing identical file ${targetPath} only if its fingerprint remains ${expected}.`;
          } else if (current) {
            const collision =
              current.kind === "file"
                ? "already exists with different content"
                : `already exists as ${current.kind}`;
            throw new WorkspaceManagerErrorV2(
              "path_exists",
              `${targetPath} ${collision} (${current.sha256.replace("sha256:", "sha256 ")}). ` +
                `Read it with code_workspace_read, then update it with code_workspace_write_expected ` +
                `using expectedSha256=${current.sha256}.`,
            );
          } else {
            outboundBytes = byteLength(content);
            expected = absentFingerprint(workspaceId, targetPath);
            normalizedArgs.expectedTargetState = "absent";
            normalizedArgs.expectedSha256 = null;
            normalizedArgs.content = content;
            normalizedArgs.expectedAfterSha256 = incomingSha256;
            normalizedArgs.payloadBytes = outboundBytes;
            summary = `Create ${sourceLanguage ? `${sourceLanguage.displayName} source file ` : ""}${targetPath} without overwrite while the target remains absent.`;
          }
          action = "create";
        } else if (name === "code_workspace_append") {
          const stat = await this.manager.stat(workspaceId, targetPath);
          if (stat.kind !== "file") throw new WorkspaceManagerErrorV2("path_conflict", `${targetPath} is not a regular file.`);
          expected = stat.sha256;
          assertRequestedFingerprint(args.expectedSha256, expected);
          const content = requiredString(args.content, "content", true);
          outboundBytes = byteLength(content);
          normalizedArgs.expectedTargetState = "existing";
          normalizedArgs.expectedKind = "file";
          normalizedArgs.expectedSha256 = expected;
          normalizedArgs.content = content;
          const current = await this.manager.read(workspaceId, targetPath);
          normalizedArgs.expectedAfterSha256 = sha256Text(`${current.content}${content}`);
          normalizedArgs.payloadBytes = outboundBytes;
          summary = `Append ${outboundBytes} byte(s) to ${targetPath} only if SHA-256 remains ${expected}.`;
          action = "append";
        } else if (name === "code_workspace_write_expected" || name === "write_workspace_file") {
          const content = requiredString(args.content, "content", true);
          const sourceLanguage = detectCodeCreationLanguageV1(targetPath);
          normalizedArgs.content = content;
          if (sourceLanguage) normalizedArgs.creationLanguage = sourceLanguage.id;
          normalizedArgs.expectedAfterSha256 = sha256Text(content);
          outboundBytes = byteLength(content);
          normalizedArgs.payloadBytes = outboundBytes;
          const current = await statOrMissing(this.manager, workspaceId, targetPath);
          if (!current && name !== "write_workspace_file") {
            throw new WorkspaceManagerErrorV2("path_not_found", `${targetPath} does not exist.`);
          }
          if (current && current.kind !== "file") {
            throw new WorkspaceManagerErrorV2("path_conflict", `${targetPath} is not a regular file.`);
          }
          if (current) {
            expected = current.sha256;
            assertRequestedFingerprint(args.expectedSha256, expected);
            normalizedArgs.expectedTargetState = "existing";
            normalizedArgs.expectedKind = "file";
            normalizedArgs.expectedSha256 = expected;
            normalizedArgs.mutationMode = "replace";
            summary = `Replace ${targetPath} only if SHA-256 remains ${expected}.`;
            action = "replace";
          } else {
            expected = absentFingerprint(workspaceId, targetPath);
            normalizedArgs.expectedTargetState = "absent";
            normalizedArgs.expectedSha256 = null;
            normalizedArgs.mutationMode = "create";
            summary = `Create ${targetPath} without overwrite while the target remains absent.`;
            action = "create";
          }
        } else if (name === "code_workspace_patch") {
          const stat = await statOrMissing(this.manager, workspaceId, targetPath);
          if (!stat) {
            throw new WorkspaceManagerErrorV2(
              "path_not_found",
              `${targetPath} does not exist. Use code_workspace_create_file with the complete new-file content; patches only update an existing hash-bound file.`,
            );
          }
          if (stat.kind !== "file") throw new WorkspaceManagerErrorV2("path_conflict", `${targetPath} is not a regular file.`);
          expected = stat.sha256;
          assertRequestedFingerprint(args.expectedSha256, expected);
          const replacements = parseReplacements(args.replacements);
          normalizedArgs.replacements = replacements;
          const current = await this.manager.read(workspaceId, targetPath);
          normalizedArgs.expectedAfterSha256 = sha256Text(applyExactReplacements(current.content, replacements));
          outboundBytes = byteLength(JSON.stringify(replacements));
          normalizedArgs.expectedTargetState = "existing";
          normalizedArgs.expectedKind = "file";
          normalizedArgs.expectedSha256 = expected;
          normalizedArgs.payloadBytes = outboundBytes;
          summary = `Apply ${replacements.length} exact replacement(s) to ${targetPath}.`;
          action = "update";
        } else if (name === "replace_workspace_text") {
          const stat = await this.manager.stat(workspaceId, targetPath);
          if (stat.kind !== "file") throw new WorkspaceManagerErrorV2("path_conflict", `${targetPath} is not a regular file.`);
          expected = stat.sha256;
          const find = requiredString(args.find, "find");
          const replace = requiredString(args.replace, "replace", true);
          normalizedArgs.find = find;
          normalizedArgs.replace = replace;
          normalizedArgs.replaceAll = args.replaceAll === true;
          const current = await this.manager.read(workspaceId, targetPath);
          normalizedArgs.expectedAfterSha256 = sha256Text(args.replaceAll === true
            ? current.content.split(find).join(replace)
            : current.content.replace(find, replace));
          outboundBytes = byteLength(replace);
          normalizedArgs.expectedTargetState = "existing";
          normalizedArgs.expectedKind = "file";
          normalizedArgs.expectedSha256 = expected;
          normalizedArgs.payloadBytes = outboundBytes;
          summary = `Replace ${args.replaceAll === true ? "all" : "one"} exact text match(es) in ${targetPath}.`;
          action = "replace";
        } else if (name === "code_workspace_move") {
          const stat = await this.manager.stat(workspaceId, targetPath);
          expected = stat.sha256;
          assertRequestedFingerprint(args.expectedSha256, expected);
          const destinationPath = requiredPath(args, "destinationPath", "toPath");
          await assertMissing(this.manager, workspaceId, destinationPath);
          normalizedArgs.expectedTargetState = "existing";
          normalizedArgs.expectedKind = stat.kind;
          normalizedArgs.expectedSha256 = expected;
          normalizedArgs.destinationPath = destinationPath;
          normalizedArgs.expectedAfterSha256 = expected;
          normalizedArgs.mutationMode = "move";
          normalizedArgs.expectedDestinationState = "absent";
          normalizedArgs.payloadBytes = 0;
          summary = `Move ${targetPath} to ${destinationPath} without overwrite.`;
          action = "move";
        } else if (name === "code_workspace_copy") {
          const stat = await this.manager.stat(workspaceId, targetPath);
          expected = stat.sha256;
          assertRequestedFingerprint(args.expectedSha256, expected);
          const destinationPath = requiredPath(args, "destinationPath", "toPath");
          await assertMissing(this.manager, workspaceId, destinationPath);
          normalizedArgs.expectedTargetState = "existing";
          normalizedArgs.expectedKind = stat.kind;
          normalizedArgs.expectedSha256 = expected;
          normalizedArgs.destinationPath = destinationPath;
          normalizedArgs.expectedAfterSha256 = expected;
          normalizedArgs.mutationMode = "copy";
          normalizedArgs.expectedDestinationState = "absent";
          normalizedArgs.payloadBytes = 0;
          summary = `Copy ${targetPath} to ${destinationPath} without overwrite.`;
          action = "create";
        } else if (name === "code_workspace_trash") {
          const stat = await this.manager.stat(workspaceId, targetPath);
          expected = stat.sha256;
          assertRequestedFingerprint(args.expectedSha256, expected);
          normalizedArgs.expectedTargetState = "existing";
          normalizedArgs.expectedKind = stat.kind;
          normalizedArgs.expectedSha256 = expected;
          normalizedArgs.expectedAfterSha256 = null;
          normalizedArgs.payloadBytes = 0;
          summary = `Move ${targetPath} to durable workspace trash.`;
          action = "trash";
        } else {
          throw new WorkspaceManagerErrorV2("unsupported_prepare", `${name} has no prepared mutation contract.`);
        }
      }
      let requiredConfirmations: 1 | 2 = 1;
      const warnings: string[] = [];
      if (manifest.kind === "repository" && manifest.repositoryBinding) {
        const profile = await this.repositories.resolveProfileContract?.(manifest.repositoryBinding.profileKey, context);
        if (!profile) throw new WorkspaceManagerErrorV2("repository_profile_unavailable", "Repository mutation requires its trusted RepositoryProfileV2.");
        const changes = mutationChanges(targetPath, normalizedArgs);
        const repositoryScope = resolveRepositoryMutationScopeV2(profile, changes);
        normalizedArgs.repositoryScopeFingerprint = repositoryScope.fingerprint;
        normalizedArgs.repositoryScopeBindings = repositoryScope.bindings;
        const classification = classifyProtectedControlChangesV2(profile, changes);
        if (classification.level === "blocked") {
          throw new WorkspaceManagerErrorV2("repository_control_blocked", `Repository controls block: ${classification.blockedPaths.join(", ")}.`);
        }
        normalizedArgs.protectedClassificationFingerprint = classification.exactDiffFingerprint;
        normalizedArgs.repositoryProfileKey = profile.key;
        if (classification.level !== "none") {
          requiredConfirmations = classification.level === "double_exact" ? 2 : 1;
          normalizedArgs.requiresProfileRedetection = true;
          warnings.push(`${classification.matchedControls.length} protected repository control(s) require ${requiredConfirmations === 2 ? "double-exact" : "exact-diff"} approval and profile re-detection.`);
        }
      }
      return {
        ok: true,
        action: preparedAction({
          name,
          context,
          workspaceId,
          targetPath,
          normalizedArgs,
          expected,
          summary,
          action,
          outboundBytes,
          requiredConfirmations,
          warnings,
          repositoryProfileId: manifest.repositoryBinding?.profileKey,
        }),
      };
    } catch (error) {
      return { ok: false, error: toolError(error) };
    }
  }

  async executePrepared(
    name: CodeWorkspaceToolNameV2,
    action: PreparedActionV1,
    context: ScopedExtensionContextV1,
  ): Promise<{ output?: unknown; receipt: ActionReceiptV1; mutationState: "applied" }> {
    validatePreparedAction(name, action, context);
    if (name === "code_workspace_create") {
      return action.normalizedArgs.kind === "scratch"
        ? this.executePreparedScratchCreate(action, context)
        : this.executePreparedRepositoryCreate(action, context);
    }
    if (name === "code_workspace_export_directory") {
      return this.executePreparedDirectoryExport(action, context);
    }
    const args = action.normalizedArgs;
    const workspaceId = requiredString(args.workspaceId, "workspaceId");
    const leaseId = requiredString(args.leaseId, "leaseId");
    const targetPath = requiredString(action.target.path, "target path");
    const ownerRunId = requiredString(args.ownerRunId, "ownerRunId");
    const leaseOwnerId = requiredString(args.leaseOwnerId, "leaseOwnerId");
    if (ownerRunId !== runId(context) || action.target.workspaceId !== workspaceId) {
      throw new WorkspaceManagerErrorV2("prepared_binding_drift", "Prepared workspace owner or target binding changed.");
    }
    const manifest = await this.assertBoundWorkspace(workspaceId, ownerRunId, leaseId, leaseOwnerId);
    await assertPreparedTargetState(this.manager, workspaceId, targetPath, args);
    const profileKey = optionalString(args.repositoryProfileKey);
    if (profileKey) {
      const profile = await this.repositories.resolveProfileContract?.(profileKey, context);
      if (!profile) throw new WorkspaceManagerErrorV2("repository_profile_unavailable", "Repository mutation lost its trusted RepositoryProfileV2.");
      const changes = mutationChanges(targetPath, args);
      const repositoryScope = resolveRepositoryMutationScopeV2(profile, changes);
      if (
        repositoryScope.fingerprint !==
        requiredFingerprint(args.repositoryScopeFingerprint)
      ) {
        throw new WorkspaceManagerErrorV2(
          "repository_path_scope_drift",
          "Repository project allowedPaths changed after this mutation was prepared; prepare the action again against the current trusted profile.",
        );
      }
      const classification = classifyProtectedControlChangesV2(profile, changes);
      const confirmations = classification.level === "double_exact" ? 2 : 1;
      if (
        classification.level === "blocked" ||
        classification.exactDiffFingerprint !== args.protectedClassificationFingerprint ||
        confirmations !== (action.requiredConfirmations ?? 1)
      ) {
        throw new WorkspaceManagerErrorV2("repository_control_drift", "Repository protected-control classification changed after approval.");
      }
    }
    const destinationPath = optionalString(args.destinationPath);
    if (destinationPath && args.expectedDestinationState === "absent") {
      await assertMissing(this.manager, workspaceId, destinationPath);
    }
    let result: WorkspaceMutationReceiptV2;
    if (name === "code_workspace_mkdir") {
      assertPayloadBytes(args, 0);
      result = await this.manager.mkdir(workspaceId, leaseId, targetPath);
    } else if (name === "code_workspace_create_file") {
      if (args.expectedTargetState === "existing") {
        // Idempotent retry over prior-run debris. assertPreparedTargetState
        // already verified the observed fingerprint still holds. The only
        // legal existing-target action is an identical no-op; differing
        // content must use the separately prepared write_expected tool.
        const expectedBefore = requiredFingerprint(args.expectedSha256);
        const expectedAfter = requiredFingerprint(args.expectedAfterSha256);
        if (expectedAfter !== expectedBefore) {
          throw new WorkspaceManagerErrorV2(
            "precondition_failed",
            "Prepared create-file retry is not byte-identical to the existing target.",
          );
        }
        assertPayloadBytes(args, 0);
        result = await reconciliationMutationReceipt(this.manager, manifest, name, targetPath, undefined, expectedAfter);
      } else {
        const content = requiredString(args.content, "content", true);
        assertPayloadBytes(args, byteLength(content));
        result = await this.manager.createFile(workspaceId, leaseId, targetPath, content);
      }
    } else if (name === "code_workspace_append") {
      const content = requiredString(args.content, "content", true);
      assertPayloadBytes(args, byteLength(content));
      result = await this.manager.appendFile(workspaceId, leaseId, targetPath, content, requiredFingerprint(args.expectedSha256));
    } else if (name === "code_workspace_write_expected" || name === "write_workspace_file") {
      const content = requiredString(args.content, "content", true);
      assertPayloadBytes(args, byteLength(content));
      result = args.mutationMode === "create"
        ? await this.manager.createFile(workspaceId, leaseId, targetPath, content)
        : await this.manager.writeExpected(workspaceId, leaseId, targetPath, content, requiredFingerprint(args.expectedSha256));
    } else if (name === "code_workspace_patch") {
      assertPayloadBytes(args, byteLength(JSON.stringify(parseReplacements(args.replacements))));
      result = await this.manager.patchExact(workspaceId, leaseId, targetPath, requiredFingerprint(args.expectedSha256), parseReplacements(args.replacements));
    } else if (name === "replace_workspace_text") {
      const read = await this.manager.read(workspaceId, targetPath);
      if (read.sha256 !== requiredFingerprint(args.expectedSha256)) throw new WorkspaceManagerErrorV2("precondition_failed", "Legacy replacement precondition changed.");
      const find = requiredString(args.find, "find");
      const replace = requiredString(args.replace, "replace", true);
      assertPayloadBytes(args, byteLength(replace));
      const count = read.content.split(find).length - 1;
      if (count < 1 || (args.replaceAll !== true && count !== 1)) throw new WorkspaceManagerErrorV2("patch_mismatch", "Legacy replacement target count changed.");
      const next = args.replaceAll === true ? read.content.split(find).join(replace) : read.content.replace(find, replace);
      result = await this.manager.writeExpected(workspaceId, leaseId, targetPath, next, read.sha256);
    } else if (name === "code_workspace_move") {
      assertPayloadBytes(args, 0);
      result = await this.manager.move(workspaceId, leaseId, targetPath, requiredString(args.destinationPath, "destinationPath"), requiredFingerprint(args.expectedSha256));
    } else if (name === "code_workspace_copy") {
      assertPayloadBytes(args, 0);
      result = await this.manager.copy(workspaceId, leaseId, targetPath, requiredString(args.destinationPath, "destinationPath"), requiredFingerprint(args.expectedSha256));
    } else if (name === "code_workspace_trash") {
      assertPayloadBytes(args, 0);
      result = await this.manager.trash(workspaceId, leaseId, targetPath, requiredFingerprint(args.expectedSha256));
    } else if (name === "code_workspace_restore") {
      assertPayloadBytes(args, 0);
      result = await this.manager.restore(workspaceId, leaseId, requiredString(args.trashId, "trashId"), requiredFingerprint(args.expectedTrashFingerprint));
    } else throw new WorkspaceManagerErrorV2("unsupported_prepare", `${name} cannot execute a prepared mutation.`);
    if (args.requiresProfileRedetection === true) {
      await this.repositories.redetectProfile?.(
        requiredString(args.repositoryProfileKey, "repositoryProfileKey"),
        workspaceId,
        context,
      );
    }
    return {
      output: mutationOutput(result),
      receipt: actionReceipt(action, context, result),
      mutationState: "applied",
    };
  }

  async reconcile(
    name: CodeWorkspaceToolNameV2,
    action: PreparedActionV1,
    context: ScopedExtensionContextV1,
  ) {
    try {
      const args = action.normalizedArgs;
      const workspaceId = requiredString(args.workspaceId, "workspaceId");
      const ownerRunId = requiredString(args.ownerRunId, "ownerRunId");
      if (name === "code_workspace_export_directory") {
        return this.reconcileDirectoryExport(action, context);
      }
      const manifest = await this.manager.resumeWorkspace(workspaceId, ownerRunId);
      if (name === "code_workspace_create") {
        const fingerprint = args.kind === "repository"
          ? requiredFingerprint(args.bindingFingerprint)
          : sha256Json({ workspaceId, ownerRunId, canonicalRoot: manifest.canonicalRoot, leaseId: manifest.lease?.id ?? null });
        return {
          outcome: "committed" as const,
          message: `Workspace ${workspaceId} exists with its exact durable owner and binding.`,
          receipt: workspaceCreationReceipt(action, reconcileContext(context, action), manifest, fingerprint, `Reconciled workspace creation for ${workspaceId}.`),
        };
      }
      const targetPath = requiredString(action.target.path, "target path");
      const destinationPath = optionalString(args.destinationPath);
      const expectedAfter = optionalString(args.expectedAfterSha256) ?? (name === "code_workspace_restore" ? optionalString(args.expectedTrashFingerprint) : null);
      const target = await statOrMissing(this.manager, workspaceId, destinationPath ?? targetPath);
      let committed = false;
      if (name === "code_workspace_trash") {
        const source = await statOrMissing(this.manager, workspaceId, targetPath);
        const trash = await this.manager.findTrashEvidence(workspaceId, targetPath, requiredFingerprint(args.expectedSha256));
        committed = source === null && trash !== null;
      } else if (name === "code_workspace_mkdir") {
        committed = target?.kind === "directory";
      } else if (name === "code_workspace_move") {
        committed = await statOrMissing(this.manager, workspaceId, targetPath) === null && target?.sha256 === expectedAfter;
      } else {
        committed = target !== null && target.sha256 === expectedAfter;
      }
      if (committed) {
        const synthetic = await reconciliationMutationReceipt(this.manager, manifest, name, targetPath, destinationPath ?? undefined, expectedAfter);
        return {
          outcome: "committed" as const,
          message: `Workspace action ${action.id} was verified by durable manifest and exact artifact readback.`,
          receipt: actionReceipt(action, reconcileContext(context, action), synthetic),
        };
      }
      const before = await statOrMissing(this.manager, workspaceId, targetPath);
      const expectedBefore = optionalString(args.expectedSha256);
      if ((args.expectedTargetState === "absent" && before === null) || (expectedBefore && before?.sha256 === expectedBefore)) {
        return { outcome: "not_applied" as const, message: `Workspace action ${action.id} was not applied; its exact prepared precondition still holds.` };
      }
    } catch (error) {
      if (error instanceof WorkspaceManagerErrorV2 && error.code === "workspace_not_found") {
        return { outcome: "not_applied" as const, message: `Workspace action ${action.id} was not applied because its workspace does not exist.` };
      }
    }
    return { outcome: "still_uncertain" as const, message: `Workspace action ${action.id} could not be proven from exact durable readback; keep it pending.` };
  }

  private async prepareDirectoryExport(
    args: Record<string, unknown>,
    context: ScopedExtensionContextV1,
  ): Promise<PreparedActionV1> {
    const workspaceId = workspaceIdFrom(args, context);
    const ownerRunId = runId(context);
    const leaseId = await this.ensureLease(workspaceId, context);
    const leaseOwnerId = `extension:${ownerRunId}`;
    await this.assertBoundWorkspace(
      workspaceId,
      ownerRunId,
      leaseId,
      leaseOwnerId,
    );
    const destinationRoot = requiredKnownHostDirectory(args.destinationRoot);
    if (!foregroundMissionNamesKnownHostDirectory(destinationRoot, context)) {
      throw new WorkspaceManagerErrorV2(
        "host_directory_authority_missing",
        `Export to ${destinationRoot} requires that exact known directory in the foreground user mission.`,
      );
    }
    const requestedDestinationPath = assertWorkspaceRelativePathV2(
      requiredString(args.destinationPath, "destinationPath"),
      "destinationPath",
    );
    const sourcePathInput = optionalString(args.sourcePath);
    const sourcePath = sourcePathInput
      ? assertWorkspaceRelativePathV2(sourcePathInput, "sourcePath")
      : "";
    const sourceSnapshot = await snapshotWorkspaceDirectoryV2(
      this.manager,
      workspaceId,
      sourcePath,
    );
    const target = await resolveSafeHostExportTargetV2(
      await this.resolveKnownHostDirectory(destinationRoot, context),
      destinationRoot,
      requestedDestinationPath,
    );
    const { root, destinationPath } = target;
    const destination = await inspectHostExportDestinationV2(
      root,
      destinationPath,
    );
    if (destination.exists) {
      throw new WorkspaceManagerErrorV2(
        "host_export_destination_exists",
        `${destination.absolutePath} already exists; directory export never overwrites.`,
      );
    }
    const expected = hostExportAbsentFingerprintV2(
      destinationRoot,
      destinationPath,
      root,
    );
    return preparedAction({
      name: "code_workspace_export_directory",
      context,
      workspaceId,
      targetPath: `${destinationRoot}/${destinationPath}`,
      normalizedArgs: {
        workspaceId,
        ownerRunId,
        leaseId,
        leaseOwnerId,
        sourcePath,
        sourceFingerprint: sourceSnapshot.fingerprint,
        sourceFiles: sourceSnapshot.files,
        sourceDirectories: sourceSnapshot.directories,
        payloadBytes: sourceSnapshot.bytes,
        destinationRoot,
        destinationRootCanonical: root,
        requestedDestinationPath,
        destinationPath,
        expectedTargetState: "absent",
      },
      expected,
      summary:
        `Export ${sourceSnapshot.files} file(s) and ${sourceSnapshot.directories} director` +
        `ies from workspace ${workspaceId} to ${destination.absolutePath} without overwrite.`,
      action: "create",
      outboundBytes: sourceSnapshot.bytes,
      previewDestination: destination.absolutePath,
      targetOverride: {
        system: "workspace",
        resourceType: "host_directory",
        id: `host-directory:${destinationRoot}:${destinationPath}`,
        workspaceId,
        path: destination.absolutePath,
      },
      relatedResources: [
        workspaceResource(
          workspaceId,
          sourcePath || ".",
          "code_workspace",
        ),
      ],
      warnings: [
        destinationRoot === "vault_sibling_projects"
          ? "This creates a real project beside the Obsidian vault, outside vault indexing, in the exact approved destination."
          : "This creates files outside the Obsidian vault in the exact approved known-directory destination.",
        "The destination must remain absent; existing files or directories are never overwritten.",
      ],
    });
  }

  private async executePreparedDirectoryExport(
    action: PreparedActionV1,
    context: ScopedExtensionContextV1,
  ): Promise<{
    output?: unknown;
    receipt: ActionReceiptV1;
    mutationState: "applied";
  }> {
    const args = action.normalizedArgs;
    const workspaceId = requiredString(args.workspaceId, "workspaceId");
    const ownerRunId = requiredString(args.ownerRunId, "ownerRunId");
    const leaseId = requiredString(args.leaseId, "leaseId");
    const leaseOwnerId = requiredString(args.leaseOwnerId, "leaseOwnerId");
    await this.assertBoundWorkspace(
      workspaceId,
      ownerRunId,
      leaseId,
      leaseOwnerId,
    );
    const destinationRoot = requiredKnownHostDirectory(args.destinationRoot);
    const target = await resolveSafeHostExportTargetV2(
      await this.resolveKnownHostDirectory(destinationRoot, context),
      destinationRoot,
      requiredString(
        args.requestedDestinationPath ?? args.destinationPath,
        "requestedDestinationPath",
      ),
    );
    const { root, destinationPath } = target;
    const expectedRoot = requiredString(
      args.destinationRootCanonical,
      "destinationRootCanonical",
    );
    if (!samePath(root, expectedRoot)) {
      throw new WorkspaceManagerErrorV2(
        "host_directory_binding_drift",
        "The known host directory changed after approval.",
      );
    }
    if (
      destinationPath !==
      assertWorkspaceRelativePathV2(
        requiredString(args.destinationPath, "destinationPath"),
        "destinationPath",
      )
    ) {
      throw new WorkspaceManagerErrorV2(
        "host_directory_binding_drift",
        "The resolved host export destination changed after approval.",
      );
    }
    const destination = await inspectHostExportDestinationV2(
      root,
      destinationPath,
    );
    if (destination.exists) {
      throw new WorkspaceManagerErrorV2(
        "host_export_destination_exists",
        "The approved host export destination is no longer absent.",
      );
    }
    if (!samePath(action.target.path ?? "", destination.absolutePath)) {
      throw new WorkspaceManagerErrorV2(
        "prepared_binding_drift",
        "Prepared host export destination changed.",
      );
    }
    const sourcePath = optionalString(args.sourcePath) ?? "";
    const sourceSnapshot = await snapshotWorkspaceDirectoryV2(
      this.manager,
      workspaceId,
      sourcePath,
    );
    if (
      sourceSnapshot.fingerprint !==
        requiredFingerprint(args.sourceFingerprint) ||
      sourceSnapshot.bytes !== args.payloadBytes ||
      sourceSnapshot.files !== args.sourceFiles ||
      sourceSnapshot.directories !== args.sourceDirectories
    ) {
      throw new WorkspaceManagerErrorV2(
        "host_export_source_drift",
        "Workspace export source changed after approval.",
      );
    }
    const exported = await exportWorkspaceSnapshotToHostV2({
      manager: this.manager,
      workspaceId,
      snapshot: sourceSnapshot,
      root,
      destinationPath,
    });
    if (exported.fingerprint !== sourceSnapshot.fingerprint) {
      throw new WorkspaceManagerErrorV2(
        "host_export_readback_failed",
        "Exported directory failed exact tree readback.",
      );
    }
    const receipt = hostDirectoryExportReceiptV2({
      action,
      context,
      destinationPath: exported.absolutePath,
      snapshot: exported,
      commitKind: "committed",
    });
    return {
      output: {
        status: "ok",
        operation: "export_directory",
        workspaceId,
        sourcePath,
        destinationRoot,
        destinationPath: exported.absolutePath,
        files: exported.files,
        directories: exported.directories,
        bytesWritten: exported.bytes,
        fingerprint: exported.fingerprint,
      },
      receipt,
      mutationState: "applied",
    };
  }

  private async reconcileDirectoryExport(
    action: PreparedActionV1,
    context: ScopedExtensionContextV1,
  ) {
    const args = action.normalizedArgs;
    const destinationRoot = requiredKnownHostDirectory(args.destinationRoot);
    const target = await resolveSafeHostExportTargetV2(
      await this.resolveKnownHostDirectory(destinationRoot, context),
      destinationRoot,
      requiredString(
        args.requestedDestinationPath ?? args.destinationPath,
        "requestedDestinationPath",
      ),
    );
    const { root, destinationPath } = target;
    if (
      !samePath(
        root,
        requiredString(
          args.destinationRootCanonical,
          "destinationRootCanonical",
        ),
      )
    ) {
      return {
        outcome: "still_uncertain" as const,
        message: "Known host directory binding changed after preparation.",
      };
    }
    if (
      destinationPath !==
      assertWorkspaceRelativePathV2(
        requiredString(args.destinationPath, "destinationPath"),
        "destinationPath",
      )
    ) {
      return {
        outcome: "still_uncertain" as const,
        message: "Resolved host export destination changed after preparation.",
      };
    }
    const destination = await inspectHostExportDestinationV2(
      root,
      destinationPath,
    );
    if (!destination.exists) {
      return {
        outcome: "not_applied" as const,
        message:
          "The exact approved host export destination remains absent.",
      };
    }
    try {
      const snapshot = await snapshotAbsoluteHostDirectoryV2(
        destination.absolutePath,
      );
      if (
        snapshot.fingerprint !== requiredFingerprint(args.sourceFingerprint)
      ) {
        return {
          outcome: "still_uncertain" as const,
          message:
            "The host export destination exists but its exact tree differs from the approved source.",
        };
      }
      return {
        outcome: "committed" as const,
        message:
          "The host export was reconciled by exact destination tree readback.",
        receipt: hostDirectoryExportReceiptV2({
          action,
          context: reconcileContext(context, action),
          destinationPath: destination.absolutePath,
          snapshot,
          commitKind: "reconciled",
        }),
      };
    } catch {
      return {
        outcome: "still_uncertain" as const,
        message:
          "The host export destination exists but could not be verified safely.",
      };
    }
  }

  private async prepareScratchCreate(
    args: Record<string, unknown>,
    context: ScopedExtensionContextV1,
  ): Promise<PreparedActionV1> {
    const workspaceId = workspaceIdFrom(args, context);
    const ownerRunId = runId(context);
    const existing = await this.manager.loadManifest(workspaceId).then(
      (manifest) => manifest,
      (error) =>
        error instanceof WorkspaceManagerErrorV2 &&
        error.code === "workspace_not_found"
          ? null
          : Promise.reject(error),
    );
    if (existing) {
      const rebound = await this.manager.rebindWorkspaceOwnerForContinuation(
        workspaceId,
        ownerRunId,
      );
      const leaseOwnerId = `extension:${ownerRunId}`;
      const leased = await this.manager.acquireLease(workspaceId, leaseOwnerId);
      const leaseId = leased.lease?.id ?? null;
      if (leaseId) {
        this.leases.set(leaseCacheKey(workspaceId, ownerRunId), leaseId);
      }
      return preparedAction({
        name: "code_workspace_create",
        context,
        workspaceId,
        targetPath: workspaceId,
        normalizedArgs: {
          workspaceId,
          kind: "scratch",
          ownerRunId,
          leaseId,
          leaseOwnerId,
          expectedWorkspaceState: "existing",
          payloadBytes: 0,
        },
        expected: sha256Json({
          workspaceId,
          ownerRunId,
          canonicalRoot: rebound.canonicalRoot,
          leaseId,
        }),
        summary: `Reuse durable scratch workspace ${workspaceId} for continue segment ${ownerRunId}.`,
        action: "create",
        outboundBytes: 0,
        targetType: "code_workspace",
      });
    }
    await assertWorkspaceAbsent(this.manager, workspaceId);
    const expected = absentFingerprint(workspaceId, "");
    const normalizedArgs: Record<string, JsonValueV1> = {
      workspaceId,
      kind: "scratch",
      ownerRunId,
      leaseId: null,
      leaseOwnerId: `extension:${ownerRunId}`,
      expectedWorkspaceState: "absent",
      payloadBytes: 0,
    };
    return preparedAction({
      name: "code_workspace_create",
      context,
      workspaceId,
      targetPath: workspaceId,
      normalizedArgs,
      expected,
      summary: `Create durable scratch workspace ${workspaceId} for run ${ownerRunId} while the binding remains absent.`,
      action: "create",
      outboundBytes: 0,
      targetType: "code_workspace",
    });
  }

  private async executePreparedScratchCreate(
    action: PreparedActionV1,
    context: ScopedExtensionContextV1,
  ) {
    const args = action.normalizedArgs;
    const workspaceId = requiredString(args.workspaceId, "workspaceId");
    const ownerRunId = requiredString(args.ownerRunId, "ownerRunId");
    const leaseOwnerId = requiredString(args.leaseOwnerId, "leaseOwnerId");
    const expectedState = optionalString(args.expectedWorkspaceState);
    if (
      ownerRunId !== runId(context) ||
      action.target.workspaceId !== workspaceId ||
      action.target.path !== workspaceId ||
      (expectedState !== "absent" && expectedState !== "existing")
    ) {
      throw new WorkspaceManagerErrorV2("prepared_binding_drift", "Prepared scratch workspace binding changed.");
    }
    assertPayloadBytes(args, 0);
    if (expectedState === "existing") {
      const readback = await this.manager.resumeWorkspace(workspaceId, ownerRunId);
      const leaseId =
        optionalString(args.leaseId) ??
        (await this.manager.acquireLease(workspaceId, leaseOwnerId)).lease?.id;
      if (!leaseId) {
        throw new WorkspaceManagerErrorV2(
          "workspace_lease_missing",
          "Existing scratch workspace did not acquire its bound lease.",
        );
      }
      this.leases.set(leaseCacheKey(workspaceId, ownerRunId), leaseId);
      await this.assertBoundWorkspace(workspaceId, ownerRunId, leaseId, leaseOwnerId);
      return {
        output: readback,
        receipt: workspaceCreationReceipt(
          action,
          context,
          readback,
          sha256Json({
            workspaceId,
            ownerRunId,
            canonicalRoot: readback.canonicalRoot,
            leaseId,
          }),
          `Reused durable scratch workspace ${workspaceId} for continue segment.`,
        ),
        // Segment ownership/lease was applied even though the worktree already existed.
        mutationState: "applied" as const,
      };
    }
    await assertWorkspaceAbsent(this.manager, workspaceId);
    await this.manager.createScratchWorkspace({ workspaceId, ownerRunId });
    const leased = await this.manager.acquireLease(workspaceId, leaseOwnerId);
    const leaseId = leased.lease?.id;
    if (!leaseId) throw new WorkspaceManagerErrorV2("workspace_lease_missing", "Created scratch workspace did not acquire its bound lease.");
    this.leases.set(leaseCacheKey(workspaceId, ownerRunId), leaseId);
    const readback = await this.manager.loadManifest(workspaceId);
    await this.assertBoundWorkspace(workspaceId, ownerRunId, leaseId, leaseOwnerId);
    return {
      output: readback,
      receipt: workspaceCreationReceipt(
        action,
        context,
        readback,
        sha256Json({
          workspaceId,
          ownerRunId,
          canonicalRoot: readback.canonicalRoot,
          leaseId,
        }),
        `Created durable scratch workspace ${workspaceId}.`,
      ),
      mutationState: "applied" as const,
    };
  }

  private async prepareRepositoryCreate(
    args: Record<string, unknown>,
    context: ScopedExtensionContextV1,
  ): Promise<PreparedActionV1> {
    const workspaceId = workspaceIdFrom(args, context);
    const ownerRunId = runId(context);
    const existing = await this.manager.loadManifest(workspaceId).then(
      (manifest) => manifest,
      (error) =>
        error instanceof WorkspaceManagerErrorV2 &&
        error.code === "workspace_not_found"
          ? null
          : Promise.reject(error),
    );
    if (existing?.kind === "repository" && existing.repositoryBinding) {
      const rebound = await this.manager.rebindWorkspaceOwnerForContinuation(
        workspaceId,
        ownerRunId,
      );
      const leaseOwnerId = `extension:${ownerRunId}`;
      const leased = await this.manager.acquireLease(workspaceId, leaseOwnerId);
      const leaseId = leased.lease?.id ?? null;
      if (leaseId) {
        this.leases.set(leaseCacheKey(workspaceId, ownerRunId), leaseId);
      }
      const binding = rebound.repositoryBinding!;
      return preparedAction({
        name: "code_workspace_create",
        context,
        workspaceId,
        targetPath: workspaceId,
        normalizedArgs: {
          workspaceId,
          kind: "repository",
          ownerRunId,
          leaseId,
          leaseOwnerId,
          expectedWorkspaceState: "existing",
          payloadBytes: 0,
          profileKey: binding.profileKey,
          repositoryRoot: binding.repositoryRoot,
          baseSha: rebound.baseSha,
          branch: binding.branch,
          clean: true,
          worktreeBranch: binding.branch,
          bindingFingerprint: binding.bindingFingerprint,
        },
        expected: rebound.baseSha ?? binding.bindingFingerprint,
        summary: `Reuse durable repository workspace ${workspaceId} for continue segment ${ownerRunId}.`,
        action: "create",
        outboundBytes: 0,
        targetType: "code_workspace",
        previewDestination: binding.repositoryRoot,
        relatedResources: [{
          system: "git",
          resourceType: "repository",
          id: `repository:${binding.repositoryRoot}`,
          path: binding.repositoryRoot,
          revision: rebound.baseSha ?? undefined,
        }],
        repositoryProfileId: binding.profileKey,
      });
    }
    await assertWorkspaceAbsent(this.manager, workspaceId);
    const profileKeyInput = optionalString(args.repositoryProfileKey);
    const rawRoot = optionalString(args.repositoryRoot);
    if (!profileKeyInput && !rawRoot) {
      throw new WorkspaceManagerErrorV2("repository_binding_required", "Repository workspace creation requires a profile key or raw repository root.");
    }
    let profileKey = profileKeyInput ?? `raw-${workspaceId}`;
    let repositoryRoot: string;
    if (profileKeyInput) {
      repositoryRoot = await this.repositories.resolveProfile?.(profileKeyInput, context) ?? "";
      if (!repositoryRoot) throw new WorkspaceManagerErrorV2("repository_profile_unavailable", `Repository profile ${profileKeyInput} is unavailable.`);
      if (rawRoot) {
        if (!path.isAbsolute(rawRoot)) {
          throw new WorkspaceManagerErrorV2("repository_path_invalid", "Raw repository root must be absolute.");
        }
        const [profileCanonicalRoot, assertedCanonicalRoot] = await Promise.all([
          fs.realpath(repositoryRoot),
          fs.realpath(rawRoot),
        ]);
        if (profileCanonicalRoot !== assertedCanonicalRoot) {
          throw new WorkspaceManagerErrorV2(
            "repository_binding_conflict",
            "Repository profile key and raw repository root identify different repositories.",
          );
        }
        repositoryRoot = profileCanonicalRoot;
      }
    } else {
      if (!path.isAbsolute(rawRoot!)) throw new WorkspaceManagerErrorV2("repository_path_invalid", "Raw repository root must be absolute.");
      const canonical = await fs.realpath(rawRoot!);
      if (!this.isForegroundUserMission(canonical, context) || !context.originalPrompt?.includes(canonical)) {
        throw new WorkspaceManagerErrorV2("raw_repository_authority_missing", "Raw repository roots require an explicit foreground user mission containing the exact canonical path.");
      }
      const trustedProfile = await this.repositories.resolveProfileByRoot?.(
        canonical,
        context,
      ) ?? null;
      if (trustedProfile) {
        if (!samePath(trustedProfile.repositoryRoot, canonical)) {
          throw new WorkspaceManagerErrorV2(
            "repository_profile_binding_conflict",
            "Trusted repository profile root changed during exact-root resolution.",
          );
        }
        profileKey = trustedProfile.key;
        repositoryRoot = trustedProfile.repositoryRoot;
      } else {
        repositoryRoot = canonical;
      }
    }
    const inspection = await this.repositories.inspect(repositoryRoot, context);
    const normalizedArgs: Record<string, JsonValueV1> = {
      workspaceId,
      kind: "repository",
      ownerRunId,
      leaseId: null,
      leaseOwnerId: `extension:${ownerRunId}`,
      expectedWorkspaceState: "absent",
      payloadBytes: 0,
      profileKey,
      repositoryRoot: inspection.repositoryRoot,
      baseSha: inspection.baseSha,
      branch: inspection.branch,
      clean: inspection.clean,
    };
    const worktreeBranch = `codex/workspace-${workspaceId}`;
    normalizedArgs.worktreeBranch = worktreeBranch;
    const binding = sha256Json({
      profileKey,
      repositoryRoot: inspection.repositoryRoot,
      baseSha: inspection.baseSha,
      branch: worktreeBranch,
    });
    normalizedArgs.bindingFingerprint = binding;
    return preparedAction({
      name: "code_workspace_create",
      context,
      workspaceId,
      targetPath: workspaceId,
      normalizedArgs,
      expected: inspection.baseSha,
      summary: `Create isolated durable worktree for ${inspection.repositoryRoot} at ${inspection.baseSha}.`,
      action: "create",
      outboundBytes: 0,
      targetType: "code_workspace",
      previewDestination: inspection.repositoryRoot,
      relatedResources: [{
        system: "git",
        resourceType: "repository",
        id: `repository:${inspection.repositoryRoot}`,
        path: inspection.repositoryRoot,
        revision: inspection.baseSha,
      }],
      repositoryProfileId: profileKey,
    });
  }

  private async executePreparedRepositoryCreate(
    action: PreparedActionV1,
    context: ScopedExtensionContextV1,
  ) {
    const args = action.normalizedArgs;
    const workspaceId = requiredString(args.workspaceId, "workspaceId");
    const ownerRunId = requiredString(args.ownerRunId, "ownerRunId");
    const leaseOwnerId = requiredString(args.leaseOwnerId, "leaseOwnerId");
    const expectedState = optionalString(args.expectedWorkspaceState);
    if (
      ownerRunId !== runId(context) ||
      action.target.workspaceId !== workspaceId ||
      (expectedState !== "absent" && expectedState !== "existing")
    ) {
      throw new WorkspaceManagerErrorV2("prepared_binding_drift", "Prepared repository workspace binding changed.");
    }
    assertPayloadBytes(args, 0);
    if (expectedState === "existing") {
      const readback = await this.manager.resumeWorkspace(workspaceId, ownerRunId);
      const leaseId =
        optionalString(args.leaseId) ??
        (await this.manager.acquireLease(workspaceId, leaseOwnerId)).lease?.id;
      if (!leaseId) {
        throw new WorkspaceManagerErrorV2(
          "workspace_lease_missing",
          "Existing repository workspace did not acquire its bound lease.",
        );
      }
      this.leases.set(leaseCacheKey(workspaceId, ownerRunId), leaseId);
      await this.assertBoundWorkspace(workspaceId, ownerRunId, leaseId, leaseOwnerId);
      const repositoryWriteScope = await this.resolveRepositoryWriteScopeOutput(
        requiredString(args.profileKey, "profileKey"),
        context,
      );
      return {
        output: {
          ...readback,
          repositoryWriteScope,
        },
        receipt: workspaceCreationReceipt(
          action,
          context,
          readback,
          requiredFingerprint(args.bindingFingerprint),
          `Reused durable repository workspace ${workspaceId} for continue segment.`,
        ),
        // Segment ownership/lease was applied even though the worktree already existed.
        mutationState: "applied" as const,
      };
    }
    await assertWorkspaceAbsent(this.manager, workspaceId);
    const inspection: RepositoryInspectionV2 = {
      repositoryRoot: requiredString(args.repositoryRoot, "repositoryRoot"),
      baseSha: requiredString(args.baseSha, "baseSha"),
      branch: requiredString(args.branch, "branch"),
      clean: args.clean === true,
    };
    const current = await this.repositories.inspect(inspection.repositoryRoot, context);
    if (current.baseSha !== inspection.baseSha || current.repositoryRoot !== inspection.repositoryRoot) {
      throw new WorkspaceManagerErrorV2("repository_precondition_changed", "Repository HEAD or canonical root changed after approval.");
    }
    const provisioned = await this.repositories.provision({
      workspaceId,
      profileKey: requiredString(args.profileKey, "profileKey"),
      inspection,
      context,
    });
    if (provisioned.branch !== requiredString(args.worktreeBranch, "worktreeBranch")) {
      throw new WorkspaceManagerErrorV2(
        "repository_branch_drift",
        "Provisioned worktree branch differs from the exact prepared agent-owned branch.",
      );
    }
    if (provisioned.bindingFingerprint !== requiredFingerprint(args.bindingFingerprint)) {
      throw new WorkspaceManagerErrorV2("repository_binding_drift", "Provisioned worktree binding fingerprint changed.");
    }
    await this.manager.registerTrustedRepositoryWorkspace({
      workspaceId,
      ownerRunId,
      profileKey: provisioned.profileKey,
      repositoryRoot: provisioned.repositoryRoot,
      worktreeRoot: provisioned.worktreeRoot,
      branch: provisioned.branch,
      baseSha: provisioned.baseSha,
      bindingFingerprint: provisioned.bindingFingerprint,
      trusted: true,
    });
    const leased = await this.manager.acquireLease(workspaceId, leaseOwnerId);
    const leaseId = leased.lease?.id;
    if (!leaseId) throw new WorkspaceManagerErrorV2("workspace_lease_missing", "Created repository workspace did not acquire its bound lease.");
    this.leases.set(leaseCacheKey(workspaceId, ownerRunId), leaseId);
    const manifest = await this.manager.loadManifest(workspaceId);
    await this.assertBoundWorkspace(workspaceId, ownerRunId, leaseId, leaseOwnerId);
    const repositoryWriteScope = await this.resolveRepositoryWriteScopeOutput(
      provisioned.profileKey,
      context,
    );
    return {
      output: {
        ...manifest,
        repositoryWriteScope,
      },
      receipt: workspaceCreationReceipt(
        action,
        context,
        manifest,
        provisioned.bindingFingerprint,
        `Created trusted repository workspace ${workspaceId}.`,
      ),
      mutationState: "applied" as const,
    };
  }

  private async resolveRepositoryWriteScopeOutput(
    profileKey: string,
    context: ScopedExtensionContextV1,
  ): Promise<ReturnType<typeof repositoryWriteScopeOutputV2> | null> {
    const profile = await this.repositories.resolveProfileContract?.(
      profileKey,
      context,
    ) ?? null;
    return profile ? repositoryWriteScopeOutputV2(profile) : null;
  }

  private async ensureLease(workspaceId: string, context: ScopedExtensionContextV1): Promise<string> {
    const ownerRunId = runId(context);
    const leaseOwnerId = `extension:${ownerRunId}`;
    const cacheKey = leaseCacheKey(workspaceId, ownerRunId);
    const known = this.leases.get(cacheKey);
    if (known) {
      const manifest = await this.manager.renewLease(workspaceId, known).catch(() => null);
      if (
        manifest?.ownerRunId === ownerRunId &&
        manifest.lease?.id === known &&
        manifest.lease.ownerId === leaseOwnerId
      ) return known;
      this.leases.delete(cacheKey);
    }
    const existing = await this.manager.loadManifest(workspaceId);
    if (existing.ownerRunId !== ownerRunId) {
      throw new WorkspaceManagerErrorV2("workspace_owner_mismatch", "Workspace belongs to another run.");
    }
    const leased = await this.manager.acquireLease(workspaceId, leaseOwnerId);
    this.leases.set(cacheKey, leased.lease!.id);
    return leased.lease!.id;
  }

  private async assertBoundWorkspace(
    workspaceId: string,
    ownerRunId: string,
    leaseId: string,
    leaseOwnerId: string,
  ): Promise<WorkspaceManifestV2> {
    const manifest = await this.manager.loadManifest(workspaceId);
    if (
      manifest.ownerRunId !== ownerRunId ||
      manifest.lease?.id !== leaseId ||
      manifest.lease.ownerId !== leaseOwnerId ||
      manifest.status !== "leased"
    ) {
      throw new WorkspaceManagerErrorV2(
        "workspace_binding_changed",
        "Workspace owner or prepared lease binding changed.",
      );
    }
    return manifest;
  }
}

export class LocalGitWorkspaceProvisionerV2 implements WorkspaceRepositoryProvisionerV2 {
  constructor(private readonly manager: WorkspaceManagerV2) {}

  async inspect(repositoryRoot: string, context: ScopedExtensionContextV1): Promise<RepositoryInspectionV2> {
    const root = await gitText(repositoryRoot, ["rev-parse", "--show-toplevel"], context.abortSignal);
    const canonicalRequested = await fs.realpath(repositoryRoot);
    const canonicalRoot = await fs.realpath(root);
    if (!samePath(canonicalRequested, canonicalRoot)) throw new WorkspaceManagerErrorV2("repository_root_mismatch", "Git canonical root differs from the approved repository path.");
    const commonDirectory = await gitText(
      canonicalRoot,
      ["rev-parse", "--git-common-dir"],
      context.abortSignal,
    );
    const gitConfigPath = path.resolve(canonicalRoot, commonDirectory, "config");
    const localGitConfig = await fs.readFile(gitConfigPath, "utf8");
    if (/^\s*\[filter\s+[^\]]+\]/imu.test(localGitConfig)) {
      throw new WorkspaceManagerErrorV2(
        "git_checkout_filter_blocked",
        "Repository-local Git clean/smudge/process filters must be removed or independently trusted before creating an agent worktree.",
      );
    }
    const baseSha = await gitText(canonicalRoot, ["rev-parse", "HEAD"], context.abortSignal);
    const branch = await gitText(canonicalRoot, ["branch", "--show-current"], context.abortSignal, true);
    const status = await gitText(canonicalRoot, ["status", "--porcelain=v1", "--untracked-files=all"], context.abortSignal, true);
    return { repositoryRoot: canonicalRoot, baseSha, branch: branch || "HEAD", clean: status.trim().length === 0 };
  }

  async provision(input: { workspaceId: string; profileKey: string; inspection: RepositoryInspectionV2; context: ScopedExtensionContextV1 }): Promise<RepositoryWorktreeProvisionV2> {
    const parent = await ensureSafeWorktreeParent(this.manager.applicationDataRoot);
    const worktreeRoot = path.join(parent, input.workspaceId);
    const branch = `codex/workspace-${input.workspaceId}`;
    const existing = await fs.lstat(worktreeRoot).catch(() => null);
    if (!existing) {
      await assertSafeWorktreeParent(this.manager.applicationDataRoot, parent);
      await gitText(input.inspection.repositoryRoot, ["worktree", "add", "-b", branch, worktreeRoot, input.inspection.baseSha], input.context.abortSignal, true);
    } else if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new WorkspaceManagerErrorV2("worktree_path_conflict", "Durable worktree path is unsafe.");
    }
    const canonicalWorktree = await fs.realpath(worktreeRoot);
    const observedSha = await gitText(canonicalWorktree, ["rev-parse", "HEAD"], input.context.abortSignal);
    if (observedSha !== input.inspection.baseSha) throw new WorkspaceManagerErrorV2("worktree_head_drift", "Durable worktree HEAD differs from the approved base SHA.");
    return {
      ...input.inspection,
      branch,
      profileKey: input.profileKey,
      worktreeRoot: canonicalWorktree,
      bindingFingerprint: sha256Json({
        profileKey: input.profileKey,
        repositoryRoot: input.inspection.repositoryRoot,
        baseSha: input.inspection.baseSha,
        branch,
      }),
    };
  }
}

async function ensureSafeWorktreeParent(applicationDataRoot: string): Promise<string> {
  await fs.mkdir(applicationDataRoot, { recursive: true });
  const rootStat = await fs.lstat(applicationDataRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new WorkspaceManagerErrorV2(
      "worktree_parent_unsafe",
      "Code application-data root is not a safe directory.",
    );
  }
  const canonicalRoot = await fs.realpath(applicationDataRoot);
  const parent = path.join(canonicalRoot, "repository-worktrees");
  await fs.mkdir(parent, { recursive: true });
  await assertSafeWorktreeParent(canonicalRoot, parent);
  return parent;
}

async function assertSafeWorktreeParent(
  applicationDataRoot: string,
  parent: string,
): Promise<void> {
  const canonicalRoot = await fs.realpath(applicationDataRoot);
  const parentStat = await fs.lstat(parent);
  const canonicalParent = await fs.realpath(parent);
  const relative = path.relative(canonicalRoot, canonicalParent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new WorkspaceManagerErrorV2(
      "worktree_parent_unsafe",
      "Repository worktree parent escaped the code application-data root.",
    );
  }
}

function contribution(name: CodeWorkspaceToolNameV2, runtime: WorkspaceToolRuntimeV2): ExtensionToolContributionV1 {
  const supportsPreparation = !isReadWorkspaceTool(name);
  const preparation = supportsPreparation ? "required" : "none";
  const tool: ExtensionToolV1 = {
    name,
    description: description(name),
    parameters: schema(name),
    descriptor: toolDescriptor(name, preparation),
    execute: (args, context) => runtime.execute(name, args, context),
    ...(supportsPreparation ? {
      prepare: (args: Record<string, unknown>, context: ScopedExtensionContextV1) => runtime.prepare(name, args, context),
      executePrepared: (action: PreparedActionV1, context: ScopedExtensionContextV1) => runtime.executePrepared(name, action, context),
      reconcile: (action: PreparedActionV1, context: ScopedExtensionContextV1) => runtime.reconcile(name, action, context),
    } : {}),
  };
  return {
    descriptor: {
      version: 1,
      kind: "tool",
      id: `agentic-researcher-code:${name}`,
      displayName: name,
    },
    tool,
  };
}

function isReadWorkspaceTool(name: CodeWorkspaceToolNameV2): boolean {
  return [
    "code_workspace_status",
    "code_workspace_stat",
    "code_workspace_list",
    "code_workspace_read",
    "code_workspace_search",
    "read_workspace_file",
    "list_workspace_files",
    "preview_workspace_html",
    "export_workspace_artifact",
  ].includes(name);
}

function toolDescriptor(
  name: CodeWorkspaceToolNameV2,
  preparation: "none" | "optional" | "required",
): ToolDescriptorV1 {
  const read = isReadWorkspaceTool(name);
  const destructive = name === "code_workspace_trash";
  const action: ResourceActionV1 = read
    ? name.includes("list") ? "list" : name.includes("search") ? "search" : "read"
    : name.includes("restore") ? "restore"
      : destructive ? "trash"
        : name.includes("move") ? "move"
          : name.includes("append") ? "append"
            : name.includes("create") || name.includes("mkdir") || name.includes("copy") || name === "code_workspace_export_directory" ? "create"
              : "update";
  return {
    version: 1,
    name,
    capability: {
      system: "workspace",
      resourceType:
        name === "code_workspace_export_directory"
          ? "host_directory"
          : "code_workspace",
      action,
    },
    effect: read ? "read" : destructive ? "destructive_mutation" : "reversible_mutation",
    risk: read ? "low" : destructive ? "high" : "medium",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: !destructive,
      fallback: read ? "none" : "exact",
    },
    execution: { preparation, desktopOnly: true, cacheable: read, parallelSafe: read },
    durability: { journal: !read, receipt: !read, readback: read ? "optional" : "required", reconciliation: read ? "none" : "required" },
    allowedPrincipals: ["host", "single_agent", "lead", "code_worker"],
    ...(read ? {} : { receiptKind: "code_change" as const, operationGoals: ["code_edit"] }),
  };
}

function preparedAction(input: {
  name: CodeWorkspaceToolNameV2;
  context: ScopedExtensionContextV1;
  workspaceId: string;
  targetPath: string;
  normalizedArgs: Record<string, JsonValueV1>;
  expected: string;
  summary: string;
  action: ResourceActionV1;
  outboundBytes: number;
  targetSystem?: "workspace" | "git";
  targetType?: string;
  previewDestination?: string;
  targetOverride?: PreparedActionV1["target"];
  relatedResources?: PreparedActionV1["relatedResources"];
  requiredConfirmations?: 1 | 2;
  warnings?: string[];
  repositoryProfileId?: string;
}): PreparedActionV1 {
  const preparedAt = input.context.now();
  const target =
    input.targetOverride ??
    workspaceResource(
      input.workspaceId,
      input.targetPath,
      "code_workspace",
      "workspace",
      input.repositoryProfileId,
    );
  const preview = {
    summary: input.summary,
    destination: input.previewDestination ?? input.targetPath,
    before: { expectedFingerprint: input.expected },
    after: { operation: input.action },
    warnings: input.warnings ?? [],
    outboundBytes: input.outboundBytes,
  };
  const seedFingerprint = sha256Json({
    toolName: input.name,
    target,
    normalizedArgs: input.normalizedArgs,
    expectedTargetRevision: input.expected,
    preview,
    requiredConfirmations: input.requiredConfirmations ?? 1,
  });
  const prepared: Omit<PreparedActionV1, "payloadFingerprint"> = {
    version: 1,
    id: `prepared-${input.name}-${seedFingerprint.slice(7, 23)}`,
    runId: actionRunId(input.context),
    toolCallId: input.context.operationId ?? `call-${seedFingerprint.slice(7, 19)}`,
    toolName: input.name,
    target,
    relatedResources: input.relatedResources ?? [],
    normalizedArgs: input.normalizedArgs,
    preview,
    requiredConfirmations: input.requiredConfirmations ?? 1,
    expectedTargetRevision: input.expected,
    idempotencyKey: sha256Json({ name: input.name, runId: runId(input.context), target, normalizedArgs: input.normalizedArgs }),
    reconciliationKey: `${input.workspaceId}:${input.name}:${input.targetPath}`,
    preparedAt: preparedAt.toISOString(),
    expiresAt: new Date(preparedAt.getTime() + 120_000).toISOString(),
  };
  return {
    ...prepared,
    payloadFingerprint: sha256Canonical(prepared),
  };
}

function validatePreparedAction(name: CodeWorkspaceToolNameV2, action: PreparedActionV1, context: ScopedExtensionContextV1): void {
  if (action.version !== 1 || action.toolName !== name || action.runId !== actionRunId(context) || Date.parse(action.expiresAt) <= context.now().getTime()) throw new WorkspaceManagerErrorV2("prepared_action_invalid", "Prepared workspace action is invalid or expired.");
  const { payloadFingerprint: _ignored, ...prepared } = action;
  const expected = sha256Canonical(prepared);
  if (expected !== action.payloadFingerprint) throw new WorkspaceManagerErrorV2("prepared_fingerprint_drift", "Prepared workspace action fingerprint changed.");
  if (
    !context.authorizedAction ||
    context.authorizedAction.preparedActionId !== action.id ||
    context.authorizedAction.payloadFingerprint !== action.payloadFingerprint
  ) throw new WorkspaceManagerErrorV2("prepared_authority_missing", "Prepared workspace action lacks exact host authorization.");
}

function actionReceipt(action: PreparedActionV1, context: ScopedExtensionContextV1, result: WorkspaceMutationReceiptV2): ActionReceiptV1 {
  return {
    version: 1,
    id: result.id,
    runId: action.runId,
    actionId: action.id,
    toolName: action.toolName,
    operation: toolDescriptor(action.toolName as CodeWorkspaceToolNameV2, "required")
      .capability.action,
    resource: action.target,
    message: `Workspace ${result.operation} committed for ${result.path}.`,
    payloadFingerprint: action.payloadFingerprint,
    grantId: context.authorizedAction!.grantId,
    idempotencyKey: action.idempotencyKey,
    startedAt: action.preparedAt,
    committedAt: result.committedAt,
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: result.committedAt,
      observedRevision: result.afterSha256 ?? result.beforeSha256 ?? undefined,
      observedFingerprint: result.fingerprint,
    },
    effects: {
      bytesWritten: result.bytesWritten,
      bytesDeleted: result.bytesDeleted,
      affectedCount: result.affectedCount,
      changedFields: [result.path, ...(result.relatedPath ? [result.relatedPath] : [])],
    },
  };
}

function workspaceCreationReceipt(
  action: PreparedActionV1,
  context: ScopedExtensionContextV1,
  manifest: WorkspaceManifestV2,
  observedFingerprint: string,
  message: string,
): ActionReceiptV1 {
  const committedAt = context.now().toISOString();
  return {
    version: 1,
    id: `workspace-create-${action.id}`,
    runId: action.runId,
    actionId: action.id,
    toolName: action.toolName,
    operation: "create",
    resource: action.target,
    relatedResources: action.relatedResources,
    message,
    payloadFingerprint: action.payloadFingerprint,
    grantId: context.authorizedAction!.grantId,
    idempotencyKey: action.idempotencyKey,
    startedAt: action.preparedAt,
    committedAt,
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: committedAt,
      observedRevision: manifest.baseSha ?? manifest.hashes.indexFingerprint,
      observedFingerprint,
    },
    effects: { affectedCount: 1 },
  };
}

function reconcileContext(
  context: ScopedExtensionContextV1,
  action: PreparedActionV1,
): ScopedExtensionContextV1 {
  return {
    ...context,
    authorizedAction: {
      preparedActionId: action.id,
      payloadFingerprint: action.payloadFingerprint,
      grantId: "reconciled-exact-readback",
    },
  };
}

async function reconciliationMutationReceipt(
  manager: WorkspaceManagerV2,
  manifest: WorkspaceManifestV2,
  name: CodeWorkspaceToolNameV2,
  targetPath: string,
  destinationPath: string | undefined,
  expectedAfter: string | null,
): Promise<WorkspaceMutationReceiptV2> {
  const committedAt = new Date().toISOString();
  const operation: WorkspaceMutationReceiptV2["operation"] = name === "code_workspace_mkdir" ? "mkdir"
    : name === "code_workspace_create_file" ? "create"
      : name === "code_workspace_append" ? "append"
        : name === "code_workspace_move" ? "move"
          : name === "code_workspace_copy" ? "copy"
            : name === "code_workspace_trash" ? "trash"
              : name === "code_workspace_restore" ? "restore"
                : name === "code_workspace_patch" ? "patch" : "write";
  const core = {
    version: 2 as const,
    id: `workspace-reconcile-${sha256Json({ name, targetPath, destinationPath, expectedAfter }).slice(7, 23)}`,
    workspaceId: manifest.workspaceId,
    operation,
    path: targetPath,
    relatedPath: destinationPath ?? null,
    beforeSha256: null,
    afterSha256: expectedAfter,
    bytesWritten: 0,
    bytesDeleted: 0,
    affectedCount: 1,
    trashId: null,
    committedAt,
    manifestSha256: sha256Text(JSON.stringify(manifest)),
  };
  return { ...core, fingerprint: sha256Json(core) };
}

function workspaceResource(
  workspaceId: string,
  targetPath: string,
  resourceType = "code_workspace",
  system: "workspace" | "git" = "workspace",
  repositoryProfileId?: string,
) {
  return {
    system,
    resourceType,
    id: `${workspaceId}:${targetPath}`,
    workspaceId,
    path: targetPath,
    ...(repositoryProfileId ? { repositoryProfileId } : {}),
  } as const;
}

function mutationOutput(receipt: WorkspaceMutationReceiptV2) {
  return { status: "ok", operation: receipt.operation, path: receipt.path, relatedPath: receipt.relatedPath, receipt };
}

function preparationRequired(name: string): WorkspaceManagerErrorV2 {
  return new WorkspaceManagerErrorV2("prepared_action_required", `${name} must be prepared and exactly authorized before execution.`);
}

function toolError(error: unknown) {
  return error instanceof WorkspaceManagerErrorV2
    ? { code: error.code, message: error.message }
    : { code: "workspace_tool_failed", message: error instanceof Error ? error.message : "Workspace tool failed." };
}

async function assertMissing(manager: WorkspaceManagerV2, workspaceId: string, target: string): Promise<void> {
  const exists = await manager.stat(workspaceId, target).then(() => true, (error) =>
    isMissingWorkspacePath(error) ? false : Promise.reject(error),
  );
  if (exists) throw new WorkspaceManagerErrorV2("path_exists", "Prepared destination already exists.");
}

async function assertWorkspaceAbsent(
  manager: WorkspaceManagerV2,
  workspaceId: string,
): Promise<void> {
  const existing = await manager.loadManifest(workspaceId).then(
    () => true,
    (error) => error instanceof WorkspaceManagerErrorV2 && error.code === "workspace_not_found"
      ? false
      : Promise.reject(error),
  );
  if (existing) {
    throw new WorkspaceManagerErrorV2(
      "workspace_exists",
      `Workspace ${workspaceId} already has a durable binding.`,
    );
  }
}

async function statOrMissing(
  manager: WorkspaceManagerV2,
  workspaceId: string,
  target: string,
) {
  return manager.stat(workspaceId, target).catch((error) =>
    isMissingWorkspacePath(error)
      ? null
      : Promise.reject(error),
  );
}

function isMissingWorkspacePath(error: unknown): boolean {
  return error instanceof WorkspaceManagerErrorV2 &&
    (error.code === "path_not_found" || error.code === "parent_missing");
}

async function assertPreparedTargetState(
  manager: WorkspaceManagerV2,
  workspaceId: string,
  targetPath: string,
  args: Record<string, JsonValueV1>,
): Promise<void> {
  const normalizedPath = optionalString(args.path);
  if (normalizedPath && normalizedPath !== targetPath) {
    throw new WorkspaceManagerErrorV2("prepared_binding_drift", "Prepared target path changed.");
  }
  const expectedState = requiredString(args.expectedTargetState, "expectedTargetState");
  if (expectedState === "absent") {
    await assertMissing(manager, workspaceId, targetPath);
    return;
  }
  if (expectedState !== "existing") {
    throw new WorkspaceManagerErrorV2("prepared_binding_drift", "Prepared target state is invalid.");
  }
  const current = await manager.stat(workspaceId, targetPath);
  if (
    current.sha256 !== requiredFingerprint(args.expectedSha256) ||
    (args.expectedKind !== undefined && current.kind !== args.expectedKind)
  ) {
    throw new WorkspaceManagerErrorV2(
      "precondition_failed",
      "Prepared workspace target hash or kind changed before execution.",
    );
  }
}

function assertRequestedFingerprint(requested: unknown, observed: string): void {
  if (requested === undefined || requested === null) return;
  if (requiredFingerprint(requested) !== observed) {
    throw new WorkspaceManagerErrorV2(
      "precondition_failed",
      "Requested expected SHA-256 is stale.",
    );
  }
}

function assertPayloadBytes(args: Record<string, JsonValueV1>, expected: number): void {
  if (!Number.isSafeInteger(args.payloadBytes) || args.payloadBytes !== expected) {
    throw new WorkspaceManagerErrorV2(
      "prepared_payload_drift",
      "Prepared workspace payload byte count changed.",
    );
  }
}

function absentFingerprint(workspaceId: string, targetPath: string): string {
  return sha256Json({ workspaceId, targetPath, state: "absent" });
}

function leaseCacheKey(workspaceId: string, ownerRunId: string): string {
  return `${ownerRunId}:${workspaceId}`;
}

function parseReplacements(value: unknown): Array<{ oldText: string; newText: string; expectedOccurrences: 1 }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) throw new WorkspaceManagerErrorV2("invalid_patch", "Patch requires 1-50 replacements.");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new WorkspaceManagerErrorV2("invalid_patch", "Patch replacement must be an object.");
    const source = entry as Record<string, unknown>;
    if (Object.keys(source).some((key) => !["oldText", "newText", "expectedOccurrences"].includes(key))) throw new WorkspaceManagerErrorV2("invalid_patch", "Patch replacement contains unknown fields.");
    if (source.expectedOccurrences !== undefined && source.expectedOccurrences !== 1) throw new WorkspaceManagerErrorV2("invalid_patch", "Patch expectedOccurrences must be exactly one.");
    return { oldText: requiredString(source.oldText, "oldText"), newText: requiredString(source.newText, "newText", true), expectedOccurrences: 1 as const };
  });
}

async function gitText(cwd: string, args: string[], signal: AbortSignal, allowEmpty = false): Promise<string> {
  const allowed = new Set(["rev-parse", "branch", "status", "worktree"]);
  if (!allowed.has(args[0] ?? "") || args.some((arg) => /[\0\r\n]/u.test(arg))) throw new WorkspaceManagerErrorV2("git_operation_blocked", "Git operation is not allowlisted.");
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
    const child = spawn("git", [
      "-c", `core.hooksPath=${nullDevice}`,
      "-c", "core.fsmonitor=false",
      "-c", "commit.gpgSign=false",
      ...args,
    ], {
      cwd,
      shell: false,
      windowsHide: true,
      signal,
      env: cleanGitEnvironment(nullDevice),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
  if (result.code !== 0) throw new WorkspaceManagerErrorV2("git_operation_failed", `Git ${args[0]} failed (${result.code}): ${result.stderr.trim().slice(0, 1_000)}`);
  const output = result.stdout.trim();
  if (!allowEmpty && !output) throw new WorkspaceManagerErrorV2("git_empty_result", `Git ${args[0]} returned no output.`);
  return output;
}

function cleanGitEnvironment(nullDevice: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
  };
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "HOME",
    "USERPROFILE",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function schema(name: CodeWorkspaceToolNameV2): JsonSchemaObjectV1 {
  if (name === "code_workspace_create") return objectSchema({ workspaceId: stringSchema(), kind: { type: "string", enum: ["scratch", "repository"] }, repositoryProfileKey: stringSchema(), repositoryRoot: stringSchema() });
  if (name === "code_workspace_status") return objectSchema({ workspaceId: stringSchema() });
  if (name === "code_workspace_search") return objectSchema({ workspaceId: stringSchema(), query: stringSchema(), path: stringSchema(), caseSensitive: { type: "boolean" }, limit: { type: "integer" } }, ["query"]);
  if (name === "code_workspace_list" || name === "list_workspace_files") return objectSchema({ workspaceId: stringSchema(), path: stringSchema() });
  if (name === "code_workspace_read" || name === "read_workspace_file" || name === "code_workspace_stat") return objectSchema({ workspaceId: stringSchema(), path: stringSchema() }, ["path"]);
  if (name === "code_workspace_mkdir") return objectSchema({ workspaceId: stringSchema(), path: stringSchema() }, ["path"]);
  if (name === "code_workspace_create_file") return {
    ...objectSchema({
      workspaceId: stringSchema(),
      path: stringSchema(),
      content: stringSchema(),
      notebook: jupyterNotebookInputSchema(),
    }, ["path"]),
    oneOf: [{ required: ["content"] }, { required: ["notebook"] }],
  };
  if (name === "code_workspace_export_directory") {
    return objectSchema(
      {
        workspaceId: stringSchema(),
        sourcePath: stringSchema(),
        destinationRoot: {
          type: "string",
          enum: [
            "desktop",
            "documents",
            "downloads",
            "vault_sibling_projects",
          ],
        },
        destinationPath: stringSchema(),
      },
      ["destinationRoot", "destinationPath"],
    );
  }
  if (name === "code_workspace_append") return objectSchema({ workspaceId: stringSchema(), path: stringSchema(), content: stringSchema(), expectedSha256: stringSchema() }, ["path", "content", "expectedSha256"]);
  if (name === "code_workspace_write_expected" || name === "write_workspace_file") return objectSchema({ workspaceId: stringSchema(), path: stringSchema(), content: stringSchema(), expectedSha256: stringSchema() }, ["path", "content"]);
  if (name === "code_workspace_patch") return objectSchema({ workspaceId: stringSchema(), path: stringSchema(), expectedSha256: stringSchema(), replacements: { type: "array", items: objectSchema({ oldText: stringSchema(), newText: stringSchema(), expectedOccurrences: { type: "integer", enum: [1] } }, ["oldText", "newText"]) } }, ["path", "replacements"]);
  if (name === "code_workspace_move" || name === "code_workspace_copy") return objectSchema({ workspaceId: stringSchema(), path: stringSchema(), destinationPath: stringSchema(), expectedSha256: stringSchema() }, ["path", "destinationPath"]);
  if (name === "code_workspace_trash") return objectSchema({ workspaceId: stringSchema(), path: stringSchema(), expectedSha256: stringSchema() }, ["path"]);
  if (name === "code_workspace_restore") return objectSchema({ workspaceId: stringSchema(), trashId: stringSchema() }, ["trashId"]);
  if (name === "replace_workspace_text") return objectSchema({ workspaceId: stringSchema(), path: stringSchema(), find: stringSchema(), replace: stringSchema(), replaceAll: { type: "boolean" } }, ["path", "find", "replace"]);
  if (name === "preview_workspace_html") return objectSchema({ workspaceId: stringSchema(), htmlPath: stringSchema(), cssPath: stringSchema() }, ["htmlPath"]);
  return objectSchema({ workspaceId: stringSchema(), workspacePath: stringSchema(), path: stringSchema() });
}

function objectSchema(properties: Record<string, JsonSchemaObjectV1>, required: string[] = []): JsonSchemaObjectV1 { return { type: "object", properties, required, additionalProperties: false }; }
function stringSchema(): JsonSchemaObjectV1 { return { type: "string" }; }
function jupyterNotebookInputSchema(): JsonSchemaObjectV1 {
  return objectSchema({
    cells: {
      type: "array",
      minItems: 1,
      maxItems: 200,
      items: objectSchema({
        type: { type: "string", enum: ["markdown", "code"] },
        source: stringSchema(),
      }, ["type", "source"]),
    },
    kernelName: stringSchema(),
    kernelDisplayName: stringSchema(),
    language: stringSchema(),
  }, ["cells"]);
}

function description(name: string): string {
  const base = `${name.replace(/_/gu, " ")} through one durable, bounded, hash-verified code workspace. This workspace is a real directory on the user's local filesystem. Finished workspace trees can be delivered beside the active Obsidian vault by default, or explicitly exported to Desktop, Documents, or Downloads, with code_workspace_export_directory.`;
  let text = base;
  if (name === "code_workspace_create") {
    text = `${base} This is the bootstrap step, not the final deliverable. After it succeeds, code_workspace_mkdir and code_workspace_create_file become available. Prefer repositoryProfileKey for a configured repository; repositoryRoot is the raw foreground-user alternative. If both are supplied, the host accepts them only when canonical readback proves they identify the same repository.`;
  } else if (name === "code_workspace_mkdir") {
    text = `Purpose: Create a nested directory path inside the bounded code workspace. Required: path. Side effects: bound write. ${base} Every missing parent directory is created safely; an existing directory is accepted, but a file conflict is rejected.`;
  } else if (name === "code_workspace_export_directory") {
    text = `Purpose: Copy a completed workspace directory tree to a real, discoverable host folder. Use destinationRoot vault_sibling_projects by default for a new standalone project; use Desktop, Documents, or Downloads only when the foreground mission explicitly names one. Required: destinationRoot plus a safe project name in destinationPath; sourcePath is optional and defaults to the workspace root. Side effects: exact approval-gated host write. ${base} The vault-sibling destination resolves to <vault parent>/<vault name> Agent Projects/<destinationPath>. The destination must be absent and every parent and file is verified. It never overwrites an existing file or directory.`;
  } else if (name === "code_workspace_create_file") {
    text = `Purpose: Create a new file in the real local filesystem workspace. Use when: adding a new workspace path. Do not use when: writing Obsidian note content — use append_to_current_file. Required: path + content. Next: code_validate_fast, then code_workspace_export_directory for vault-sibling delivery unless another destination was explicit. Side effects: bound local write. ${base} Retrying is safe only when the existing file is byte-identical: that case returns a verified no-op. Different content is never overwritten by create; the error reports its SHA-256 and requires code_workspace_read followed by code_workspace_write_expected. For .ipynb, prefer the structured notebook cells field so the host emits deterministic nbformat 4 JSON with empty outputs and an explicit not-executed state. For other files provide complete content. Source creation explicitly supports ${CODE_CREATION_LANGUAGE_SUMMARY_V1}.`;
    text += " Missing parent directories are created automatically, so paths such as src/game/ui/checkers.py are valid in one call.";
  } else if (name === "code_workspace_patch") {
    text = `Purpose: Exact text replacements in an existing workspace file. Use when: small edits after read+SHA. Do not use when: creating a new file. Required: path, replacements. Next: validate. Side effects: bound write. ${base} Use this only for an existing file after reading its SHA-256; a missing path must use code_workspace_create_file instead.`;
  } else if (
    name === "code_workspace_write_expected" ||
    name === "write_workspace_file"
  ) {
    text = `Purpose: Hash-bound full-file correction in the real local filesystem workspace. Use when: repairing after code_workspace_read with expectedSha256. Do not use when: first create (use code_workspace_create_file) or inventing a patch tool. Required: path, content, expectedSha256. Next: validate/repair, then code_workspace_export_directory for vault-sibling delivery unless another destination was explicit. Side effects: bound local write. ${base} Provide the complete replacement file content; never use a placeholder, TODO-only stub, ellipsis, or prose reference to omitted content. Source creation explicitly supports ${CODE_CREATION_LANGUAGE_SUMMARY_V1}.`;
  }
  return text;
}
function resolveCreateFileContentV1(
  args: Record<string, unknown>,
  targetPath: string,
): {
  content: string;
  notebookMetadata?: Record<string, JsonValueV1>;
} {
  const notebookPath = /\.ipynb$/iu.test(targetPath);
  const hasNotebook = args.notebook !== undefined;
  const contentArg = typeof args.content === "string" ? args.content : undefined;
  const hasUsableContent = contentArg !== undefined && contentArg.length > 0;

  if (notebookPath) {
    // Prefer structured notebook cells when the destination is .ipynb. Models
    // sometimes also echo a content string; ignore that duplicate payload.
    if (hasNotebook) {
      try {
        const built = buildJupyterNotebookV1(args.notebook);
        return {
          content: built.content,
          notebookMetadata: {
            cellCount: built.cellCount,
            codeCellCount: built.codeCellCount,
            markdownCellCount: built.markdownCellCount,
            kernelName: built.kernelName,
            language: built.language,
            executionState: built.executionState,
          },
        };
      } catch (error) {
        throw new WorkspaceManagerErrorV2(
          "invalid_arguments",
          error instanceof Error ? error.message : "Notebook input is invalid.",
        );
      }
    }
    const content = requiredString(args.content, "content", true);
    try {
      validateJupyterNotebookContentV1(content);
    } catch (error) {
      throw new WorkspaceManagerErrorV2(
        "invalid_arguments",
        error instanceof Error ? error.message : "Notebook content is invalid.",
      );
    }
    return { content };
  }

  // Non-.ipynb destinations: prefer plain content when present. If the model
  // also (or only) sent Jupyter cells for a .py/.md/etc. path, flatten cells.
  if (hasUsableContent) {
    return { content: contentArg };
  }
  if (hasNotebook) {
    try {
      return {
        content: flattenNotebookCellsToPlainContentV1(args.notebook),
      };
    } catch (error) {
      throw new WorkspaceManagerErrorV2(
        "invalid_arguments",
        error instanceof Error ? error.message : "Notebook input is invalid.",
      );
    }
  }
  return { content: requiredString(args.content, "content", true) };
}

export async function resolveKnownHostDirectoryV2(
  directory: KnownHostDirectoryV2,
): Promise<string> {
  if (directory === "vault_sibling_projects") {
    throw new WorkspaceManagerErrorV2(
      "vault_sibling_directory_unavailable",
      "Vault-sibling project delivery requires the Obsidian host to provide the active vault location.",
    );
  }
  const userHome = homedir();
  const oneDrive = process.env.OneDrive?.trim();
  const candidates =
    directory === "desktop"
      ? [
          ...(oneDrive ? [path.join(oneDrive, "Desktop")] : []),
          path.join(userHome, "Desktop"),
        ]
      : directory === "documents"
        ? [
            ...(oneDrive ? [path.join(oneDrive, "Documents")] : []),
            path.join(userHome, "Documents"),
          ]
        : [path.join(userHome, "Downloads")];
  for (const candidate of candidates) {
    const stat = await fs.lstat(candidate).catch(() => null);
    if (stat?.isDirectory() && !stat.isSymbolicLink()) {
      return fs.realpath(candidate);
    }
  }
  throw new WorkspaceManagerErrorV2(
    "known_host_directory_unavailable",
    `The local ${directory} directory could not be resolved safely.`,
  );
}

function requiredKnownHostDirectory(value: unknown): KnownHostDirectoryV2 {
  if (
    value !== "desktop" &&
    value !== "documents" &&
    value !== "downloads" &&
    value !== "vault_sibling_projects"
  ) {
    throw new WorkspaceManagerErrorV2(
      "invalid_arguments",
      "destinationRoot must be vault_sibling_projects, desktop, documents, or downloads.",
    );
  }
  return value;
}

function foregroundMissionNamesKnownHostDirectory(
  directory: KnownHostDirectoryV2,
  context: ScopedExtensionContextV1,
): boolean {
  const prompt = context.originalPrompt ?? "";
  const pattern =
    directory === "desktop"
      ? /\bdesktop\b/iu
      : directory === "documents"
        ? /\bdocuments?(?:\s+folder)?\b/iu
        : directory === "downloads"
          ? /\bdownloads?(?:\s+folder)?\b/iu
          : /\b(?:code|project|app|application|script|package|library|website|game|test\s+suite|implement|build|create)\b/iu;
  return Boolean(
    context.missionId &&
      /^run-/u.test(context.missionId) &&
      pattern.test(prompt),
  );
}

async function resolveSafeKnownHostRootV2(
  rawRoot: string,
  directory: KnownHostDirectoryV2,
): Promise<string> {
  if (!path.isAbsolute(rawRoot)) {
    throw new WorkspaceManagerErrorV2(
      "known_host_directory_invalid",
      `Resolved ${directory} directory must be absolute.`,
    );
  }
  const resolved = path.resolve(rawRoot);
  if (samePath(resolved, path.parse(resolved).root)) {
    throw new WorkspaceManagerErrorV2(
      "known_host_directory_invalid",
      `Resolved ${directory} directory cannot be a filesystem root.`,
    );
  }
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkspaceManagerErrorV2(
      "known_host_directory_invalid",
      `Resolved ${directory} path is not a safe directory.`,
    );
  }
  const canonical = await fs.realpath(resolved);
  if (!samePath(canonical, resolved)) {
    throw new WorkspaceManagerErrorV2(
      "known_host_directory_invalid",
      `Resolved ${directory} directory changed during canonical readback.`,
    );
  }
  return canonical;
}

async function snapshotWorkspaceDirectoryV2(
  manager: WorkspaceManagerV2,
  workspaceId: string,
  sourcePath: string,
): Promise<WorkspaceDirectoryExportSnapshotV2> {
  if (sourcePath) {
    const stat = await manager.stat(workspaceId, sourcePath);
    if (stat.kind !== "directory") {
      throw new WorkspaceManagerErrorV2(
        "host_export_source_not_directory",
        "Directory export sourcePath must identify a workspace directory.",
      );
    }
  }
  const entries: WorkspaceDirectoryExportEntryV2[] = [];
  const queue = [sourcePath];
  let bytes = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = await manager.list(workspaceId, current);
    for (const child of children) {
      const relative = sourcePath
        ? child.path.slice(sourcePath.length + 1)
        : child.path;
      if (!relative) continue;
      const entry: WorkspaceDirectoryExportEntryV2 = {
        path: relative,
        kind: child.kind,
        bytes: child.bytes,
        sha256: child.sha256,
      };
      entries.push(entry);
      if (entry.kind === "directory") {
        queue.push(child.path);
      } else {
        bytes += entry.bytes;
      }
      assertHostExportBudgetV2(entries.length, bytes);
    }
  }
  entries.sort(compareExportEntriesV2);
  return buildDirectoryExportSnapshotV2(sourcePath, entries);
}

function buildDirectoryExportSnapshotV2(
  sourcePath: string,
  entries: WorkspaceDirectoryExportEntryV2[],
): WorkspaceDirectoryExportSnapshotV2 {
  const files = entries.filter((entry) => entry.kind === "file").length;
  const directories = entries.length - files;
  const bytes = entries.reduce(
    (total, entry) => total + (entry.kind === "file" ? entry.bytes : 0),
    0,
  );
  assertHostExportBudgetV2(entries.length, bytes);
  return {
    sourcePath,
    entries,
    files,
    directories,
    bytes,
    fingerprint: sha256Json(entries),
  };
}

function assertHostExportBudgetV2(entries: number, bytes: number): void {
  if (entries > HOST_EXPORT_MAX_ENTRIES_V2) {
    throw new WorkspaceManagerErrorV2(
      "host_export_entry_budget_exceeded",
      `Directory export exceeds ${HOST_EXPORT_MAX_ENTRIES_V2} entries.`,
    );
  }
  if (bytes > HOST_EXPORT_MAX_BYTES_V2) {
    throw new WorkspaceManagerErrorV2(
      "host_export_byte_budget_exceeded",
      "Directory export exceeds 10 MiB.",
    );
  }
}

function compareExportEntriesV2(
  left: WorkspaceDirectoryExportEntryV2,
  right: WorkspaceDirectoryExportEntryV2,
): number {
  return left.path.localeCompare(right.path);
}

async function inspectHostExportDestinationV2(
  root: string,
  relativePath: string,
): Promise<{ absolutePath: string; exists: boolean }> {
  const normalized = assertWorkspaceRelativePathV2(
    relativePath,
    "destinationPath",
  );
  const absolutePath = path.resolve(root, ...normalized.split("/"));
  if (!insideHostRootV2(root, absolutePath)) {
    throw new WorkspaceManagerErrorV2(
      "host_export_path_escape",
      "Host export destination escaped its known directory root.",
    );
  }
  let cursor = root;
  let exists = true;
  const parts = normalized.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]!);
    const stat = await fs.lstat(cursor).catch((error) =>
      isMissingFsErrorV2(error) ? null : Promise.reject(error),
    );
    if (!stat) {
      exists = false;
      break;
    }
    if (stat.isSymbolicLink()) {
      throw new WorkspaceManagerErrorV2(
        "host_export_reparse_path",
        "Host export paths cannot traverse symlinks, junctions, or reparse points.",
      );
    }
    const canonical = await fs.realpath(cursor);
    if (!insideHostRootV2(root, canonical)) {
      throw new WorkspaceManagerErrorV2(
        "host_export_path_escape",
        "Host export path resolved outside its known directory root.",
      );
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new WorkspaceManagerErrorV2(
        "host_export_parent_conflict",
        "Host export destination has a non-directory parent.",
      );
    }
  }
  return { absolutePath, exists };
}

async function exportWorkspaceSnapshotToHostV2(input: {
  manager: WorkspaceManagerV2;
  workspaceId: string;
  snapshot: WorkspaceDirectoryExportSnapshotV2;
  root: string;
  destinationPath: string;
}): Promise<WorkspaceDirectoryExportSnapshotV2 & { absolutePath: string }> {
  const destination = await inspectHostExportDestinationV2(
    input.root,
    input.destinationPath,
  );
  if (destination.exists) {
    throw new WorkspaceManagerErrorV2(
      "host_export_destination_exists",
      "Host export destination already exists.",
    );
  }
  const createdFiles: string[] = [];
  const createdDirectories: string[] = [];
  try {
    const destinationParts = input.destinationPath.split("/");
    let cursor = input.root;
    for (const part of destinationParts.slice(0, -1)) {
      cursor = path.join(cursor, part);
      const stat = await fs.lstat(cursor).catch((error) =>
        isMissingFsErrorV2(error) ? null : Promise.reject(error),
      );
      if (stat) {
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new WorkspaceManagerErrorV2(
            "host_export_parent_conflict",
            "Host export parent is not a safe directory.",
          );
        }
        await assertSafeHostExportDirectoryV2(input.root, cursor);
        continue;
      }
      await fs.mkdir(cursor, { recursive: false });
      createdDirectories.push(cursor);
      await assertSafeHostExportDirectoryV2(input.root, cursor);
    }
    await fs.mkdir(destination.absolutePath, { recursive: false });
    createdDirectories.push(destination.absolutePath);
    await assertSafeHostExportDirectoryV2(
      input.root,
      destination.absolutePath,
    );

    for (const entry of input.snapshot.entries.filter(
      (item) => item.kind === "directory",
    )) {
      const absolute = path.join(
        destination.absolutePath,
        ...entry.path.split("/"),
      );
      await assertSafeHostExportDirectoryV2(input.root, path.dirname(absolute));
      await fs.mkdir(absolute, { recursive: false });
      createdDirectories.push(absolute);
      await assertSafeHostExportDirectoryV2(input.root, absolute);
    }
    for (const entry of input.snapshot.entries.filter(
      (item) => item.kind === "file",
    )) {
      const sourceWorkspacePath = input.snapshot.sourcePath
        ? `${input.snapshot.sourcePath}/${entry.path}`
        : entry.path;
      const source = await input.manager.read(
        input.workspaceId,
        sourceWorkspacePath,
      );
      if (source.sha256 !== entry.sha256 || source.bytes !== entry.bytes) {
        throw new WorkspaceManagerErrorV2(
          "host_export_source_drift",
          `Workspace source ${sourceWorkspacePath} changed during export.`,
        );
      }
      const absolute = path.join(
        destination.absolutePath,
        ...entry.path.split("/"),
      );
      await assertSafeHostExportDirectoryV2(input.root, path.dirname(absolute));
      await fs.writeFile(absolute, source.content, {
        encoding: "utf8",
        flag: "wx",
      });
      createdFiles.push(absolute);
    }
    const readback = await snapshotAbsoluteHostDirectoryV2(
      destination.absolutePath,
    );
    return { ...readback, absolutePath: destination.absolutePath };
  } catch (error) {
    for (const file of [...createdFiles].reverse()) {
      await fs.unlink(file).catch(() => undefined);
    }
    for (const directory of [...createdDirectories].reverse()) {
      await fs.rmdir(directory).catch(() => undefined);
    }
    throw error;
  }
}

async function snapshotAbsoluteHostDirectoryV2(
  absoluteRoot: string,
): Promise<WorkspaceDirectoryExportSnapshotV2> {
  const rootStat = await fs.lstat(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new WorkspaceManagerErrorV2(
      "host_export_readback_failed",
      "Export destination is not a safe directory.",
    );
  }
  const canonicalRoot = await fs.realpath(absoluteRoot);
  if (!samePath(canonicalRoot, absoluteRoot)) {
    throw new WorkspaceManagerErrorV2(
      "host_export_readback_failed",
      "Export destination canonical path changed.",
    );
  }
  const entries: WorkspaceDirectoryExportEntryV2[] = [];
  const queue: Array<{ absolute: string; relative: string }> = [
    { absolute: canonicalRoot, relative: "" },
  ];
  let bytes = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = await fs.readdir(current.absolute, {
      withFileTypes: true,
    });
    for (const child of children.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const relative = current.relative
        ? `${current.relative}/${child.name}`
        : child.name;
      const absolute = path.join(current.absolute, child.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new WorkspaceManagerErrorV2(
          "host_export_reparse_path",
          "Export readback rejects symlinks, junctions, and reparse points.",
        );
      }
      if (stat.isDirectory()) {
        entries.push({
          path: relative,
          kind: "directory",
          bytes: 0,
          sha256: null,
        });
        queue.push({ absolute, relative });
      } else if (stat.isFile() && stat.nlink === 1) {
        const content = await fs.readFile(absolute);
        bytes += content.byteLength;
        entries.push({
          path: relative,
          kind: "file",
          bytes: content.byteLength,
          sha256: sha256BufferV2(content),
        });
      } else {
        throw new WorkspaceManagerErrorV2(
          "host_export_unsupported_entry",
          `Export readback rejected unsupported entry ${relative}.`,
        );
      }
      assertHostExportBudgetV2(entries.length, bytes);
    }
  }
  entries.sort(compareExportEntriesV2);
  return buildDirectoryExportSnapshotV2("", entries);
}

function hostDirectoryExportReceiptV2(input: {
  action: PreparedActionV1;
  context: ScopedExtensionContextV1;
  destinationPath: string;
  snapshot: WorkspaceDirectoryExportSnapshotV2;
  commitKind: "committed" | "reconciled";
}): ActionReceiptV1 {
  const committedAt = input.context.now().toISOString();
  return {
    version: 1,
    id: `host-directory-export-${input.action.id}`,
    runId: input.action.runId,
    actionId: input.action.id,
    toolName: input.action.toolName,
    operation: "create",
    resource: {
      ...input.action.target,
      path: input.destinationPath,
      revision: input.snapshot.fingerprint,
    },
    relatedResources: input.action.relatedResources,
    message:
      `Exported ${input.snapshot.files} file(s) and ${input.snapshot.directories} ` +
      `director${input.snapshot.directories === 1 ? "y" : "ies"} to ${input.destinationPath}.`,
    payloadFingerprint: input.action.payloadFingerprint,
    grantId: input.context.authorizedAction!.grantId,
    idempotencyKey: input.action.idempotencyKey,
    startedAt: input.action.preparedAt,
    committedAt,
    commitKind: input.commitKind,
    readback: {
      status: "verified",
      checkedAt: committedAt,
      observedRevision: input.snapshot.fingerprint,
      observedFingerprint: input.snapshot.fingerprint,
    },
    effects: {
      bytesWritten: input.snapshot.bytes,
      affectedCount:
        input.snapshot.files + input.snapshot.directories + 1,
      changedFields: input.snapshot.entries
        .slice(0, 100)
        .map((entry) => entry.path),
    },
  };
}

function hostExportAbsentFingerprintV2(
  destinationRoot: KnownHostDirectoryV2,
  destinationPath: string,
  canonicalRoot: string,
): string {
  return sha256Json({
    destinationRoot,
    destinationPath,
    canonicalRoot,
    state: "absent",
  });
}

function insideHostRootV2(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function assertSafeHostExportDirectoryV2(
  root: string,
  candidate: string,
): Promise<void> {
  const resolved = path.resolve(candidate);
  if (!samePath(root, resolved) && !insideHostRootV2(root, resolved)) {
    throw new WorkspaceManagerErrorV2(
      "host_export_path_escape",
      "Host export directory escaped its known directory root.",
    );
  }
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkspaceManagerErrorV2(
      "host_export_reparse_path",
      "Host export paths cannot traverse symlinks, junctions, or reparse points.",
    );
  }
  const canonical = await fs.realpath(resolved);
  if (
    !samePath(canonical, resolved) ||
    (!samePath(root, canonical) && !insideHostRootV2(root, canonical))
  ) {
    throw new WorkspaceManagerErrorV2(
      "host_export_path_escape",
      "Host export directory changed during canonical readback.",
    );
  }
}

function isMissingFsErrorV2(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function sha256BufferV2(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function workspaceIdFrom(args: Record<string, unknown>, context: ScopedExtensionContextV1): string { return (optionalString(args.workspaceId) ?? context.rootMissionId ?? context.missionId ?? context.operationId ?? "adhoc").toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 128) || "adhoc"; }
function runId(context: ScopedExtensionContextV1): string { return context.rootMissionId ?? context.missionId ?? context.operationId ?? "adhoc"; }
function actionRunId(context: ScopedExtensionContextV1): string { return context.missionId ?? context.rootMissionId ?? context.operationId ?? "adhoc"; }
function requiredPath(args: Record<string, unknown>, ...names: string[]): string { for (const name of names) { const value = optionalString(args[name]); if (value) return assertWorkspaceRelativePathV2(value); } throw new WorkspaceManagerErrorV2("invalid_arguments", `${names[0]} is required.`); }
function requiredString(value: unknown, label: string, allowEmpty = false): string { if (typeof value !== "string" || (!allowEmpty && !value.length)) throw new WorkspaceManagerErrorV2("invalid_arguments", `${label} must be a string${allowEmpty ? "" : " with content"}.`); return value; }
function optionalString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function optionalInteger(value: unknown): number | undefined { return Number.isSafeInteger(value) ? Number(value) : undefined; }
function requiredFingerprint(value: unknown): string { if (!isSha256FingerprintV2(value)) throw new WorkspaceManagerErrorV2("invalid_arguments", "A SHA-256 fingerprint is required."); return value; }
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function sha256Json(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function sha256Canonical(value: unknown): string { return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`; }
function sha256Text(value: string): string { return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`; }

function applyExactReplacements(
  content: string,
  replacements: Array<{ oldText: string; newText: string; expectedOccurrences?: 1 }>,
): string {
  let next = content;
  for (const replacement of replacements) {
    const first = next.indexOf(replacement.oldText);
    if (first < 0 || next.indexOf(replacement.oldText, first + replacement.oldText.length) >= 0) {
      throw new WorkspaceManagerErrorV2("patch_mismatch", "Each exact patch oldText must match exactly once.");
    }
    next = `${next.slice(0, first)}${replacement.newText}${next.slice(first + replacement.oldText.length)}`;
  }
  return next;
}

function mutationChanges(
  targetPath: string,
  args: Record<string, JsonValueV1>,
): RepositoryFileChangeV2[] {
  const before = optionalString(args.expectedSha256);
  const after = optionalString(args.expectedAfterSha256);
  const destination = optionalString(args.destinationPath);
  if (destination) {
    const changes: RepositoryFileChangeV2[] = [{ path: destination, beforeSha256: null, afterSha256: after }];
    if (args.expectedTargetState === "existing" && args.mutationMode !== "copy") {
      changes.push({ path: targetPath, beforeSha256: before, afterSha256: null });
    }
    return changes;
  }
  return [{
    path: targetPath,
    beforeSha256: args.expectedTargetState === "absent" ? null : before,
    afterSha256: args.expectedKind === "directory" ? before : after,
  }];
}

/**
 * Resolve one approved export target without requiring the vault-sibling
 * container to exist before approval. The Obsidian host supplies the intended
 * `<vault parent>/<vault name> Agent Projects` container; this function binds
 * its existing canonical parent as the trusted root and prepends the fixed
 * container name to the model-supplied project path.
 */
async function resolveSafeHostExportTargetV2(
  rawRoot: string,
  directory: KnownHostDirectoryV2,
  requestedDestinationPath: string,
): Promise<{ root: string; destinationPath: string }> {
  const requested = assertWorkspaceRelativePathV2(
    requestedDestinationPath,
    "destinationPath",
  );
  if (directory !== "vault_sibling_projects") {
    return {
      root: await resolveSafeKnownHostRootV2(rawRoot, directory),
      destinationPath: requested,
    };
  }
  if (!path.isAbsolute(rawRoot)) {
    throw new WorkspaceManagerErrorV2(
      "known_host_directory_invalid",
      "Resolved vault-sibling project container must be absolute.",
    );
  }
  const container = path.resolve(rawRoot);
  const containerName = path.basename(container);
  if (
    !containerName.endsWith(" Agent Projects") ||
    containerName === " Agent Projects" ||
    /[<>:"/\\|?*\u0000-\u001f]/u.test(containerName)
  ) {
    throw new WorkspaceManagerErrorV2(
      "known_host_directory_invalid",
      "Vault-sibling project container name is invalid.",
    );
  }
  const root = await resolveSafeKnownHostRootV2(
    path.dirname(container),
    directory,
  );
  if (!samePath(path.join(root, containerName), container)) {
    throw new WorkspaceManagerErrorV2(
      "known_host_directory_invalid",
      "Vault-sibling project container changed during canonical readback.",
    );
  }
  return {
    root,
    destinationPath: assertWorkspaceRelativePathV2(
      `${containerName}/${requested}`,
      "destinationPath",
    ),
  };
}

export async function resolveVaultSiblingProjectsDirectoryV2(
  rawVaultRoot: string,
): Promise<string> {
  if (!path.isAbsolute(rawVaultRoot)) {
    throw new WorkspaceManagerErrorV2(
      "vault_root_invalid",
      "The active vault root must be absolute for project delivery.",
    );
  }
  const vaultRoot = path.resolve(rawVaultRoot);
  const stat = await fs.lstat(vaultRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkspaceManagerErrorV2(
      "vault_root_invalid",
      "The active vault root is not a safe local directory.",
    );
  }
  const canonicalVault = await fs.realpath(vaultRoot);
  if (!samePath(canonicalVault, vaultRoot)) {
    throw new WorkspaceManagerErrorV2(
      "vault_root_invalid",
      "The active vault root changed during canonical readback.",
    );
  }
  const vaultName = path.basename(canonicalVault).trim();
  if (!vaultName || /[<>:"/\\|?*\u0000-\u001f]/u.test(vaultName)) {
    throw new WorkspaceManagerErrorV2(
      "vault_root_invalid",
      "The active vault name is not safe for a sibling project container.",
    );
  }
  return path.join(path.dirname(canonicalVault), `${vaultName} Agent Projects`);
}

interface RepositoryMutationScopeBindingV2 extends Record<string, JsonValueV1> {
  path: string;
  projectId: string;
  projectRoot: string;
  allowedPath: string;
}

function repositoryWriteScopeOutputV2(profile: RepositoryProfileV2): {
  profileKey: string;
  projects: Array<{
    projectId: string;
    projectRoot: string;
    allowedPaths: string[];
  }>;
} {
  return {
    profileKey: profile.key,
    projects: profile.projects
      .map((project) => ({
        projectId: project.id,
        projectRoot: project.root,
        allowedPaths: [...project.allowedPaths].sort(),
      }))
      .sort((left, right) => left.projectId.localeCompare(right.projectId)),
  };
}

function resolveRepositoryMutationScopeV2(
  profile: RepositoryProfileV2,
  changes: readonly RepositoryFileChangeV2[],
): {
  bindings: RepositoryMutationScopeBindingV2[];
  fingerprint: string;
} {
  const projectAllowedPaths = repositoryWriteScopeOutputV2(profile).projects;
  const bindings: RepositoryMutationScopeBindingV2[] = [];
  const rejected: Array<{ path: string; matchedProjects: string[] }> = [];
  for (const change of [...changes].sort((left, right) => left.path.localeCompare(right.path))) {
    const matches = profile.projects.flatMap((project) =>
      project.allowedPaths
        .filter((allowedPath) => repositoryPathAtOrBelowV2(allowedPath, change.path))
        .map((allowedPath) => ({
          path: change.path,
          projectId: project.id,
          projectRoot: project.root,
          allowedPath,
        })),
    );
    const matchedProjects = [...new Set(matches.map((match) => match.projectId))].sort();
    if (matchedProjects.length !== 1) {
      rejected.push({ path: change.path, matchedProjects });
      continue;
    }
    const projectMatches = matches
      .filter((match) => match.projectId === matchedProjects[0])
      .sort((left, right) =>
        right.allowedPath.length - left.allowedPath.length ||
        left.allowedPath.localeCompare(right.allowedPath),
      );
    bindings.push(projectMatches[0]);
  }
  if (rejected.length > 0) {
    throw new WorkspaceManagerErrorV2(
      "repository_path_out_of_scope",
      [
        "Every affected repository path must resolve to exactly one trusted project allowedPaths scope.",
        `rejected=${JSON.stringify(rejected)}`,
        `projectAllowedPaths=${JSON.stringify(projectAllowedPaths)}`,
      ].join(" "),
    );
  }
  const canonicalBindings = bindings.sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.projectId.localeCompare(right.projectId) ||
    left.allowedPath.localeCompare(right.allowedPath),
  );
  return {
    bindings: canonicalBindings,
    fingerprint: sha256Canonical({
      version: 1,
      profileKey: profile.key,
      profileAllowedPaths: [...profile.allowedPaths].sort(),
      projectAllowedPaths,
      bindings: canonicalBindings,
    }),
  };
}

function repositoryPathAtOrBelowV2(
  allowedPath: string,
  candidatePath: string,
): boolean {
  return allowedPath === "." ||
    candidatePath === allowedPath ||
    candidatePath.startsWith(`${allowedPath}/`);
}

function samePath(left: string, right: string): boolean { return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; }
