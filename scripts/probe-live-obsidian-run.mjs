// Read-only probe of a live e2e Obsidian instance over CDP. Attaches as a
// second DevTools client (the harness keeps its own) and reports what the
// production plugin believes its active run is doing. Never mutates state.
//
//   node scripts/probe-live-obsidian-run.mjs [--port 11223] [--timer-ms 2000]
import { chromium } from "playwright";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1] || 11223);
const timerMs = Number(args[args.indexOf("--timer-ms") + 1] || 2000);
const pluginId = "agentic-researcher";

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
  timeout: 15_000,
});
try {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => /app:\/\/obsidian\.md/u.test(candidate.url()))
    ?? pages[0];
  if (!page) throw new Error("No Obsidian page reachable over CDP.");

  const wallStart = Date.now();
  const timerProbe = await Promise.race([
    page.evaluate(
      (ms) => new Promise((resolve) => {
        const started = performance.now();
        setTimeout(() => resolve({ fired: true, waitedMs: performance.now() - started }), ms);
      }),
      timerMs,
    ),
    new Promise((resolve) => setTimeout(() => resolve({ fired: false, waitedMs: timerMs * 5 }), timerMs * 5)),
  ]);
  const timerWallMs = Date.now() - wallStart;

  const state = await page.evaluate(({ pluginId }) => {
    const app = window.app;
    const plugin = app?.plugins?.plugins?.[pluginId];
    const snapshot = plugin?.getMissionRunSnapshot?.() ?? null;
    const statusText = document.querySelector(".agentic-researcher-status")?.textContent?.trim()
      ?? document.querySelector("[class*='agentic-researcher'][class*='status']")?.textContent?.trim()
      ?? null;
    const runText = document.querySelector("button.agentic-researcher-run")?.textContent?.trim() ?? null;
    const recentStatusLines = Array.from(
      document.querySelectorAll(".agentic-researcher-log-message"),
    ).slice(-8).map((element) => element.textContent?.trim().slice(0, 200) ?? "");
    const diagnostics = Array.isArray(snapshot?.diagnosticAttestations)
      ? snapshot.diagnosticAttestations.slice(-10).map((item) => `${item.id} | ${String(item.message ?? "").slice(0, 160)}`)
      : [];
    return {
      visibility: document.visibilityState,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
      runText,
      statusText,
      pluginRunning: plugin?.isMissionRunning?.() === true,
      runId: snapshot?.runId ?? null,
      lastActivityAtMs: snapshot?.lastActivityAtMs ?? null,
      providerUsage: snapshot?.providerUsage ?? null,
      lastComplete: snapshot?.lastComplete ? { step: snapshot.lastComplete.step, stopReason: snapshot.lastComplete.stopReason } : null,
      graphNodes: Object.values(snapshot?.lastMissionGraph?.nodes ?? {})
        .filter((node) => node?.status !== "queued")
        .map((node) => `${node.id}:${node.status}${node.blocker?.code ? ":" + node.blocker.code : ""}`),
      diagnostics,
      recentStatusLines,
      performanceNowMs: performance.now(),
    };
  }, { pluginId });

  // Network: count in-flight fetches to the model endpoint via the CDP session.
  const session = await page.context().newCDPSession(page);
  const pending = [];
  session.on("Network.requestWillBeSent", (event) => {
    if (/ollama\.com|\/api\/chat/u.test(event.request.url)) {
      pending.push({ id: event.requestId, url: event.request.url, at: Date.now() });
    }
  });
  await session.send("Network.enable");
  // A short observation window: new requests would show up here; a stalled
  // single request will not, so also report the timer + status evidence.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  await session.send("Network.disable").catch(() => undefined);
  await session.detach().catch(() => undefined);

  console.log(JSON.stringify({
    probedAt: new Date().toISOString(),
    timerProbe: { ...timerProbe, wallMs: timerWallMs },
    newModelRequestsIn3s: pending.length,
    ...state,
  }, null, 2));
} finally {
  // Do not call browser.close(): for a CDP-attached browser Playwright may
  // tear down contexts. Exiting the process simply drops this client.
  process.exit(0);
}
