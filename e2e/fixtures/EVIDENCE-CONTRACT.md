# Evidence contract v1 (normalized tool-call and mission evidence)

Owner: Agent 3. Reviewers: Agent 2 (runtime producer), Agent 4 (qualification consumer).
Base: `0f63c501fe14d471d5010e8dfd49b33b9857552e`.
Status: **v1, minimal, publishable now.** Sections marked `[v1.1 pending]` are the changes
I am implementing; they are additive and named here so Agent 2 and Agent 4 can build against
the final shape instead of waiting.

This document specifies **semantics over the types that already exist**. It creates no new
schema, no second classifier, no second counter and no second persistent evidence store.
Every field named below already exists in the repo, or is an additive field on an existing
type that keeps old readers working.

---

## 1. The existing types. Do not duplicate them.

| Concern | Existing type | File |
| --- | --- | --- |
| Normalized event | `ToolCallOutcomeEventV1` | `e2e/fixtures/toolCallOutcomes.ts` |
| The one fold | `foldToolCallOutcomesV1` | `e2e/fixtures/toolCallOutcomes.ts` |
| The one merge | `mergeToolCallOutcomeCountsV1` | `e2e/fixtures/toolCallOutcomes.ts` |
| Counts | `ToolCallOutcomeCountsV1` | `e2e/fixtures/toolCallOutcomes.ts` |
| Failure bucket vocabulary | `TOOL_REFUSAL_MARKER_BUCKETS` | `e2e/reporters/dailyUseReporter.ts` |
| Receipt work verdict | `classifyToolReceiptWork` | `e2e/reporters/dailyUseReporter.ts` |
| Page-side capture | `ToolCallCollectorSegmentV1` / `armToolCallCollector` | `e2e/fixtures/toolCallCollector.ts` |
| Pre-teardown persistence | `preserveFailureEvidence` | `e2e/fixtures/preserveFailureEvidence.ts` |
| Runtime event shapes | `AgentToolRunEvent`, `AgentTraceEvent`, `AgentRunReceipt`, `AgentRunMetricEvent`, `AgentRunEvents` | `src/AgentRunner.ts` |
| Coordinator identity/snapshot | `RunCoordinatorSnapshot` | `src/agent/runCoordinator.ts` |

There is exactly one fold and one bucket vocabulary. A second one is the failure shape this
repo keeps paying for; reviewers should reject any patch that introduces one.

---

## 2. Identities used for deduplication

All three levels already exist. Nobody needs to invent an id.

**Logical call key.** `baseCallKey(id)` in `toolCallOutcomes.ts`. Trace ids are
`${step}:${index}:${toolName}` extended with `:start` / `:result`; both phases fold onto one
logical call. `onToolDone` uses the unsuffixed id. Refusal ids may extend a call key with
further `:`-segments (`:graph-rejected`, `:authority:denied`) and are resolved back to their
owning call by `resolveRejectionOwner`, so one logical call reported on two streams is one
failure, not two.

**Coordinator-start (segment) identity.** `RunCoordinatorSnapshot.providerUsageScopeId` —
already documented in the runtime as "stable identity for one coordinator start, including all
delegated model workers". Fallback `RunCoordinatorSnapshot.runId`.

**Root mission identity.** `rootMissionId` (`src/agent/durableMission.ts`,
`resolveSourceCacheMissionId` in `src/tools/sourceCache.ts`) is the span that owns evidence and
aggregate usage. A resumed segment gets a fresh `runId`; the research worker suffixes `runId`
per participant. Evidence therefore telescopes over `rootMissionId`, never `runId`.

### Deduplication rules

1. Within one coordinator start, events are de-duplicated by `(kind, id)`. Replayed buffer +
   live tail therefore counts once. Receipts de-duplicate by `receipt.id`; an id-less receipt
   counts once per sighting, so producers should carry `id`.
2. Segments that share a **non-null** coordinator-start identity are folded **together** (one
   id namespace). `[v1.1 pending]` — today they are folded separately, which double-counts a
   replayed prefix when a lane arms twice against the same coordinator.
3. Segments with **different** coordinator-start identities are folded **separately** and then
   merged. This is what keeps a `restartCorePlugin` resume honest: a resumed run may re-issue
   `step:index:name` ids, and one flat fold would collapse two real calls into one.
