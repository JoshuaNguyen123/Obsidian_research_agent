// Mine per-tool outcomes from the test vault's persisted mission graphs into
// docs/eval/tool-events.csv, then print per-tool and per-model KPIs.
//
// Each graph node that names a tool is one planned tool engagement:
//   complete           - the tool ran and its receipt satisfied the node
//   failed / blocked   - attempted and refused or errored terminally
//   cancelled          - planned but never needed (excluded from success rate)
// Model attribution joins the run's timestamp (from its id) against the
// nearest curated row in playwright-run-metrics.csv within 45 minutes; runs
// outside any window are "(unknown)". Read-only over the vault; best-effort.
//
// A joined row whose failure class is infrastructure (harness:*, process:*,
// environment_not_configured) carries NO product outcome: `run_green` is left
// blank and `run_infrastructure` says why, so P(run green | tool completed in
// run) is not depressed by harness deaths in which every tool actually worked.
// The predicate lives in scripts/product-evidence.mjs, shared with the proof
// matrix that writes the rows and with the other two eval readers.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  csvRecords,
  formatRate,
  runRowIsGreen,
  runRowIsInfrastructure,
  toRunRow,
} from "./product-evidence.mjs";

const EVAL_DIR = path.dirname(fileURLToPath(new URL("../docs/eval/playwright-run-metrics.csv", import.meta.url)));
const GRAPH_DIR = path.join(process.env.USERPROFILE ?? "", "OneDrive", "Desktop", "test_vault_obsidian_ai", "Agent Runs", "Mission Graphs");
const OUT = path.join(EVAL_DIR, "tool-events.csv");
const QUIET = process.argv.includes("--quiet");

// Curated run rows: timestamp, model, and the run's product outcome — where
// one exists. Infrastructure rows keep their timestamp and model (so the
// nearest-run join cannot skip past them onto a further-away product row) but
// carry no green/red verdict at all.
function loadRunIndex() {
  try {
    const records = csvRecords(readFileSync(path.join(EVAL_DIR, "playwright-run-metrics.csv"), "utf8"));
    return records.map((cells) => {
      const row = toRunRow(cells);
      const infrastructure = runRowIsInfrastructure(row);
      return {
        at: Date.parse(cells.run_started_at ?? ""),
        model: (cells.model ?? "").trim(),
        infrastructure,
        green: infrastructure ? null : runRowIsGreen(row),
      };
    }).filter((r) => Number.isFinite(r.at) && r.model);
  } catch { return []; }
}

function runTimestampMs(missionId) {
  const match = /run-(\d{4}-\d{2}-\d{2})[tT](\d{2})-(\d{2})-(\d{2})\.(\d{3})[zZ]/.exec(missionId);
  if (!match) return NaN;
  return Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
}

