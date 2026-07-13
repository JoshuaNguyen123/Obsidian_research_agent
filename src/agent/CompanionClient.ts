import {
  BrowserClickInput,
  BrowserExtractMarkdownInput,
  BrowserKeypressInput,
  BrowserObservation,
  BrowserOpenInput,
  BrowserScreenshotInput,
  BrowserScrollInput,
  BrowserTypeInput,
  MemorySearchInput,
  MemorySearchResult,
  MemoryWriteInput,
  SafetyDecision,
} from "./ToolContracts";
import type { BootstrapTokenLeaseV1 } from "../../packages/headless-runtime/src/backgroundContinuation";
import {
  normalizeCompanionBaseUrlV1,
  resolveCompanionBootstrapSessionV1,
} from "../../packages/headless-runtime/src/companionCredentialSession";
import {
  createCompanionSafetyAttestationV1,
  type CompanionBrowserActionV1,
} from "../../packages/headless-runtime/src/companionSafetyAttestation";
import type { MissionJsonValueV1 } from "../../packages/headless-runtime/src/missionGraphV3";

export interface CompanionHealth {
  ok: boolean;
  service: string;
  browserReady: boolean;
  memoryReady: boolean;
  coordinatorReady?: boolean;
  workerReady?: boolean;
  workerDiagnostic?: string | null;
  secureStorePersistent?: boolean;
  backgroundEnabled?: boolean;
  backgroundBlocker?: string | null;
  version?: string;
}

