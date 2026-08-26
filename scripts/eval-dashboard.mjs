// Regenerate the eval KPI dashboard from docs/eval/playwright-run-metrics.csv:
//   docs/eval/kpi-dashboard.md   - tables (per-model, failure classes, by day)
//   docs/eval/kpi-charts.svg     - green-rate bars, by-day trend, failure classes
//   docs/eval/kpi-analysis.ipynb - EXECUTED notebook (stdlib-only python cells,
//                                  real outputs embedded at generation time)
//
// Wired as npm "posttest" so every `npm test` refreshes the analysis; outputs
// live in gitignored docs/eval/ so the refresh never dirties the tree that
// exact-HEAD e2e lanes require clean. Best-effort by design: this script must
// never fail a test run, so every error path exits 0 with a note.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EVAL_DIR = path.dirname(fileURLToPath(new URL("../docs/eval/playwright-run-metrics.csv", import.meta.url)));
const CSV = path.join(EVAL_DIR, "playwright-run-metrics.csv");
const QUIET = process.argv.includes("--quiet");

function parseCsv(text) {
  const rows = []; let row = []; let field = ""; let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else q = false; } else field += ch; }
    else if (ch === '"') q = true;
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

try {
  try { execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "eval-tool-events.mjs"), "--quiet"], { timeout: 120_000 }); } catch {}
  let toolEvents = [];
  try {
    const teRows = parseCsv(readFileSync(path.join(EVAL_DIR, "tool-events.csv"), "utf8"));
    const teHeader = teRows[0];
    const teCol = (name) => teHeader.indexOf(name);
    toolEvents = teRows.slice(1).map((c) => ({
      model: c[teCol("model")] ?? "", tool: c[teCol("tool")] ?? "",
      status: c[teCol("status")] ?? "", runGreen: c[teCol("run_green")] ?? "", missionId: c[teCol("mission_id")] ?? "",
    })).filter((e) => e.tool);
  } catch {}
  const rows = parseCsv(readFileSync(CSV, "utf8"));
  const header = rows[0];
  const col = (name) => header.indexOf(name);
  // Old rows are SHORTER than the appended-column header: a missing cell
  // reads as undefined -> blank -> null/"" here. Blank is unknown, not zero.
  const num = (value) => {
    const text = String(value ?? "").trim();
    if (text === "") return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const records = rows.slice(1).map((c) => ({
    at: c[col("run_started_at")] ?? "",
    model: (c[col("model")] ?? "").trim() || "(unset)",
    outcome: c[col("mission_outcome")] ?? "",
    failureClass: (c[col("primary_failure_class")] ?? "").trim() || "none",
    observed: num(c[col("tool_events_observed")]),
    failed: num(c[col("tool_events_failed")]),
    succeeded: num(c[col("tool_calls_succeeded")]),
    vacuous: num(c[col("tool_calls_vacuous")]),
    source: String(c[col("tool_events_source")] ?? "").trim(),
    secondary: String(c[col("secondary_failure_classes")] ?? "").trim(),
    confidence: String(c[col("classification_confidence")] ?? "").trim(),
  })).filter((r) => r.at);
  const isGreen = (r) => r.failureClass === "none" || /passed|green|write_completed|fix_merged/i.test(r.outcome);

  const group = (list, keyFn) => {
    const m = new Map();
    for (const item of list) { const k = keyFn(item); if (!m.has(k)) m.set(k, []); m.get(k).push(item); }
    return m;
  };
  const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : 0);

  const byModel = [...group(records, (r) => r.model)].map(([model, list]) => ({
    model, runs: list.length, green: list.filter(isGreen).length,
  })).sort((a, b) => b.runs - a.runs);
  const byDay = [...group(records, (r) => r.at.slice(0, 10))].map(([day, list]) => ({
    day, runs: list.length, green: list.filter(isGreen).length,
  })).sort((a, b) => a.day.localeCompare(b.day));
  const byClass = [...group(records.filter((r) => !isGreen(r)), (r) => r.failureClass)]
    .map(([cls, list]) => ({ cls, n: list.length }))
    .sort((a, b) => b.n - a.n);

  const md = [
    "# Eval KPI dashboard",
    "",
    `Generated ${new Date().toISOString()} from ${records.length} run rows. Regenerated automatically after every \`npm test\` (posttest hook) and on demand via \`node scripts/eval-dashboard.mjs\`.`,
    "",
    "![KPI charts](kpi-charts.svg)",
    "",
    "## Per model",
    "",
    "| Model | Runs | Green | Green % |",
    "|---|---|---|---|",
    ...byModel.map((m) => `| ${m.model} | ${m.runs} | ${m.green} | ${pct(m.green, m.runs)}% |`),
    "",
    "## Failure classes (non-green rows)",
    "",
    "| Class | Count |",
    "|---|---|",
    ...byClass.map((c) => `| ${c.cls} | ${c.n} |`),
    "",
    "A `product:` class appearing more than once is a regression alarm, not a statistic.",
    "",
    "## By day",
    "",
    "| Day | Runs | Green | Green % |",
    "|---|---|---|---|",
    ...byDay.map((d) => `| ${d.day} | ${d.runs} | ${d.green} | ${pct(d.green, d.runs)}% |`),
    "",
  ].join("\n");
  const attemptedEvents = toolEvents.filter((e) => !["cancelled", "queued", "ready"].includes(e.status));
  const toolTable = [...group(attemptedEvents, (e) => e.tool)]
    .map(([tool, list]) => ({ tool, n: list.length, ok: list.filter((e) => e.status === "complete").length }))
    .sort((a, b) => b.n - a.n);
  const modelToolTable = [...group(attemptedEvents, (e) => `${e.model} | ${e.tool}`)]
    .map(([key, list]) => ({ key, n: list.length, ok: list.filter((e) => e.status === "complete").length }))
    .sort((a, b) => b.n - a.n).slice(0, 16);
  const effectiveness = [...group(attemptedEvents.filter((e) => e.status === "complete" && e.runGreen !== ""), (e) => e.tool)]
    .map(([tool, list]) => {
      const runs = group(list, (e) => e.missionId);
      const green = [...runs.values()].filter((nodes) => nodes[0].runGreen === "true").length;
      return { tool, runs: runs.size, green };
    }).sort((a, b) => b.runs - a.runs);
  const mdFull = md + [
    "",
    "## Per tool (attempted graph nodes)",
    "",
    "| Tool | Attempted | Complete | Success % |",
    "|---|---|---|---|",
    ...toolTable.map((t) => `| ${t.tool} | ${t.n} | ${t.ok} | ${pct(t.ok, t.n)}% |`),
    "",
    "## Per model x tool",
    "",
    "| Model \| Tool | Complete / Attempted | Success % |",
    "|---|---|---|",
    ...modelToolTable.map((r) => `| ${r.key} | ${r.ok}/${r.n} | ${pct(r.ok, r.n)}% |`),
    "",
    "## Tool effectiveness — P(run green | tool completed in run)",
    "",
    "| Tool | Runs with completion | Green | Rate |",
    "|---|---|---|---|",
    ...effectiveness.map((t) => `| ${t.tool} | ${t.runs} | ${t.green} | ${pct(t.green, t.runs)}% |`),
    "",
  ].join(String.fromCharCode(10));

  // -------------------------------------------------------------------------
  // Tool-call success. A row carries tool-call data only when BOTH
  // tool_events_observed and tool_events_failed are present; the coverage
  // line keeps sparse data from masquerading as a trend.
  // -------------------------------------------------------------------------
  const tcRows = records.filter((r) => r.observed !== null && r.failed !== null);
  const tcAgg = (list) => {
    const observed = list.reduce((t, r) => t + r.observed, 0);
    const failed = list.reduce((t, r) => t + r.failed, 0);
    const vacuousKnown = list.filter((r) => r.vacuous !== null);
    const vacuousSum = vacuousKnown.reduce((t, r) => t + r.vacuous, 0);
    // Unknown never prints as 0: "?" when no row knew its vacuous count,
    // ">=" when only some rows did (a lower bound).
    const vacuous = vacuousKnown.length === list.length
      ? String(vacuousSum)
      : vacuousKnown.length === 0
        ? "?"
        : `>=${vacuousSum}`;
    const succeeded = list.reduce(
      (t, r) => t + (r.succeeded ?? Math.max(0, r.observed - r.failed - (r.vacuous ?? 0))),
      0,
    );
    return { observed, failed, vacuous, succeeded };
  };
  const tcTable = (groups) => groups.map(([key, list]) => {
    const a = tcAgg(list);
    return `| ${key} | ${list.length} | ${a.observed} | ${a.failed} | ${a.vacuous} | ${a.succeeded} | ${pct(a.succeeded, a.observed)}% |`;
  });
  const tcByModel = [...group(tcRows, (r) => r.model)].sort((a, b) => b[1].length - a[1].length);
  const tcByDay = [...group(tcRows, (r) => r.at.slice(0, 10))].sort((a, b) => a[0].localeCompare(b[0]));
  const successSection = [
    "",
    "## Tool-call success",
    "",
    "Fed by `tool_events_observed` / `tool_events_failed` / `tool_calls_vacuous` / `tool_calls_succeeded` (provenance per row in `tool_events_source`: summary = the attempt's fresh daily-use run summary, graphs = mined persisted mission graphs). Success % = succeeded/observed, where succeeded EXCLUDES vacuous calls when the vacuous count is known; a blank `tool_calls_vacuous` cell means vacuous completions may still hide inside succeeded. Blank cells are UNKNOWN, never zero.",
    "",
    `Coverage: ${tcRows.length} of ${records.length} rows carry tool-call data.` +
      (tcRows.length < records.length ? " Rows without data prove nothing about tool reliability — they are absent, not perfect." : ""),
    "",
    "| Model | Rows | Observed | Failed | Vacuous | Succeeded | Success % |",
    "|---|---|---|---|---|---|---|",
    ...tcTable(tcByModel),
    "",
    "| Day | Rows | Observed | Failed | Vacuous | Succeeded | Success % |",
    "|---|---|---|---|---|---|---|",
    ...tcTable(tcByDay),
    "",
  ];

  // -------------------------------------------------------------------------
  // Uncertainty ledger: every place ambiguity is DATA instead of silently
  // collapsed. Pre-schema rows legitimately have blank new columns.
  // -------------------------------------------------------------------------
  const ROOT = path.join(EVAL_DIR, "..", "..");
  let summaryRecords = null;
  let summarySource = null;
  // Canonical first; Playwright wipes test-results/ at run start, so fall
  // back to the durable mirror the reporter writes into proof-matrix-state/.
  // Read-only telemetry: gates (scorecard regression, protected release)
  // deliberately never take this fallback — a stale mirror must not satisfy
  // an assertion about THIS run.
  for (const [label, file] of [
    ["test-results/daily-use-run-summary.json", path.join(ROOT, "test-results", "daily-use-run-summary.json")],
    ["proof-matrix-state/daily-use-run-summary.latest.json (durable mirror)", path.join(ROOT, "proof-matrix-state", "daily-use-run-summary.latest.json")],
  ]) {
    try {
      const summary = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(summary?.records)) {
        summaryRecords = summary.records;
        summarySource = label;
        break;
      }
    } catch {}
  }
  const allZeroFingerprint = (fp) => typeof fp === "string" && /^sha256:0+$/u.test(fp);
  const uncertaintyBuckets = [
    ["CSV rows classified mechanically (`classification_confidence` = mechanical: pattern-matched from logs, never root-caused)", records.filter((r) => r.confidence === "mechanical").length],
    ["CSV rows unclassified (`classification_confidence` = unclassified: nothing parseable)", records.filter((r) => r.confidence === "unclassified").length],
    ["CSV rows with no tool-event source (`tool_events_source` blank — pre-schema rows and rows where neither a fresh summary nor mined graphs existed)", records.filter((r) => r.source === "").length],
    ["CSV rows with tool events observed but failed-count unknown (`tool_events_observed` present, `tool_events_failed` blank)", records.filter((r) => r.observed !== null && r.failed === null).length],
  ];
  const summaryBuckets = summaryRecords === null
    ? null
    : [
        ["run-summary records with null missionScorecard", summaryRecords.filter((r) => (r?.missionScorecard ?? null) === null).length],
        ["run-summary records with all-zeros fingerprint", summaryRecords.filter((r) => allZeroFingerprint(r?.fingerprint)).length],
        ["run-summary records with taskFamily \"unknown\"", summaryRecords.filter((r) => r?.taskFamily === "unknown").length],
        ["run-summary records with null toolCallsFailed (failure count unknowable from the spec's counters)", summaryRecords.filter((r) => (r?.toolCallsFailed ?? null) === null).length],
        ["run-summary records with null toolCallsVacuous (vacuous-work count unknowable from the spec's counters)", summaryRecords.filter((r) => (r?.toolCallsVacuous ?? null) === null).length],
      ];
  const uncertaintySection = [
    "## Uncertainty ledger",
    "",
    "Fed by `classification_confidence` and `tool_events_source` in playwright-run-metrics.csv, plus the latest run summary" +
      (summarySource ? ` (read from ${summarySource})` : "") +
      ". Rows appended before 2026-08-25 have blank new columns by design (history is never rewritten).",
    "",
    "| Uncertainty bucket | Count |",
    "|---|---|",
    ...uncertaintyBuckets.map(([label, n]) => `| ${label} | ${n} |`),
    ...(summaryBuckets
      ? summaryBuckets.map(([label, n]) => `| ${label} | ${n} |`)
      : ["| run-summary buckets | unavailable (test-results/daily-use-run-summary.json not readable) |"]),
    "",
  ];

  // -------------------------------------------------------------------------
  // Compound failures: one primary class never tells the whole story.
  // -------------------------------------------------------------------------
  const compoundRows = records.filter((r) => r.secondary !== "");
  const pairCounts = new Map();
  for (const r of compoundRows) {
    for (const secondary of r.secondary.split(";").map((s) => s.trim()).filter(Boolean)) {
      const key = `${r.failureClass} + ${secondary}`;
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
  }
  const compoundSection = [
    "## Compound failures",
    "",
    "Fed by `primary_failure_class` + `secondary_failure_classes` (semicolon-joined): attempts where more than one failure signature matched — e.g. a harness death whose log also carried a product signal. The primary drove budget/streak accounting; the secondaries are recorded so the extra causes are data, not lore.",
    "",
    ...(pairCounts.size === 0
      ? [`No compound failures recorded yet (${records.length} rows scanned).`]
      : [
          "| Class pair (primary + secondary) | Count |",
          "|---|---|",
          ...[...pairCounts.entries()].sort((a, b) => b[1] - a[1]).map(([key, n]) => `| ${key} | ${n} |`),
        ]),
    "",
  ];

  const mdWithNewSections = mdFull + [...successSection, ...uncertaintySection, ...compoundSection].join(String.fromCharCode(10));
  writeFileSync(path.join(EVAL_DIR, "kpi-dashboard.md"), mdWithNewSections);

  const W = 900, H = 640;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Segoe UI, sans-serif" font-size="12">`;
  svg += `<rect width="${W}" height="${H}" fill="#ffffff"/>`;
  svg += `<text x="16" y="24" font-size="16" font-weight="bold">Eval KPIs - per-model green rate</text>`;
  const top = byModel.slice(0, 6);
  top.forEach((m, i) => {
    const y = 44 + i * 26;
    const w = Math.max(2, 3.4 * pct(m.green, m.runs));
    svg += `<text x="16" y="${y + 12}">${esc(m.model)} (${m.runs})</text>`;
    svg += `<rect x="220" y="${y}" width="340" height="16" fill="#e5e7eb"/>`;
    svg += `<rect x="220" y="${y}" width="${w}" height="16" fill="#16a34a"/>`;
    svg += `<text x="${226 + 340}" y="${y + 12}">${pct(m.green, m.runs)}%</text>`;
  });
  let yBase = 44 + top.length * 26 + 34;
  svg += `<text x="16" y="${yBase - 10}" font-size="16" font-weight="bold">Green rate by day</text>`;
  const chartW = 820, chartH = 120;
  svg += `<rect x="40" y="${yBase}" width="${chartW}" height="${chartH}" fill="#f9fafb" stroke="#d1d5db"/>`;
  if (byDay.length > 0) {
    const step = byDay.length > 1 ? chartW / (byDay.length - 1) : 0;
    const pts = byDay.map((d, i) => {
      const x = 40 + (byDay.length > 1 ? i * step : chartW / 2);
      const y = yBase + chartH - (chartH * pct(d.green, d.runs)) / 100;
      return { x, y, d };
    });
    svg += `<polyline fill="none" stroke="#2563eb" stroke-width="2" points="${pts.map((p) => `${p.x},${p.y}`).join(" ")}"/>`;
    for (const p of pts) {
      svg += `<circle cx="${p.x}" cy="${p.y}" r="3" fill="#2563eb"/>`;
      svg += `<text x="${p.x - 24}" y="${yBase + chartH + 16}">${esc(p.d.day.slice(5))} (${p.d.runs})</text>`;
    }
  }
  yBase += chartH + 46;
  svg += `<text x="16" y="${yBase - 10}" font-size="16" font-weight="bold">Failure classes</text>`;
  const maxClass = byClass[0]?.n ?? 1;
  byClass.slice(0, 10).forEach((c, i) => {
    const y = yBase + i * 22;
    const w = Math.max(2, (300 * c.n) / maxClass);
    const color = c.cls.startsWith("product:") ? "#dc2626" : c.cls.startsWith("harness:") ? "#f59e0b" : c.cls.startsWith("model:") ? "#7c3aed" : "#6b7280";
    svg += `<text x="16" y="${y + 12}">${esc(c.cls)}</text>`;
    svg += `<rect x="380" y="${y}" width="${w}" height="14" fill="${color}"/>`;
    svg += `<text x="${386 + w}" y="${y + 12}">${c.n}</text>`;
  });
  svg += `</svg>`;
  writeFileSync(path.join(EVAL_DIR, "kpi-charts.svg"), svg);

  // Executed notebook: stdlib-only cells, real outputs captured at generation
  // time via the local python, so the file opens with fresh analysis and the
  // plugin's own sandbox cell runner can re-execute it unchanged.
  const cellSources = [
    [
      "import csv, collections, re",
      "rows = list(csv.DictReader(open('playwright-run-metrics.csv', encoding='utf-8')))",
      "def green(r):",
      "    return (r.get('primary_failure_class') or '').strip() in ('', 'none') or bool(re.search(r'passed|green|write_completed|fix_merged', r.get('mission_outcome') or '', re.I))",
      "print(f'{len(rows)} run rows; {sum(1 for r in rows if green(r))} green')",
    ],
    [
      "per_model = collections.defaultdict(lambda: [0, 0])",
      "for r in rows:",
      "    m = (r.get('model') or '').strip() or '(unset)'",
      "    per_model[m][0] += 1",
      "    per_model[m][1] += 1 if green(r) else 0",
      "for m, (n, g) in sorted(per_model.items(), key=lambda kv: -kv[1][0]):",
      "    print(f'{m}: {n} runs, {g} green ({100*g/n:.1f}%)')",
    ],
    [
      "classes = collections.Counter((r.get('primary_failure_class') or 'none').strip() for r in rows if not green(r))",
      "for cls, n in classes.most_common():",
      "    print(f'{cls}: {n}')",
      "repeats = [c for c, n in classes.items() if c.startswith('product:') and n > 1]",
      "print('REGRESSION ALARM:', repeats if repeats else 'none - every product: class fixed once and gone')",
    ],
    [
      "days = collections.defaultdict(lambda: [0, 0])",
      "for r in rows:",
      "    d = (r.get('run_started_at') or '')[:10]",
      "    if d:",
      "        days[d][0] += 1",
      "        days[d][1] += 1 if green(r) else 0",
      "for d, (n, g) in sorted(days.items()):",
      "    print(f'{d}: {n} runs, {g} green ({100*g/n:.1f}%)')",
    ],
    [
      "te = list(csv.DictReader(open('tool-events.csv', encoding='utf-8')))",
      "attempted = [e for e in te if e['status'] not in ('cancelled', 'queued', 'ready')]",
      "per_tool = collections.defaultdict(lambda: [0, 0])",
      "for e in attempted:",
      "    per_tool[e['tool']][0] += 1",
      "    per_tool[e['tool']][1] += 1 if e['status'] == 'complete' else 0",
      "print('tool call success rates (attempted graph nodes):')",
      "for t, (n, ok) in sorted(per_tool.items(), key=lambda kv: -kv[1][0]):",
      "    print(f'  {t}: {ok}/{n} ({100*ok/n:.1f}%)')",
    ],
  ];
  const NL = String.fromCharCode(10);
  const cells = [{
    cell_type: "markdown", metadata: {},
    source: [
      "# Eval KPI analysis" + NL, NL,
      "Executed automatically by `scripts/eval-dashboard.mjs` after every `npm test`." + NL,
      "Cells are Python-stdlib only, so the plugin's own sandbox cell runner can execute this notebook too." + NL,
    ],
  }];
  // One python process with a shared namespace, like a real kernel: later
  // cells see earlier cells' bindings, and stdout is captured per cell.
  const RUNNER = [
    'import sys, json, io, contextlib',
    'cells = json.load(sys.stdin)',
    'ns = {}',
    'outs = []',
    'for src in cells:',
    '    buf = io.StringIO()',
    '    try:',
    '        with contextlib.redirect_stdout(buf):',
    '            exec(src, ns)',
    '    except Exception as error:',
    '        buf.write(f"ERROR: {error}")',
    '    outs.append(buf.getvalue())',
    'print(json.dumps(outs))',
  ].join(String.fromCharCode(10));
  let cellOutputs = [];
  try {
    const stdout = execFileSync('python', ['-c', RUNNER], {
      cwd: EVAL_DIR, encoding: 'utf8', timeout: 60_000,
      input: JSON.stringify(cellSources.map((src) => src.join(NL))),
    });
    cellOutputs = JSON.parse(stdout);
  } catch (error) {
    cellOutputs = cellSources.map(() => `runner failed: ${String(error.message ?? error).slice(0, 200)}`);
  }
  let executionCount = 0;
  for (const source of cellSources) {
    executionCount += 1;
    const text = cellOutputs[executionCount - 1] ?? '';
    cells.push({
      cell_type: 'code', execution_count: executionCount, metadata: {},
      source: source.map((line, i) => (i < source.length - 1 ? line + NL : line)),
      outputs: text ? [{ output_type: 'stream', name: 'stdout', text: text.split(new RegExp("(?<=" + NL + ")")) }] : [],
    });
  }
  const notebook = {
    cells,
    metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" }, language_info: { name: "python" } },
    nbformat: 4, nbformat_minor: 5,
  };
  writeFileSync(path.join(EVAL_DIR, "kpi-analysis.ipynb"), JSON.stringify(notebook, null, 1) + NL);

  if (!QUIET) console.log(`Eval dashboard regenerated: ${records.length} rows -> kpi-dashboard.md, kpi-charts.svg, kpi-analysis.ipynb`);
} catch (error) {
  if (!QUIET) console.log(`eval-dashboard: skipped (${String(error.message ?? error).slice(0, 160)})`);
}
process.exit(0);