try {
  const runIndex = loadRunIndex();
  const nearestRun = (ms) => {
    let best = null;
    for (const r of runIndex) {
      const gap = Math.abs(r.at - ms);
      if (gap <= 45 * 60_000 && (!best || gap < best.gap)) best = { ...r, gap };
    }
    return best;
  };

  const events = [];
  for (const name of readdirSync(GRAPH_DIR)) {
    if (!name.endsWith(".md")) continue;
    let data;
    try {
      const text = readFileSync(path.join(GRAPH_DIR, name), "utf8");
      data = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    } catch { continue; }
    const missionId = data.missionId ?? name.replace(/\.md$/, "");
    const ms = runTimestampMs(missionId);
    const joined = Number.isFinite(ms) ? nearestRun(ms) : null;
    const nodes = data.graph?.nodes ?? {};
    for (const node of Object.values(nodes)) {
      const tool = (node.allowedTools ?? [])[0];
      if (!tool) continue;
      events.push({
        missionId,
        at: Number.isFinite(ms) ? new Date(ms).toISOString() : "",
        model: joined?.model ?? "(unknown)",
        // Blank = no product outcome for this run. Unjoined runs and
        // infrastructure deaths are both unknown here, never "false".
        runGreen: joined && joined.green !== null ? String(joined.green) : "",
        runInfrastructure: joined ? String(joined.infrastructure) : "",
        nodeId: node.id ?? "",
        tool,
        status: node.status ?? "",
        attempts: (node.retries ?? {}).attempts ?? 0,
        blocker: node.blocker ? String(node.blocker.reason ?? node.blocker).slice(0, 120).replace(/[\r\n,]+/g, " ") : "",
      });
    }
  }

  // `run_infrastructure` is APPENDED so existing name-indexing readers keep
  // working: it says WHY a blank run_green is blank.
  const header = "mission_id,run_started_at,model,run_green,node_id,tool,status,attempts,blocker,run_infrastructure";
  const csvLine = (e) => [e.missionId, e.at, e.model, e.runGreen, e.nodeId, e.tool, e.status, e.attempts, e.blocker, e.runInfrastructure]
    .map((v) => (String(v).includes(",") ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(",");
  writeFileSync(OUT, [header, ...events.map(csvLine)].join(String.fromCharCode(10)) + String.fromCharCode(10));

  const group = (list, keyFn) => {
    const m = new Map();
    for (const item of list) { const k = keyFn(item); if (!m.has(k)) m.set(k, []); m.get(k).push(item); }
    return m;
  };
  const pct = formatRate;
  const attempted = events.filter((e) => e.status !== "cancelled" && e.status !== "queued" && e.status !== "ready");

  if (!QUIET) {
    console.log(`tool-events: ${events.length} tool nodes from ${new Set(events.map((e) => e.missionId)).size} missions -> ${path.basename(OUT)}`);

    console.log(String.fromCharCode(10) + "== Per tool (attempted nodes) ==");
    for (const [tool, list] of [...group(attempted, (e) => e.tool)].sort((a, b) => b[1].length - a[1].length)) {
      const ok = list.filter((e) => e.status === "complete").length;
      const avgAtt = (list.reduce((s, e) => s + (Number(e.attempts) || 0), 0) / list.length).toFixed(2);
      console.log(`  ${tool}: ${list.length} attempted, ${ok} complete (${pct(ok, list.length)}), avg attempts ${avgAtt}`);
    }

    console.log(String.fromCharCode(10) + "== Per model x tool (top rows) ==");
    const byModelTool = [...group(attempted, (e) => `${e.model} | ${e.tool}`)]
      .map(([key, list]) => ({ key, n: list.length, ok: list.filter((e) => e.status === "complete").length }))
      .sort((a, b) => b.n - a.n).slice(0, 14);
    for (const row of byModelTool) {
      console.log(`  ${row.key}: ${row.ok}/${row.n} (${pct(row.ok, row.n)})`);
    }

    // "Of the pass, did it work?" - tool completion is the prediction, the
    // run going green is the outcome. Precision-style conditional rate.
    console.log(String.fromCharCode(10) + "== Tool effectiveness: P(run green | tool completed in run) ==");
    const withOutcome = attempted.filter((e) => e.runGreen !== "");
    const excludedInfra = new Set(
      attempted.filter((e) => e.runInfrastructure === "true").map((e) => e.missionId),
    );
    if (excludedInfra.size > 0) {
      console.log(
        `  (${excludedInfra.size} run(s) excluded: the run died in the harness, so it has no ` +
        "product outcome — their tools may well have all worked)",
      );
    }
    for (const [tool, list] of [...group(withOutcome.filter((e) => e.status === "complete"), (e) => e.tool)].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
      const runs = group(list, (e) => e.missionId);
      const greenRuns = [...runs.values()].filter((nodes) => nodes[0].runGreen === "true").length;
      console.log(`  ${tool}: ${greenRuns}/${runs.size} runs green (${pct(greenRuns, runs.size)})`);
    }
  }
} catch (error) {
  if (!QUIET) console.log(`eval-tool-events: skipped (${String(error.message ?? error).slice(0, 160)})`);
}
process.exit(0);
