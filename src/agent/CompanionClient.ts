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
} from "./ToolContracts";

export interface CompanionHealth {
  ok: boolean;
  service: string;
  browserReady: boolean;
  memoryReady: boolean;
  version?: string;
}

export class CompanionClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 15_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async health(): Promise<CompanionHealth> {
    return this.get<CompanionHealth>("/health");
  }

  async open(input: BrowserOpenInput): Promise<BrowserObservation> {
    return this.post<BrowserOpenInput, BrowserObservation>("/browser/open", input);
  }

  async observe(): Promise<BrowserObservation> {
    return this.post<Record<string, never>, BrowserObservation>("/browser/observe", {});
  }

  async click(input: BrowserClickInput): Promise<BrowserObservation> {
    return this.post<BrowserClickInput, BrowserObservation>("/browser/click", input);
  }

  async type(input: BrowserTypeInput): Promise<BrowserObservation> {
    return this.post<BrowserTypeInput, BrowserObservation>("/browser/type", input);
  }

  async keypress(input: BrowserKeypressInput): Promise<BrowserObservation> {
    return this.post<BrowserKeypressInput, BrowserObservation>("/browser/keypress", input);
  }

  async scroll(input: BrowserScrollInput): Promise<BrowserObservation> {
    return this.post<BrowserScrollInput, BrowserObservation>("/browser/scroll", input);
  }

  async screenshot(input: BrowserScreenshotInput): Promise<{ screenshotPath: string }> {
    return this.post<BrowserScreenshotInput, { screenshotPath: string }>(
      "/browser/screenshot",
      input,
    );
  }

  async extractMarkdown(
    input: BrowserExtractMarkdownInput,
  ): Promise<{ url: string; title?: string; markdown: string }> {
    return this.post<
      BrowserExtractMarkdownInput,
      { url: string; title?: string; markdown: string }
    >("/browser/extract_markdown", input);
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

  private async get<TResponse>(path: string): Promise<TResponse> {
    return this.request<TResponse>(path, { method: "GET" });
  }

  private async post<TInput, TResponse>(
    path: string,
    input: TInput,
  ): Promise<TResponse> {
    return this.request<TResponse>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  private async request<TResponse>(
    path: string,
    init: RequestInit,
  ): Promise<TResponse> {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Companion request failed: ${response.status} ${text}`);
      }

      return (await response.json()) as TResponse;
    } finally {
      globalThis.clearTimeout(timer);
    }
  }
}
