import type { PreparedAction, ToolDescriptor } from "./actions";
import type { MissionBindingGrantV1, MissionNodeV3 } from "./missionGraphV3";
import { normalizeVaultPath } from "../tools/validation";
import { extractExplicitJupyterNotebookPathsV1 } from "./jupyterReflectionIntent";

type Node = Pick<MissionNodeV3, "executionHost" | "effect" | "status" | "allowedTools" | "destination" | "resourceLocks">;

export function notebookExecutionPathV1(prompt: string): string | null {
  const paths=extractExplicitJupyterNotebookPathsV1(prompt),qualified=paths.filter(path=>path.includes("/"));
  const target=qualified.length===1?qualified[0]:paths.length===1?paths[0]:null;
  return target&&paths.every(path=>path===target||path===target.slice(target.lastIndexOf("/")+1))?target:null;
}

/** Scope eligibility only. The existing policy still requires exact prepared approval. */
export function notebookGraphExecutionScopeV1(input: {
  prompt: string; toolName: string; descriptor: ToolDescriptor; action: PreparedAction;
  node: Node | null | undefined; binding: MissionBindingGrantV1 | null | undefined;
}): boolean {
  const {descriptor, action, node, binding, toolName} = input;
  if (!node || !binding || !["run_notebook", "run_notebook_cells"].includes(toolName) ||
      descriptor.name !== toolName || action.toolName !== toolName ||
      descriptor.effect !== "execution" || descriptor.capability.system !== "vault" ||
      descriptor.capability.resourceType !== "notebook" || descriptor.capability.action !== "execute" ||
      action.target.system !== "vault" || action.target.resourceType !== "notebook" ||
      descriptor.execution.preparation !== "required" || descriptor.approval.allowPromptGrant !== false ||
      descriptor.approval.allowPersistentGrant !== false || descriptor.approval.fallback !== "exact" ||
      descriptor.durability.receipt !== true || descriptor.durability.readback !== "required") return false;
  if (node.executionHost !== "obsidian_core" || node.effect !== "execution" ||
      !["running", "waiting_approval"].includes(node.status) || node.allowedTools.length !== 1 ||
      node.allowedTools[0] !== toolName || node.destination?.effect !== "execution" ||
      node.destination.bindingId !== binding.id || binding.kind !== "notebook" ||
      !binding.allowedEffects.includes("execution") ||
      binding.allowedEffects.some(effect => effect !== "read" && effect !== "execution") ||
      !/^sha256:[a-f0-9]{64}$/u.test(binding.destinationFingerprint) ||
      !node.resourceLocks.some(lock => lock.bindingId === binding.id && lock.mode === "exclusive")) return false;
  const path = action.target.path;
  if (typeof path !== "string" || !path.toLowerCase().endsWith(".ipynb") ||
      action.target.id !== path || action.normalizedArgs.path !== path ||
      typeof action.expectedTargetRevision !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(action.expectedTargetRevision) ||
      action.normalizedArgs.source_sha256 !== action.expectedTargetRevision ||
      node.destination.selector !== path) return false;
  try { if (normalizeVaultPath(path) !== path) return false; } catch { return false; }
  const affirmative = input.prompt.replace(/\b(?:do\s+not|don't|never|without|no)\b[^.!?;,\n]*/giu, "");
  if (/^\s*(?:how|why|what|explain|describe)\b/iu.test(input.prompt) ||
      /\b(?:do\s+not|don't|never)\b[^.!?;,\n]{0,60}\b(?:run|execute)\b/iu.test(input.prompt) ||
      !/\b(?:run|execute|restart|reproduce)\b/iu.test(affirmative)) return false;
  return notebookExecutionPathV1(affirmative)===path;
}