4. A segment that observed events but cannot name its coordinator-start identity, when more
   than one such segment exists, degrades the merged answer to `lossy`. Unprovable sameness is
   unknown, never assumed. `[v1.1 pending]`

---

## 3. Capture states: complete, lossy, unobserved

`ToolCallOutcomeCountsV1.coverage` is `"complete" | "lossy" | "unobserved"` — already shipped.

- **complete** — the capture can account for the whole stream it claims. Every headline count
  is a number, and every failure bucket key is present, so an untouched bucket is an
  explicit `0`.
- **lossy** — something was observed but the capture cannot prove it is whole. All headline
  counts go `null`; recovered lower bounds go to `atLeast: { attempted, failed }`, which is
  diagnostic only and must never be promoted into a headline by a consumer.
- **unobserved** — nothing was captured at all (never armed, or a relaunched process took the
  slot). All counts `null`, `observedEvents: 0`.

### What must produce `lossy`

- segment overflow (`TOOL_CALL_COLLECTOR_EVENT_CAP`, 5000 events per segment);
- armed beside an already-running mission whose coordinator had already dropped events, or
  would not say how many (`armDroppedEventCount === null || > 0`);
- **a harvest that threw on a page we know was armed** `[v1.1 pending]` — today this returns
  `unobserved` with `observedEvents: 0`, and the merge silently absorbs it, so a lane with one
  dead harvest and one good one reports **complete**. That is a false green;
- **an armed page that closed without ever being harvested** `[v1.1 pending]` — owned-process
  relaunch destroys the renderer and with it every unharvested segment;
- **a fold whose caller declared `coverage: "lossy"` but which saw zero events**
  `[v1.1 pending]` — today it returns `unobserved`, which the merge then absorbs.

### Merge rule

`mergeToolCallOutcomeCountsV1` takes the **weaker** coverage: one lossy input makes the merged
answer lossy. Only an `unobserved` input with `observedEvents === 0` is absorbed as a no-op.
`[v1.1 pending]` — today the absorb test is `observedEvents === 0` alone, which swallows
`lossy` too.

**Anti-vacuity rule (binding on all consumers).** An empty evidence set is **not** complete.
`unobserved` and `lossy` must never satisfy a completeness or qualification predicate. A gate
that passes when handed zero events is a defect, not a pass.

---

## 4. Unknown counts are `null`, never `0`

Every field of `ToolCallOutcomeCountsV1` is emitted explicitly so `null` survives
`JSON.stringify` distinctly from `0`. `unknownToolCallOutcomeCountsV1(coverage)` is the only
constructor for an unknown row.

Terminal-state rules, binding on producers and consumers:

- A call that started with no known terminal event is `undetermined`. **Never** counted as
  succeeded. Invariant: `succeeded + failed + undetermined === attempted`.
- `onToolDone` with `ok: null` proves the call ended but not how -> `undetermined`.
- A failed call stays failed even if the mission later recovers. Recovery changes the mission
  outcome, never the call outcome.
- `succeededWithWork = max(0, succeeded - vacuous)`. `intentionalNoOp` (commitKind
  `no_op`/`reconciled`) stays inside success: a correct idempotent replay is not a failure to
  do work.
- `vacuous` is receipt-derived and is **not** a subset partition of `succeeded`; a call may
  emit zero or one receipts. Do not compute `succeeded - vacuous` expecting a partition.

---

## 5. Bounded, allowlisted failure vocabulary

The bucket keys are exactly `TOOL_REFUSAL_MARKER_BUCKETS` plus `"other"`
(`TOOL_CALL_FAILURE_BUCKET_KEYS`):

`tool_not_allowed`, `frontier_narrowed_mid_response`, `frontier_withheld_since_earlier_step`,
`mission_graph_authority_blocked`, `invalid_arguments`, `execution_failed`,
`authority_grant_invalid`, `tool_failure_terminal`, `other`.

Classification is `classifyToolFailureBucketV1(errorCode)`; an unmatched or missing code lands
in `other` **as data**, never dropped. The raw code is retained verbatim in
`failureDetails[].errorCode` (bounded at `TOOL_CALL_FAILURE_DETAIL_CAP = 32`, with
`failureDetailsTruncated` set when the bound bit).

### The channel Agent 2 must use — and the runtime type files needed

**Decision: Agent 2 needs no new runtime type file, and should create none.**

