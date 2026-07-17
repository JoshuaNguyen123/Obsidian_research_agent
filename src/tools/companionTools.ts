import { CompanionClient, type CompanionHealth } from "../agent/CompanionClient";
import { SafetyPolicy, type SafetyContext } from "../agent/SafetyPolicy";
import type {
  BrowserClickInput,
  BrowserKeypressInput,
  BrowserObservation,
  ClickableCandidate,
  BrowserOpenInput,
  BrowserTypeInput,
  MemoryKind,
  MemoryWriteInput,
  SafetyDecision,
} from "../agent/ToolContracts";
import type { AgentTool, ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";
import {
  getOptionalBoolean,
  getOptionalInteger,
  getOptionalString,
  getRequiredString,
} from "./validation";

const safetyPolicy = new SafetyPolicy();

export function createCompanionTools(): AgentTool[] {
  return [
    browserOpenPageTool,
    browserObserveTool,
    browserClickTool,
    browserTypeTool,
    browserKeypressTool,
    browserScrollTool,
    browserScreenshotTool,
    browserExtractMarkdownTool,
    memorySearchTool,
    memoryWriteObservationTool,
    memoryWriteTaskSummaryTool,
    memoryWriteProceduralTool,
    memoryWriteSourceTool,
    memoryForgetTool,
    memoryClearExperienceTool,
  ];
}

export const browserOpenPageTool: AgentTool = {
  name: "browser_open_page",
  description:
    "Open a safe HTTP/HTTPS page in the visible local companion browser and return page observation state.",
  parameters: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string" },
      missionMode: {
        type: "string",
        enum: ["supervised", "extract_only"],
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const input: BrowserOpenInput = {
      url: getRequiredString(args, "url"),
      missionMode:
        args.missionMode === "extract_only" ? "extract_only" : "supervised",
    };
    const health = await getHealth(context);
    const safety = safetyPolicy.evaluateBrowserOpen(input, buildSafetyContext(context, health));
    if (safety.status !== "allow") {
      return blockedOutput("browser_open_page", safety);
    }

    const observation = await client(context).open({
      ...input,
      missionMode: input.missionMode ?? context.settings.defaultBrowserMissionMode,
    }, safety);
    return {
      status: "ok",
      safetyDecision: safety,
      ...observation,
    };
  },
};

const browserObserveTool: AgentTool = {
  name: "browser_observe",
  description:
    "Observe the current visible companion browser page: URL, title, text summary, screenshot path, candidates, and state hints.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async execute(_args, context) {
    const health = await getHealth(context);
    const safety = safetyPolicy.evaluateLowRiskObservation(
      buildSafetyContext(context, health),
    );
    if (safety.status !== "allow") {
      return blockedOutput("browser_observe", safety);
    }

    return {
      status: "ok",
      safetyDecision: safety,
      ...(await client(context).observe(safety)),
    };
  },
};

