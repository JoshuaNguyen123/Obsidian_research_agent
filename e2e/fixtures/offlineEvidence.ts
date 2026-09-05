import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { peekToolCallCollector, TOOL_CALL_COLLECTOR_SLOT } from "./toolCallCollector";

export async function readOfflineBuildIdentity() {
  const run = promisify(execFile);
  const [{ stdout: head }, { stdout: dirty }] = await Promise.all([run("git", ["rev-parse", "HEAD"]), run("git", ["status", "--porcelain"]) ]);
  const vault = process.env.OBSIDIAN_VAULT?.trim() || path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", "OneDrive", "Desktop", "test_vault_obsidian_ai");
  const hashes = await Promise.all([path.resolve("main.js"), path.join(vault, ".obsidian", "plugins", "agentic-researcher", "main.js")].map(async (file) => createHash("sha256").update(await readFile(file)).digest("hex")));
  return { exactHead: head.trim(), sourceState: dirty.trim() ? "dirty_worktree" : "clean_head", bundleSha256: hashes[0], installedBundleSha256: hashes[1] };
}

/** Catalog/cache probes have no mission acceptance score. Retain their proof
 * separately so availability observations cannot inflate application success. */
export async function saveOfflineProbe(probe: Record<string, any>) {
  if (!/^[a-f0-9-]{36}$/u.test(probe.attemptId)) throw new Error("Invalid offline probe identity.");
  await atomicJson(path.resolve("docs", "eval", "offline-attempt-history", `probe-${probe.attemptId}.json`),
    { ...probe, proofKind: "installed_capability_probe", updatedAt: new Date().toISOString() });
}

export function beginOfflineAttempt(identity: Record<string, unknown>, scenarioId: string) {
  return {
    version: 1, evidenceSemanticsVersion: 2, attemptId: randomUUID(), startedAt: new Date().toISOString(),
    scenarioId, repetition: 1, ...identity, status: "failed",
    acceptanceStatus: "needs_more_work", scorecardAcceptancePassed: false,
    scorecardTotal: null, scorecardDimensions: [], artifactReadbacks: [],
    failureClass: "process:unclassified", failureDetail: "Attempt started; completion has not been observed.",
    toolEventsObserved: null, toolEventsFailed: null,
  } as Record<string, any>;
}

/** Save before contacting the renderer, so a killed process still leaves proof
 * of the attempt. Per-attempt history survives the next lane's summary reset. */
export async function saveOfflineAttempt(attempt: Record<string, any>): Promise<void> {
  if (!/^[a-f0-9-]{36}$/u.test(attempt.attemptId)) throw new Error("Invalid offline attempt identity.");
  const summaryPath = path.resolve("test-results", "offline-application-attempts.json");
  let prior: Record<string, any>[] = [];
  try {
    const parsed = JSON.parse(await readFile(summaryPath, "utf8"));
    if (!Array.isArray(parsed.attempts)) throw new Error("Malformed existing offline evidence.");
    prior = parsed.attempts;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const recorded = { ...attempt, updatedAt: new Date().toISOString() };
  const historyPath = path.resolve("docs", "eval", "offline-attempt-history", `${attempt.attemptId}.json`);
  await atomicJson(historyPath, recorded);
  await atomicJson(summaryPath, { version: 1, attempts: [...prior.filter((row) => row.attemptId !== attempt.attemptId), recorded] });
}

async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export async function observeOfflineTools(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    w.__offlineMissionObservation = { started: false, completed: false };
    w.__offlineUnsubscribe?.();
    w.__offlineUnsubscribe = w.app.plugins.plugins["agentic-researcher"].subscribeMissionEvents({
      onRunConfig: () => { w.__offlineMissionObservation.started = true; },
      onRunComplete: () => { w.__offlineMissionObservation.completed = true; },
    }, { replay: false });
  });
}

export async function boundedOfflineRead<T>(read: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read.catch(() => null), new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 3_000);
    })]);
  } finally { clearTimeout(timer); }
}

export async function readOfflineToolCounts(page: Page) {
  // Reuse the production collector's refusal, de-duplication and partial-call
  // rules. Tool-done alone misses refusals; its success field is event.ok.
  const counts = await peekToolCallCollector(page);
  if (counts.coverage === "complete") return {
    toolEventsObserved: counts.attempted,
    toolEventsFailed: counts.undetermined === 0 ? counts.failed : null,
  };
  // Direct chat can have no tool events at all. Zero is justified only by an
  // armed, lossless empty capture spanning an observed mission completion.
  const completedEmptyCapture = await boundedOfflineRead(page.evaluate((slot) => {
    const w = window as any;
    const observation = w.__offlineMissionObservation;
    const segments = w[slot]?.segments;
    return observation?.started === true && observation?.completed === true &&
      Array.isArray(segments) && segments.length > 0 && segments.every((segment: any) =>
        !segment.overflowed && (!segment.armedWhileRunning || segment.armDroppedEventCount === 0) &&
        Array.isArray(segment.events) && segment.events.length === 0);
  }, TOOL_CALL_COLLECTOR_SLOT));
  return completedEmptyCapture
    ? { toolEventsObserved: 0, toolEventsFailed: 0 }
    : { toolEventsObserved: null, toolEventsFailed: null };
}