The only failure information that crosses the renderer boundary is the **`code` string** on
the existing error shape `{ code: string; message: string }`, carried by:

- `AgentToolRunEvent.error.code` (via `onToolDone`), and
- `AgentTraceEvent.error.code` (via `onTrace`, kinds `tool_result` / `tool_rejected`).

Both already exist in `src/AgentRunner.ts`. Nothing else is read. Specifically:

- `error.message` is **never** projected. Do not encode a cause into the message expecting the
  evidence chain to carry it — it will be dropped.
- Preserving a typed sandbox cause therefore means widening the `code` **value**, not adding a
  field or a type. `CodeSandboxContributionErrorV2` codes already survive; the unknown-error
  fallback `sandbox_prepare_rejected` already exists at
  `extensions/code/sandbox/CodeExecutionContributionsV2.ts:1088-1090`.
- A failure **stage** must be expressed as an allowlisted `code` value in the existing
  `<stage>_<cause>` style (`sandbox_prepare_rejected` is already one). Send me the exact list
  of new code values; I add the matching bucket key in `toolCallOutcomes.ts` /
  `dailyUseReporter.ts` (my files — Agent 2 must not edit them). Until then new codes land in
  `other` with the verbatim code retained, which is honest, not lossy.
- **Unknown stays unknown.** Do not synthesise a cause from the model's wording, and do not
  map an unrecognised exception onto a specific bucket to make a row look explained.

Adding a bucket key is **additive**: old readers that key on the names they know keep working
and simply see one more key. Changing what an existing key *means* is not additive and
requires a new contract version (section 8).

---

## 6. Actual transport versus cached fallback

The distinction already exists in the runtime and is currently **not represented in the
evidence at all**. `[v1.1 pending]` adds it, from the existing signal only:

`AgentRunner` emits `onMetric({ kind: "tool", name, step, ... })` on **every** tool execution:

- served from the in-run tool cache: `cached: true`, `durationMs: 0`, plus `savedDurationMs`
  (`src/AgentRunner.ts` ~39546);
- actually executed: same event **without** `cached` (~39587), including the throwing path.

Contract:

- `servedFromCache` — sightings of `kind:"tool"` metrics with `cached === true`.
- `transportExecuted` — sightings of `kind:"tool"` metrics without `cached === true`.
- These are **execution sightings, not de-duplicated logical calls**: `AgentRunMetricEvent`
  carries no `id`, only `(name, step)`, so two calls to the same tool in one step are
  indistinguishable.
- Because the coordinator buffers and replays **all** events including metrics
  (`runCoordinator.ts:792`, `:288`), a segment armed while a mission was already running can
  receive a metric twice and cannot de-duplicate it. **Rule: both counters are `null`
  (unknown) unless every contributing segment armed with `armedWhileRunning === false`.**
  `RunCoordinator.start()` clears the buffer (`runCoordinator.ts:324`), so a segment armed
  before the mission starts provably sees each metric once.
- A cached serve still counts as an attempted and (if it ends ok) a succeeded logical call.
  Cache is a statement about transport, never about outcome.
- Unknown remains `null`; zero metrics observed does **not** mean zero transport.

**Hard privacy rule:** `AgentRunMetricEvent.cacheKey` is
`` `${name}:${stableStringify(args)}` `` (`src/AgentRunner.ts:40512`) — it **contains the raw
tool arguments**. It must never cross the renderer boundary, never be projected, never be
logged into an artifact. Only the boolean and the tool name are taken.

Separately, `src/tools/sourceCache.ts` (`CachedSource.fetchedForMission`,
`resolveSourceCacheMissionId`) and `web_search`'s `fromCache` / `cachedPath` describe
*retrieval-level* cache. They are scoped by `rootMissionId` and are the authority for source
freshness. They are **not** projected into the tool-call evidence and are out of scope for v1.

---

## 7. Privacy: the public-compatible projection

What crosses the renderer boundary is an allowlist, not a redaction pass.

**Allowed:** event `kind`; logical call `id` (`${step}:${index}:${toolName}` — identity only);
`toolName`; `error.code`; `ok`; receipt `operation`, `bytesWritten`, `bytesDeleted`,
`affectedCount`, `commitKind`, `purpose` (only the three `validation_*` literals),
`readback.status === "verified"`, `exitCode`, `effects.changed`; segment `index`,
`armDroppedEventCount`, `armedWhileRunning`, `overflowed`; coordinator-start identity and
`runId` `[v1.1 pending]`; the `cached` boolean `[v1.1 pending]`.