const browserClickTool: AgentTool = {
  name: "browser_click",
  description:
    "Click exactly one visible browser candidate, selector, or coordinate after safety checks.",
  parameters: {
    type: "object",
    properties: {
      candidateId: { type: "string" },
      selector: { type: "string" },
      x: { type: "number" },
      y: { type: "number" },
      button: { type: "string", enum: ["left", "middle", "right"] },
      candidateLabel: { type: "string" },
      candidateRole: { type: "string" },
      candidateHref: { type: "string" },
      visibleText: { type: "string" },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const input: BrowserClickInput = {
      candidateId: getOptionalString(args, "candidateId"),
      selector: getOptionalString(args, "selector"),
      x: getOptionalNumber(args, "x"),
      y: getOptionalNumber(args, "y"),
      button:
        args.button === "middle" || args.button === "right"
          ? args.button
          : "left",
    };
    const health = await getHealth(context);
    const companion = client(context);
    const observationSafety = safetyPolicy.evaluateLowRiskObservation(
      buildSafetyContext(context, health),
    );
    if (observationSafety.status !== "allow") {
      return blockedOutput("browser_click", observationSafety);
    }
    const observation = await companion.observe(observationSafety);
    const trusted = resolveTrustedCandidate(input, observation);
    if (!trusted) {
      return {
        status: "blocked",
        reason: "The requested click target is not present in the trusted current observation.",
      };
    }
    const safety = safetyPolicy.evaluateBrowserClick(
      trusted.input,
      buildSafetyContext(context, health, {
        currentUrl: observation.url,
        visibleText: observation.visibleText,
        candidateLabel: trusted.candidate.label,
        candidateRole: trusted.candidate.role,
        candidateHref: trusted.candidate.href,
      }),
    );
    if (safety.status !== "allow") {
      return blockedOutput("browser_click", safety);
    }

    return {
      status: "ok",
      safetyDecision: safety,
      ...(await companion.click(trusted.input, observation, safety)),
    };
  },
};

const browserTypeTool: AgentTool = {
  name: "browser_type",
  description:
    "Type safe text into one visible browser text/search field after safety checks. Never use for credentials.",
  parameters: {
    type: "object",
    required: ["text"],
    properties: {
      candidateId: { type: "string" },
      selector: { type: "string" },
      text: { type: "string" },
      clearFirst: { type: "boolean" },
      candidateLabel: { type: "string" },
      candidateRole: { type: "string" },
      visibleText: { type: "string" },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const input: BrowserTypeInput = {
      candidateId: getOptionalString(args, "candidateId"),
      selector: getOptionalString(args, "selector"),
      text: getRequiredString(args, "text"),
      clearFirst: getOptionalBoolean(args, "clearFirst") ?? false,
    };
    const health = await getHealth(context);
    const companion = client(context);
    const observationSafety = safetyPolicy.evaluateLowRiskObservation(
      buildSafetyContext(context, health),
    );
    if (observationSafety.status !== "allow") {
      return blockedOutput("browser_type", observationSafety);
    }
    const observation = await companion.observe(observationSafety);
    const trusted = resolveTrustedCandidate(input, observation);
    if (!trusted) {
      return {
        status: "blocked",
        reason: "The requested typing target is not present in the trusted current observation.",
      };
    }
    const trustedInput: BrowserTypeInput = {
      candidateId: trusted.input.candidateId,
      selector: trusted.input.selector,
      text: input.text,
      clearFirst: input.clearFirst,
    };
    const safety = safetyPolicy.evaluateBrowserType(
      trustedInput,
      buildSafetyContext(context, health, {
        currentUrl: observation.url,
        visibleText: observation.visibleText,
        candidateLabel: trusted.candidate.label,
        candidateRole: trusted.candidate.role,
        candidateHref: trusted.candidate.href,
      }),
    );
    if (safety.status !== "allow") {
      return blockedOutput("browser_type", safety);
    }

    return {
      status: "ok",
      safetyDecision: safety,
      ...(await companion.type(trustedInput, observation, safety)),
    };
  },
};

const browserKeypressTool: AgentTool = {
  name: "browser_keypress",
  description: "Send one keypress to the visible companion browser after safety checks.",
  parameters: {
    type: "object",
    required: ["key"],
    properties: {
      key: { type: "string" },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const health = await getHealth(context);
    const companion = client(context);
    const observationSafety = safetyPolicy.evaluateLowRiskObservation(
      buildSafetyContext(context, health),
    );
    if (observationSafety.status !== "allow") {
      return blockedOutput("browser_keypress", observationSafety);
    }
    const observation = await companion.observe(observationSafety);
    const key = getRequiredString(args, "key");
    const focused = resolveTrustedFocusedCandidate(observation);
    if (!focused) {
      return {
        status: "blocked",
        reason: "No single focused control is bound to the trusted current observation.",
      };
    }
    const input: BrowserKeypressInput = {
      key,
      candidateId: focused.id,
      selector: focused.selector!,
      candidateFingerprint: focused.candidateFingerprint,
    };
    const safety = safetyPolicy.evaluateBrowserKeypress(
      input,
      buildSafetyContext(context, health, {
        currentUrl: observation.url,
        visibleText: observation.visibleText,
        candidateLabel: focused.label,
        candidateRole: focused.role,
        candidateHref: focused.href,
      }),
    );
    if (safety.status !== "allow") {
      return blockedOutput("browser_keypress", safety);
    }

    return {
      status: "ok",
      safetyDecision: safety,
      ...(await companion.keypress(input, observation, safety)),
    };
  },
};

const browserScrollTool: AgentTool = {
  name: "browser_scroll",
  description: "Scroll the visible companion browser once and return the new observation.",
  parameters: {
    type: "object",
    required: ["direction"],
    properties: {
      direction: { type: "string", enum: ["up", "down", "left", "right"] },
      amount: { type: "integer" },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const direction = getDirection(args.direction);
    const health = await getHealth(context);
    const safety = safetyPolicy.evaluateLowRiskObservation(
      buildSafetyContext(context, health),
    );
    if (safety.status !== "allow") {
      return blockedOutput("browser_scroll", safety);
    }

    return {
      status: "ok",
      safetyDecision: safety,
      ...(await client(context).scroll({
        direction,
        amount: getOptionalInteger(args, "amount"),
      }, safety)),
    };
  },
};

const browserScreenshotTool: AgentTool = {
  name: "browser_screenshot",
  description: "Capture a screenshot from the visible companion browser.",
  parameters: {
    type: "object",
    properties: {
      fullPage: { type: "boolean" },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const health = await getHealth(context);
    const safety = safetyPolicy.evaluateLowRiskObservation(
      buildSafetyContext(context, health),
    );
    if (safety.status !== "allow") {
      return blockedOutput("browser_screenshot", safety);
    }

    return {
      status: "ok",
      safetyDecision: safety,
      ...(await client(context).screenshot({
        fullPage: getOptionalBoolean(args, "fullPage") ?? false,
      }, safety)),
    };
  },
};

export const browserExtractMarkdownTool: AgentTool = {
  name: "browser_extract_markdown",
  description: "Extract readable markdown from the current companion browser page.",
  parameters: {
    type: "object",
    properties: {
      includeLinks: { type: "boolean" },
      maxChars: { type: "integer" },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const health = await getHealth(context);
    const safety = safetyPolicy.evaluateLowRiskObservation(
      buildSafetyContext(context, health),
    );
    if (safety.status !== "allow") {
      return blockedOutput("browser_extract_markdown", safety);
    }

    return {
      status: "ok",
      safetyDecision: safety,
      ...(await client(context).extractMarkdown({
        includeLinks: getOptionalBoolean(args, "includeLinks") ?? true,
        maxChars: getOptionalInteger(args, "maxChars"),
      }, safety)),
    };
  },
};

const memorySearchTool: AgentTool = {
  name: "memory_search",
  description: "Search explicit local companion memories before research, writing, design, or browser-learning work.",
  parameters: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      kinds: { type: "array", items: { type: "string" } },
      tags: { type: "array", items: { type: "string" } },
      limit: { type: "integer" },
      minScore: { type: "number" },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const block = await getMemoryBlockReason(context);
    if (block) {
      return block;
    }

    return client(context).searchMemory({
      vaultScopeId: requireVaultScopeId(context),
      query: getRequiredString(args, "query"),
      kinds: getOptionalMemoryKinds(args.kinds),
      tags: getOptionalStringList(args.tags),
      limit: getOptionalInteger(args, "limit"),
      minScore: getOptionalNumber(args, "minScore"),
    });
  },
};

const memoryWriteObservationTool = createMemoryWriteTool(
  "memory_write_observation",
  "episodic",
  "Write an explicit episodic observation memory after a meaningful task or browser observation.",
);

const memoryWriteTaskSummaryTool = createMemoryWriteTool(
  "memory_write_task_summary",
  "episodic",
  "Write an explicit task-summary memory after a completed research, writing, or design task.",
);

const memoryWriteProceduralTool = createMemoryWriteTool(
  "memory_write_procedural",
  "procedural",
  "Write a reusable local procedure or learned strategy memory when evidence is strong.",
);

const memoryWriteSourceTool = createMemoryWriteTool(
  "memory_write_source",
  "source",
  "Write a source memory with URL/title metadata for extracted or cited pages.",
);

function createMemoryWriteTool(
  name: string,
  defaultKind: MemoryKind,
  description: string,
): AgentTool {
  return {
    name,
    description,
    parameters: {
      type: "object",
      required: ["content", "confidence"],
      properties: {
        kind: {
          type: "string",
          enum: ["episodic", "semantic", "procedural", "source"],
        },
        content: { type: "string" },
        confidence: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
        sourceUrl: { type: "string" },
        sourceTitle: { type: "string" },
        taskId: { type: "string" },
      },
      additionalProperties: false,
    },
    async execute(args, context) {
      const block = await getMemoryBlockReason(context);
      if (block) {
        return block;
      }

      const input: MemoryWriteInput = {
        vaultScopeId: requireVaultScopeId(context),
        kind: getOptionalMemoryKind(args.kind) ?? defaultKind,
        content: getRequiredString(args, "content"),
        confidence: getConfidence(args.confidence),
        tags: getOptionalStringList(args.tags),
        sourceUrl: getOptionalString(args, "sourceUrl"),
        sourceTitle: getOptionalString(args, "sourceTitle"),
        taskId: getOptionalString(args, "taskId"),
      };

      return client(context).writeMemory(input);
    },
  };
}

const memoryForgetTool: AgentTool = {
  name: "memory_forget",
  description:
    "Delete one explicit Companion experience-memory record from the current vault scope and return a deletion receipt.",
  parameters: {
    type: "object",
    required: ["memoryId"],
    properties: { memoryId: { type: "string" } },
    additionalProperties: false,
  },
  async execute(args, context) {
    const block = await getMemoryBlockReason(context);
    if (block) return block;
    return client(context).deleteMemory({
      vaultScopeId: requireVaultScopeId(context),
      memoryId: getRequiredString(args, "memoryId"),
    });
  },
};

const memoryClearExperienceTool: AgentTool = {
  name: "memory_clear_experience",
  description:
    "Clear Companion experience-memory records only from the current vault scope, optionally by kind, and return a deletion receipt. Clear chat does not invoke this tool.",
  parameters: {
    type: "object",
    properties: {
      kinds: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const block = await getMemoryBlockReason(context);
    if (block) return block;
    return client(context).clearMemory({
      vaultScopeId: requireVaultScopeId(context),
      kinds: getOptionalMemoryKinds(args.kinds),
    });
  },
};

async function getMemoryBlockReason(
  context: ToolExecutionContext,
): Promise<false | { status: "blocked"; reason: string }> {
  if (!context.settings.experienceMemoryEnabled) {
    return {
      status: "blocked",
      reason: "Experience memory is disabled in settings.",
    };
  }
  const health = await getHealth(context);
  if (!health?.ok || !health.memoryReady) {
    return {
      status: "blocked",
      reason: "Companion memory service is unavailable.",
    };
  }
  return false;
}

function client(context: ToolExecutionContext): CompanionClient {
  return new CompanionClient(context.settings.companionBaseUrl);
}

function requireVaultScopeId(context: ToolExecutionContext): string {
  const scope = context.settings.vaultScopeId;
  if (typeof scope !== "string" || !/^vault_[a-f0-9]{64}$/.test(scope)) {
    throw new ToolExecutionError(
      "invalid_state",
      "Experience memory requires an initialized vault scope.",
    );
  }
  return scope;
}

async function getHealth(context: ToolExecutionContext): Promise<CompanionHealth | null> {
  try {
    return await client(context).health();
  } catch {
    return null;
  }
}

function buildSafetyContext(
  context: ToolExecutionContext,
  health: CompanionHealth | null,
  args: Record<string, unknown> = {},
): SafetyContext {
  return {
    isDesktop: isDesktopRuntime(),
    browserToolsEnabled: context.settings.browserToolsEnabled,
    experienceMemoryEnabled: context.settings.experienceMemoryEnabled,
    companionHealthy: Boolean(health?.ok && health.browserReady),
    currentUrl: getOptionalString(args, "currentUrl"),
    visibleText: getOptionalString(args, "visibleText"),
    candidateLabel: getOptionalString(args, "candidateLabel"),
    candidateRole: getOptionalString(args, "candidateRole"),
    candidateHref: getOptionalString(args, "candidateHref"),
    explicitUserApproval: context.userApprovalGranted === true,
  };
}

function resolveTrustedCandidate(
  input: {
    candidateId?: string;
    selector?: string;
    x?: number;
    y?: number;
    button?: "left" | "middle" | "right";
  },
  observation: BrowserObservation,
): { candidate: ClickableCandidate; input: BrowserClickInput } | null {
  const requestedIdentity = Boolean(input.candidateId || input.selector);
  const requestedPoint = Number.isFinite(input.x) && Number.isFinite(input.y);
  if (!requestedIdentity && !requestedPoint) return null;
  const candidate = observation.candidates.find((item) => {
    if (!isBoundCandidate(item)) return false;
    if (input.candidateId && item.id !== input.candidateId) return false;
    if (input.selector && item.selector !== input.selector) return false;
    if (requestedPoint) {
      const bounds = item.bounds;
      if (
        !bounds ||
        input.x! < bounds.x ||
        input.y! < bounds.y ||
        input.x! > bounds.x + bounds.width ||
        input.y! > bounds.y + bounds.height
      ) {
        return false;
      }
    }
    return true;
  });
  if (!candidate) return null;
  return {
    candidate,
    input: {
      candidateId: candidate.id,
      selector: candidate.selector,
      candidateFingerprint: candidate.candidateFingerprint,
      button: input.button ?? "left",
    },
  };
}

function resolveTrustedFocusedCandidate(
  observation: BrowserObservation,
): ClickableCandidate | null {
  const focused = observation.candidates.filter(
    (candidate) => candidate.focused === true && isBoundCandidate(candidate),
  );
  return focused.length === 1 ? focused[0] : null;
}

function isBoundCandidate(candidate: ClickableCandidate): boolean {
  return Boolean(
    candidate.visible &&
      candidate.enabled &&
      candidate.selector &&
      /^sha256:[a-f0-9]{64}$/.test(candidate.candidateFingerprint),
  );
}

function isDesktopRuntime(): boolean {
  const userAgent =
    typeof navigator === "object" && typeof navigator.userAgent === "string"
      ? navigator.userAgent
      : "";
  if (!userAgent) {
    return true;
  }
  return !/\b(Android|iPhone|iPad|iPod|Mobile)\b/i.test(userAgent);
}

function blockedOutput(toolName: string, safetyDecision: SafetyDecision) {
  const requiresApproval = safetyDecision.status === "require_approval";
  return {
    status: requiresApproval ? "requires_approval" : "blocked",
    toolName,
    safetyDecision,
    reason: safetyDecision.reason,
    approval: requiresApproval
      ? {
          id: buildApprovalId(toolName, safetyDecision),
          toolName,
          risk: safetyDecision.risk,
          reason: safetyDecision.reason,
          oneShot: true,
          expiresInMs: 120000,
        }
      : undefined,
  };
}

function buildApprovalId(toolName: string, safetyDecision: SafetyDecision): string {
  return `approval_${toolName}_${hashApprovalKey(
    `${safetyDecision.reason}:${safetyDecision.policyTags.join(",")}`,
  )}`;
}

function hashApprovalKey(value: string): string {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash).toString(36) || "0";
}

function getDirection(value: unknown): "up" | "down" | "left" | "right" {
  if (value === "up" || value === "down" || value === "left" || value === "right") {
    return value;
  }
  throw new ToolExecutionError(
    "invalid_arguments",
    "direction must be up, down, left, or right.",
  );
}

function getOptionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolExecutionError("invalid_arguments", `${key} must be a finite number.`);
  }
  return value;
}

function getConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "confidence must be a number between 0 and 1.",
    );
  }
  return value;
}

function getOptionalStringList(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "Expected an array of strings when provided.",
    );
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function getOptionalMemoryKinds(value: unknown): MemoryKind[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ToolExecutionError("invalid_arguments", "kinds must be an array.");
  }
  return value.map((item) => getOptionalMemoryKind(item)).filter(isMemoryKind);
}

function getOptionalMemoryKind(value: unknown): MemoryKind | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (isMemoryKind(value)) {
    return value;
  }
  throw new ToolExecutionError("invalid_arguments", "Invalid memory kind.");
}

function isMemoryKind(value: unknown): value is MemoryKind {
  return (
    value === "episodic" ||
    value === "semantic" ||
    value === "procedural" ||
    value === "source"
  );
}
