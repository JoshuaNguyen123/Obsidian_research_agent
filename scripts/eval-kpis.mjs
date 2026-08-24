// Aggregate docs/eval/playwright-run-metrics.csv into the KPIs that say
// whether the harness and product are actually improving: per-model run
// counts and green rates, failure-class distribution, tool-call failure
// percentages where runs recorded them, and a by-date trend. Read-only.
//
//   node scripts/eval-kpis.mjs [--since 2026-08-20] [--model deepseek-v4-pro]
import { readFileSync } from "node:fs";

const CSV_PATH = new URL("../docs/eval/playwright-run-metrics.csv", import.meta.url);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const since = argValue("--since");
const onlyModel = argValue("--model");

const rows = parseCsv(readFileSync(CSV_PATH, "utf8"));
const header = rows[0];
const col = (name) => header.indexOf(name);
const records = rows.slice(1).map((cells) => ({
  at: cells[col("run_started_at")] ?? "",
  lane: cells[col("lane")] ?? "",
  model: (cells[col("model")] ?? "").trim() || "(unset)",
  outcome: cells[col("mission_outcome")] ?? "",
  failureClass: (cells[col("primary_failure_class")] ?? "").trim() || "none",
  toolEvents: Number(cells[col("tool_events_observed")]) || 0,
  toolFailed: Number(cells[col("tool_events_failed")]) || 0,
  pctFailed: cells[col("pct_tool_calls_failed")] ?? "",
})).filter((r) => r.at)
  .filter((r) => !since || r.at.slice(0, 10) >= since)
  .filter((r) => !onlyModel || r.model.startsWith(onlyModel));

const GREEN = /^(write_completed|AUDIT_PASSED|fix_merged|.*PASSED.*|.*green.*)$/i;
const isGreen = (r) =>
  GREEN.test(r.outcome) || r.failureClass === "none";

const byKey = (list, keyFn) => {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
};

const pct = (part, whole) => (whole ? ((100 * part) / whole).toFixed(1) + "%" : "n/a");

console.log(`Eval KPIs — ${records.length} run rows${since ? ` since ${since}` : ""}${onlyModel ? ` model=${onlyModel}` : ""}\n`);

console.log("== By model ==");
for (const [model, list] of [...byKey(records, (r) => r.model)].sort((a, b) => b[1].length - a[1].length)) {
  const green = list.filter(isGreen).length;
  const toolTotals = list.reduce((acc, r) => ({ e: acc.e + r.toolEvents, f: acc.f + r.toolFailed }), { e: 0, f: 0 });
  const toolNote = toolTotals.e > 0 ? `, tool-call failure ${pct(toolTotals.f, toolTotals.e)} (${toolTotals.f}/${toolTotals.e})` : "";
  console.log(`  ${model}: ${list.length} runs, green ${green} (${pct(green, list.length)})${toolNote}`);
}

console.log("\n== Failure classes (non-green rows) ==");
const failures = records.filter((r) => !isGreen(r));
for (const [cls, list] of [...byKey(failures, (r) => r.failureClass)].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${cls}: ${list.length}`);
}

console.log("\n== By day ==");
for (const [day, list] of [...byKey(records, (r) => r.at.slice(0, 10))].sort()) {
  const green = list.filter(isGreen).length;
  console.log(`  ${day}: ${list.length} runs, green ${green} (${pct(green, list.length)})`);
}

const blank = records.filter((r) => r.model === "(unset)").length;
if (blank > 0) {
  console.log(`\nWARNING: ${blank} rows have no model recorded — every future row must carry the exact model id.`);
}