**Forbidden, with no exception:** raw tool arguments; `cacheKey`; note or vault content; file
system or vault paths (`path`, `toPath`, `backupPath`, `cachedPath`); commands and command
output; provider payloads, prompts, responses and `inputPreview` / `outputPreview`;
credentials or any part of them; hidden reasoning / thinking deltas; `error.message`; receipt
`message` and `output`; receipt ids in the diagnostic projection.

The page-side `recent` ring in the collector holds free-form status and trace **messages**.
It is deliberately **excluded** from `readToolCallCollectorRawV1`'s projection and must stay
excluded; it exists only so the harness can say what a coordinator that failed to settle was
last doing. Any patch that harvests `recent` into counts, diagnostics or an attached artifact
breaks this contract.

`preserveFailureEvidence`'s `metadata` parameter is **not** a sanitization boundary. It writes
whatever it is handed, verbatim, to disk. Callers select the fields; the helper guarantees
only *when* the record is written, never *what* is safe to put in it. Bounded private
failed-program artifacts (Agent 1's retained failing prefix) are a separate, private,
run-owned artifact class — they must not be routed into the public-compatible metric
projection.

---

## 8. Compatibility and versioning

- **Additive** (allowed in v1.x, old readers keep working): a new optional field on
  `ToolCallOutcomeCountsV1`; a new member of the `ToolCallOutcomeEventV1` union; a new field on
  `ToolCallCollectorSegmentV1`; a new failure bucket key; a new `error.code` value.
- **Breaking** (requires a new `version` and a new contract section): changing what an existing
  count means; changing a bucket key's meaning; removing a field; changing `null` semantics;
  making an existing `complete` result narrower or wider.
- `ToolCallOutcomeCountsV1.version` stays `1` for additive changes. If a meaning changes, the
  field becomes `2` and this document gets a v2 section — consumers must then branch, not
  reinterpret.
- **Historical rows are never rewritten.** `docs/eval/playwright-run-metrics.csv`, the
  acceptable90 campaign evidence under `C:\private-e2e\technical-gap-roi\docs\eval`, and the
  59/60 + 433/437 starting figures stand as recorded. Measurement repairs do not retroactively
  improve them.

---

## 9. Known collection limits (unresolved as of v1)

1. `e2e/fixtures/realAiHarness.ts` `relaunchOwnedProcess` **neither harvests before nor re-arms
   after** an owned-process relaunch. The renderer, and with it every unharvested segment, is
   destroyed. `e2e/byok-autonomous-journey.spec.ts` harvests first, but only on the failure
   path (`if (primaryError !== null && harness)`), so a green attempt whose page closed
   unexpectedly loses its whole capture. That file is **not** in my ownership row — Agent 4,
   I am requesting either that path or a narrower assignment.
2. Retrieval counters (section 6) are sightings, not logical calls, and are unknown whenever
   any segment armed mid-run.
3. `MAX_BUFFERED_RUN_EVENTS` / `MAX_BUFFERED_RUN_EVENT_CHARS` truncation before a mid-run arm
   is detectable only through `droppedEventCount`; when the coordinator is gone the drop count
   is unrecoverable and the segment is `lossy` forever.
4. A single-segment capture whose coordinator identity is null is folded as today. There is no
   double-count risk with one segment, but there is also no proof of which mission it belongs
   to.
5. `preserveFailureEvidence` writes to `testInfo.outputPath(...)`, which a report cleanup can
   remove. It is a pre-teardown attempt record, not a durable campaign store; Agent 4's
   campaign record remains the authority for occurrences.

---

## 10. What reviewers should check

- **Agent 2:** that section 5 is the channel you actually need, and that no new runtime type
  file is required. If you need a stage dimension, send the exact allowlisted `code` values.
- **Agent 4:** that sections 3, 4 and 8 give your gate what it needs to reject a vacuous or
  unknown row, and that the anti-vacuity rule is stated strongly enough for your counterexamples.
- **Both:** that nothing here asks you to build a parallel schema.

Reviews to `C:\private-e2e\reliability99-coordination\inbox\agent-N-NNN-evidence-contract-review.md`,
not into this file.
