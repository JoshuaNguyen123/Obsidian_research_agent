// Aggregate docs/eval/playwright-run-metrics.csv into the KPIs that say
// whether the harness and product are actually improving: per-model run
// counts and green rates, failure-class distribution, tool-call failure
// percentages where runs recorded them, and a by-date trend. Read-only.
//
// Infrastructure rows (harness:*, process:*, environment_not_configured) are
// reported as their own count and appear in NO pass rate — neither numerator
// nor denominator. They measured the harness, not the product. The predicate
// that decides this is the one the proof matrix itself gates on; see
// scripts/product-evidence.mjs.
//
//   node scripts/eval-kpis.mjs [--since 2026-08-20] [--model deepseek-v4-pro]
import { readFileSync } from "node:fs";

import {
  csvRecords,
  describeExcludedInfrastructure,
  formatRate,
  partitionRunRows,
  runRowIsGreen,
  toRunRow,
  optionalCount,
  summarizeToolCounts,
  EVIDENCE_SEMANTICS_VERSION,
} from "./product-evidence.mjs";

const CSV_PATH = new URL("../docs/eval/playwright-run-metrics.csv", import.meta.url);

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const since = argValue("--since");
const onlyModel = argValue("--model");

const records = csvRecords(readFileSync(CSV_PATH, "utf8")).map((cells) => ({
  ...toRunRow(cells),
  at: cells.run_started_at ?? "",
  lane: cells.lane ?? "",
  model: (cells.model ?? "").trim() || "(unset)",
  toolEvents: optionalCount(cells.tool_events_observed),
  toolFailed: optionalCount(cells.tool_events_failed),
  pctFailed: cells.pct_tool_calls_failed ?? "",
})).filter((r) => r.at)
  .filter((r) => !since || r.at.slice(0, 10) >= since)
  .filter((r) => !onlyModel || r.model.startsWith(onlyModel));

// The whole point: `scored` is what a pass rate may see, `infrastructure` is
// reported beside it and never inside it.
const { scored, infrastructure, unresolved } = partitionRunRows(records);
const isGreen = runRowIsGreen;

const byKey = (list, keyFn) => {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
};
const countBy = (list, keyFn) => {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
};

const pct = formatRate;
console.log(`Evidence semantics v${EVIDENCE_SEMANTICS_VERSION}; ${unresolved.length} unresolved rows (excluded pending classification). Historical CSV rows are unchanged.`);

console.log(`Eval KPIs — ${scored.length} product run rows${since ? ` since ${since}` : ""}${onlyModel ? ` model=${onlyModel}` : ""}\n`);
const exclusionNote = describeExcludedInfrastructure(infrastructure.length, records.length);
if (exclusionNote) console.log(`${exclusionNote}\n`);

const infraByModel = countBy(infrastructure, (r) => r.model);
const infraByDay = countBy(infrastructure, (r) => r.at.slice(0, 10));

console.log("== By model ==");
const scoredByModel = byKey(scored, (r) => r.model);
for (const [model, list] of [...scoredByModel].sort((a, b) => b[1].length - a[1].length)) {
  const green = list.filter(isGreen).length;
  const toolTotals = summarizeToolCounts(list);
  const toolNote = `, tool-call failure ${pct(toolTotals.failed, toolTotals.observed)} (${toolTotals.failed}/${toolTotals.observed}), count coverage ${toolTotals.coveredRows}/${toolTotals.totalRows} rows`;
  const infra = infraByModel.get(model) ?? 0;
  const infraNote = infra > 0 ? `, +${infra} infrastructure (excluded)` : "";
  console.log(`  ${model}: ${list.length} runs, green ${green} (${pct(green, list.length)})${toolNote}${infraNote}`);
}
// A model whose ONLY rows were infrastructure deaths still has to appear, or
// the report silently forgets runs were attempted at all.
for (const [model, count] of [...infraByModel].sort((a, b) => b[1] - a[1])) {
  if (scoredByModel.has(model)) continue;
  console.log(`  ${model}: 0 runs scored, ${count} infrastructure (excluded) — no product evidence`);
}

console.log("\n== Failure classes (non-green product rows) ==");
const failures = scored.filter((r) => !isGreen(r));
for (const [cls, list] of [...byKey(failures, (r) => r.failureClass)].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${cls}: ${list.length}`);
}
if (failures.length === 0) console.log("  (none)");

console.log("\n== Infrastructure classes (excluded from every rate above) ==");
if (infrastructure.length === 0) console.log("  (none)");
for (const [cls, list] of [...byKey(infrastructure, (r) => r.failureClass)].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${cls}: ${list.length}`);
}

console.log("\n== By day ==");
const scoredByDay = byKey(scored, (r) => r.at.slice(0, 10));
// A day that recorded only harness deaths is reported with no rate at all
// rather than as a 0% day: nothing about the product was measured.
for (const day of infraByDay.keys()) if (!scoredByDay.has(day)) scoredByDay.set(day, []);
for (const [day, list] of [...scoredByDay].sort((a, b) => a[0].localeCompare(b[0]))) {
  const green = list.filter(isGreen).length;
  const infra = infraByDay.get(day) ?? 0;
  const infraNote = infra > 0 ? `, +${infra} infrastructure (excluded)` : "";
  console.log(`  ${day}: ${list.length} runs, green ${green} (${pct(green, list.length)})${infraNote}`);
}

const blank = records.filter((r) => r.model === "(unset)").length;
if (blank > 0) {
  console.log(`\nWARNING: ${blank} rows have no model recorded — every future row must carry the exact model id.`);
}