export class CompanionClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    baseUrl: string,
    private readonly timeoutMs = 15_000,
    fetchImpl?: typeof fetch,
    private readonly credential?: BootstrapTokenLeaseV1,
  ) {
    this.baseUrl = normalizeCompanionBaseUrlV1(baseUrl);
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async health(): Promise<CompanionHealth> {
    return this.get<CompanionHealth>("/health");
  }

  async open(input: BrowserOpenInput, decision: SafetyDecision): Promise<BrowserObservation> {
    return this.postBrowser(
      "/browser/open",
      "navigate",
      { url: input.url, missionMode: input.missionMode ?? "supervised" },
      decision,
      true,
    );
  }

  async observe(decision: SafetyDecision): Promise<BrowserObservation> {
    return this.postBrowser("/browser/observe", "observe", {}, decision, true);
  }

  async click(
    input: BrowserClickInput,
    observation: BrowserObservation,
    decision: SafetyDecision,
  ): Promise<BrowserObservation> {
    const candidateId = requireCandidateBinding(input.candidateId, "candidateId");
    const selector = requireCandidateBinding(input.selector, "selector");
    const candidateFingerprint = requireFingerprint(
      input.candidateFingerprint,
      "candidateFingerprint",
    );
    return this.postBrowser(
      "/browser/click",
      "click",
      {
        candidateId,
        selector,
        candidateFingerprint,
        button: input.button ?? "left",
        observedUrl: observation.url,
        observationFingerprint: requireObservationFingerprint(observation),
      },
      decision,
      true,
    );
  }

  async type(
    input: BrowserTypeInput,
    observation: BrowserObservation,
    decision: SafetyDecision,
  ): Promise<BrowserObservation> {
    const candidateId = requireCandidateBinding(input.candidateId, "candidateId");
    const selector = requireCandidateBinding(input.selector, "selector");
    const candidateFingerprint = requireFingerprint(
      input.candidateFingerprint,
      "candidateFingerprint",
    );
    return this.postBrowser(
      "/browser/type",
      "type",
      {
        candidateId,
        selector,
        candidateFingerprint,
        text: input.text,
        clearFirst: input.clearFirst ?? false,
        observedUrl: observation.url,
        observationFingerprint: requireObservationFingerprint(observation),
      },
      decision,
      true,
    );
  }

  async keypress(
    input: BrowserKeypressInput,
    observation: BrowserObservation,
    decision: SafetyDecision,
  ): Promise<BrowserObservation> {
    const candidateId = requireCandidateBinding(input.candidateId, "candidateId");
    const selector = requireCandidateBinding(input.selector, "selector");
    const candidateFingerprint = requireFingerprint(
      input.candidateFingerprint,
      "candidateFingerprint",
    );
    return this.postBrowser(
      "/browser/keypress",
      "keypress",
      {
        key: input.key,
        candidateId,
        selector,
        candidateFingerprint,
        observedUrl: observation.url,
        observationFingerprint: requireObservationFingerprint(observation),
      },
      decision,
      true,
    );
  }

  async scroll(input: BrowserScrollInput, decision: SafetyDecision): Promise<BrowserObservation> {
    return this.postBrowser(
      "/browser/scroll",
      "scroll",
      { direction: input.direction, amount: input.amount ?? 700 },
      decision,
      true,
    );
  }

  async screenshot(
    input: BrowserScreenshotInput,
    decision: SafetyDecision,
  ): Promise<{ screenshotPath: string }> {
    return this.postBrowser(
      "/browser/screenshot",
      "screenshot",
      { fullPage: input.fullPage ?? false },
      decision,
      false,
    );
  }

  async extractMarkdown(
    input: BrowserExtractMarkdownInput,
    decision: SafetyDecision,
  ): Promise<{ url: string; title?: string; markdown: string }> {
    return this.postBrowser(
      "/browser/extract_markdown",
      "extract",
      { includeLinks: input.includeLinks ?? true, maxChars: input.maxChars ?? 60_000 },
      decision,
      false,
    );
  }

  async writeMemory(input: MemoryWriteInput): Promise<{ id: string }> {
    return this.post<MemoryWriteInput, { id: string }>("/memory/write", input);
  }

  async searchMemory(input: MemorySearchInput): Promise<{ results: MemorySearchResult[] }> {
    return this.post<MemorySearchInput, { results: MemorySearchResult[] }>(
      "/memory/search",
      input,
    );
  }

  private async postBrowser<TResponse>(
    path: string,
    action: CompanionBrowserActionV1,
    payload: Record<string, MissionJsonValueV1>,
    decision: SafetyDecision,
    observationResponse: boolean,
  ): Promise<TResponse> {
    if (decision.status !== "allow") {
      throw new Error("Companion browser action requires a host allow decision.");
    }
    const safetyDecision = await createCompanionSafetyAttestationV1({
      credential: this.requireCredential(),
      action,
      payload,
      policyDecision: {
        status: "allow",
        risk: decision.risk,
        reason: decision.reason,
        policyTags: decision.policyTags,
      },
    });
    const response = await this.post<Record<string, unknown>, TResponse>(path, {
      ...payload,
      safetyDecision,
    });
    if (observationResponse) requireObservationFingerprint(response as BrowserObservation);
    return response;
  }

  private async get<TResponse>(path: string): Promise<TResponse> {
    return this.request<TResponse>(path, { method: "GET" });
  }

  private async post<TInput, TResponse>(path: string, input: TInput): Promise<TResponse> {
    const body = JSON.stringify(input);
    if (new TextEncoder().encode(body).byteLength > 1_048_576) {
      throw new Error("Companion request exceeded its byte limit.");
    }
    return this.request<TResponse>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  }

  private requireCredential(): BootstrapTokenLeaseV1 {
    const credential =
      this.credential ?? resolveCompanionBootstrapSessionV1(this.baseUrl)?.credential;
    if (!credential) {
      throw new Error("Companion authentication is not configured for this process session.");
    }
    return credential;
  }

  private async request<TResponse>(path: string, init: RequestInit): Promise<TResponse> {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.requireCredential().withToken((token) =>
        this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          credentials: "omit",
          cache: "no-store",
          headers: {
            ...headersToRecord(init.headers),
            "Cache-Control": "no-store",
            Authorization: `Bearer ${token}`,
          },
          signal: controller.signal,
        }),
      );
      if (!response.ok) {
        const text = await readResponseTextBounded(response, 16_384).catch(() => "");
        if (response.status === 401 || response.status === 403) {
          throw new Error("Companion authentication failed.");
        }
        throw new Error(
          `Companion request failed: ${response.status} ${sanitizeCompanionError(text)}`,
        );
      }
      return JSON.parse(await readResponseTextBounded(response, 1_048_576)) as TResponse;
    } finally {
      globalThis.clearTimeout(timer);
    }
  }
}

function requireObservationFingerprint(observation: BrowserObservation): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(observation?.observationFingerprint ?? "")) {
    throw new Error("Companion returned no trusted browser observation fingerprint.");
  }
  return observation.observationFingerprint;
}

function requireCandidateBinding(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`Companion browser ${field} must come from a trusted observation.`);
  }
  return normalized;
}

function requireFingerprint(value: string | undefined, field: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value ?? "")) {
    throw new Error(`Companion browser ${field} must come from a trusted observation.`);
  }
  return value!;
}

async function readResponseTextBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Companion response exceeded its byte limit.");
      }
      output += decoder.decode(value, { stream: true });
    }
    return output + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  const record: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function sanitizeCompanionError(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(token|secret|password)\s*[=:]\s*[^\s,;}]+/gi, "$1=[REDACTED]")
    .replace(/\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .slice(0, 4_096);
}
