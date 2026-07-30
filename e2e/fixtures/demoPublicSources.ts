import type { Page } from "@playwright/test";

import { NATIVE_CORE_PLUGIN_ID } from "./nativeObsidianHarness";

export interface DemoPublicSourceMetricsV1 {
  searchTransportCalls: number;
  allowedFetchTransportCalls: number;
  blockedFetchAttempts: number;
  fetchedUrls: string[];
}

/**
 * Scope a recording run to the two public sources named by the user.
 *
 * Allowed fetches still use the production web transport. Search responses are
 * narrowed to the same allowlist, and any attempted fetch outside it is
 * rejected before network dispatch. No content, tool result, receipt, or model
 * response is fabricated.
 */
export async function installDemoPublicSourceBoundaryV1(
  page: Page,
  allowedUrls: readonly string[],
): Promise<void> {
  await page.evaluate(
    ({ pluginId, allowedUrls }) => {
      const win = window as typeof window & {
        __demoPublicSourceMetrics?: DemoPublicSourceMetricsV1;
        __demoPublicSourceRestore?: () => void;
      };
      const plugin = (win as any).app?.plugins?.plugins?.[pluginId];
      if (!plugin?.createToolExecutionContext) {
        throw new Error("Production web transport is unavailable for the demo.");
      }
      const normalize = (value: string): string => {
        const url = new URL(value);
        url.hash = "";
        return url.href;
      };
      const allowed = new Set(allowedUrls.map(normalize));
      const original = plugin.createToolExecutionContext;
      win.__demoPublicSourceMetrics = {
        searchTransportCalls: 0,
        allowedFetchTransportCalls: 0,
        blockedFetchAttempts: 0,
        fetchedUrls: [],
      };
      plugin.createToolExecutionContext = function (
        this: any,
        prompt: string,
      ) {
        const context = original.call(this, prompt);
        const realTransport = context.httpTransport;
        if (typeof realTransport !== "function") {
          throw new Error("Production web transport did not initialize.");
        }
        context.httpTransport = async (request: any) => {
          const endpoint = String(request?.url ?? "");
          const metrics = win.__demoPublicSourceMetrics!;
          if (endpoint.endsWith("/web_search")) {
            metrics.searchTransportCalls += 1;
            const response = await realTransport(request);
            const results = Array.isArray(response?.json?.results)
              ? response.json.results.filter((result: any) => {
                  try {
                    return allowed.has(normalize(String(result?.url ?? "")));
                  } catch {
                    return false;
                  }
                })
              : [];
            return {
              ...response,
              json: { ...(response?.json ?? {}), results },
            };
          }
          if (endpoint.endsWith("/web_fetch")) {
            let requestedUrl = "";
            try {
              requestedUrl = normalize(
                String(JSON.parse(String(request?.body ?? "{}")).url ?? ""),
              );
            } catch {
              requestedUrl = "";
            }
            if (!allowed.has(requestedUrl)) {
              metrics.blockedFetchAttempts += 1;
              return {
                status: 403,
                headers: {},
                json: {
                  error:
                    "This recording run is limited to the two user-approved public sources.",
                },
              };
            }
            metrics.allowedFetchTransportCalls += 1;
            metrics.fetchedUrls.push(requestedUrl);
            return realTransport(request);
          }
          return realTransport(request);
        };
        return context;
      };
      win.__demoPublicSourceRestore = () => {
        plugin.createToolExecutionContext = original;
        delete win.__demoPublicSourceMetrics;
        delete win.__demoPublicSourceRestore;
      };
    },
    { pluginId: NATIVE_CORE_PLUGIN_ID, allowedUrls: [...allowedUrls] },
  );
}

export async function readDemoPublicSourceMetricsV1(
  page: Page,
): Promise<DemoPublicSourceMetricsV1> {
  return page.evaluate(() => {
    const metrics = (
      window as typeof window & {
        __demoPublicSourceMetrics?: DemoPublicSourceMetricsV1;
      }
    ).__demoPublicSourceMetrics;
    if (!metrics) {
      throw new Error("Demo public-source metrics are unavailable.");
    }
    return {
      ...metrics,
      fetchedUrls: [...metrics.fetchedUrls],
    };
  });
}

export async function restoreDemoPublicSourceBoundaryV1(
  page: Page,
): Promise<void> {
  await page.evaluate(() => {
    (
      window as typeof window & {
        __demoPublicSourceRestore?: () => void;
      }
    ).__demoPublicSourceRestore?.();
  });
}
