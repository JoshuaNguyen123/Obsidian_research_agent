import test from "node:test";
import assert from "node:assert/strict";
import {
  constrainToolsToMissionGraphFrontier,
  missionGraphFinalOnlyStubOwesRequiredWorkV1,
  narrowAdaptiveCodeMutationsToPlannedWritesV1,
  pinnedAppendFrontierRequiresSeededFilePatchV1,
  workspaceCreateReceiptProvesSeededFilesV1,
  type WorkspaceCreateReceiptShapeV1,
} from "../src/agent/missionGraphFrontier";
import { missionGraphOnlyFinalSynthesisRemainsV1 } from "../src/agent/missionGraphSelectors";
import {
  authoritativeRefusalFrontierToolNamesV1,
  countReadyMissionGraphToolSlots,
  readyMissionGraphFrontierToolNamesV1,
} from "../src/agent/missionGraphSelectors";
import type { ModelToolDefinition } from "../src/model/types";

const tool = (name: string): ModelToolDefinition => ({
  type: "function",
  function: { name, parameters: { type: "object", properties: {} } },
});

const CODE_MENU = [
  "read_template",
  "code_workspace_status",
  "code_workspace_read",
  "code_workspace_list",
  "code_workspace_mkdir",
  "code_workspace_create_file",
  "code_workspace_append",
  "code_workspace_write_expected",
  "code_workspace_patch",
  "code_sandbox_status",
  "append_to_current_file",
].map(tool);

test("a ready planned workspace write pins the menu to that mutation", () => {
  // Regression: with code_workspace_append ready, the broad route catalog
  // still offered create_file / write_expected / patch / mkdir. The model
  // wrote the file through create_file, the planned node stayed ready, and
  // every validator behind it was deferred until the segment budget expired.
  const narrowed = narrowAdaptiveCodeMutationsToPlannedWritesV1(CODE_MENU, {
    nodes: {
      "tool-04-code_workspace_create": {
        status: "complete",
        allowedTools: ["code_workspace_create"],
      },
      "tool-05-code_workspace_append": {
        status: "ready",
        allowedTools: ["code_workspace_append"],
      },
      "tool-06-code_validate_fast": {
        status: "queued",
        allowedTools: ["code_validate_fast"],
      },
    },
  });
  assert.deepEqual(
    narrowed.map((item) => item.function.name),
    [
      "read_template",
      "code_workspace_status",
      "code_workspace_read",
      "code_workspace_list",
      "code_workspace_append",
      "code_sandbox_status",
      "append_to_current_file",
    ],
  );
});

test("adaptive workspace mutations return once no ready node pins one", () => {
  const graph = {
    nodes: {
      "tool-05-code_workspace_append": {
        status: "complete",
        allowedTools: ["code_workspace_append"],
      },
      "tool-06-code_validate_fast": {
        status: "ready",
        allowedTools: ["code_validate_fast"],
      },
    },
  };
  assert.deepEqual(
    narrowAdaptiveCodeMutationsToPlannedWritesV1(CODE_MENU, graph),
    CODE_MENU,
  );
  assert.deepEqual(
    narrowAdaptiveCodeMutationsToPlannedWritesV1(CODE_MENU, null),
    CODE_MENU,
  );
});

test("two ready planned writes keep both pinned mutations", () => {
  const narrowed = narrowAdaptiveCodeMutationsToPlannedWritesV1(CODE_MENU, {
    nodes: {
      a: { status: "ready", allowedTools: ["code_workspace_create_file"] },
      b: { status: "running", allowedTools: ["code_workspace_patch"] },
    },
  });
  const names = narrowed.map((item) => item.function.name);
  assert.ok(names.includes("code_workspace_create_file"));
  assert.ok(names.includes("code_workspace_patch"));
  assert.ok(!names.includes("code_workspace_append"));
  assert.ok(!names.includes("code_workspace_write_expected"));
  assert.ok(names.includes("code_workspace_read"));
});

test("a failed planned write unpins its siblings so the named remedy stays callable", () => {
  // Pinning is a first-attempt focus aid, not a cage. Each adaptive mutation's
  // failure names a sibling as the remedy (patch -> create_file, create_file ->
  // write_expected, append on an absent path used to -> create_file). Keeping
  // the pin after a failure removes exactly the tool the error asks for.
  const nested = narrowAdaptiveCodeMutationsToPlannedWritesV1(CODE_MENU, {
    nodes: {
      "tool-05-code_workspace_patch": {
        status: "ready",
        allowedTools: ["code_workspace_patch"],
        // The production graph nests attempts under retries.
        retries: { attempts: 1 },
      },
    },
  });
  assert.deepEqual(nested, CODE_MENU);

  // UI/E2E projections flatten attempts; both shapes must unpin.
  const flat = narrowAdaptiveCodeMutationsToPlannedWritesV1(CODE_MENU, {
    nodes: {
      "tool-05-code_workspace_create_file": {
        status: "ready",
        allowedTools: ["code_workspace_create_file"],
        attempts: 2,
      },
    },
  });
  assert.deepEqual(flat, CODE_MENU);

  // A fresh node still pins.
  const fresh = narrowAdaptiveCodeMutationsToPlannedWritesV1(CODE_MENU, {
    nodes: {
      "tool-05-code_workspace_append": {
        status: "ready",
        allowedTools: ["code_workspace_append"],
        retries: { attempts: 0 },
      },
    },
  });
  assert.ok(!fresh.some((item) => item.function.name === "code_workspace_create_file"));
  assert.ok(fresh.some((item) => item.function.name === "code_workspace_append"));
});

const SEEDED_WORKSPACE_CREATE_RECEIPT: WorkspaceCreateReceiptShapeV1 = {
  toolName: "code_workspace_create",
  commitKind: "committed",
  readback: { status: "verified" },
  resource: { system: "workspace" },
  output: {
    repositoryWriteScope: {
      profileKey: "byok-autonomous-python",
      projects: [
        {
          projectId: "crdt-sync",
          projectRoot: "crdt-sync",
          allowedPaths: ["README.md", "crdt_sync.py"],
        },
      ],
    },
  },
};

const SCRATCH_WORKSPACE_CREATE_RECEIPT: WorkspaceCreateReceiptShapeV1 = {
  toolName: "code_workspace_create",
  commitKind: "committed",
  readback: { status: "verified" },
  resource: { system: "workspace" },
  output: {},
};

const PINNED_APPEND_GRAPH = {
  nodes: {
    "tool-04-code_workspace_create": {
      status: "complete",
      allowedTools: ["code_workspace_create"],
    },
    "tool-05-code_workspace_append": {
      status: "ready",
      allowedTools: ["code_workspace_append"],
      retries: { attempts: 0 },
    },
    "tool-06-code_validate_fast": {
      status: "queued",
      allowedTools: ["code_validate_fast"],
    },
  },
};

test("a pinned append over a repository-seeded workspace keeps patch as its companion", () => {
  // Live BYOK stage 8: the fixture seeds README.md ("Implementation pending.")
  // and the graph plans only code_workspace_append for the README step.
  // Replacing seeded placeholder content is not expressible with append, and
  // withholding patch sent the model into a thinking spiral over an
  // unsatisfiable menu. The seeded-workspace creation receipt is the earliest
  // host-verified proof that the pinned write's target may already exist.
  const narrowed = narrowAdaptiveCodeMutationsToPlannedWritesV1(
    CODE_MENU,
    PINNED_APPEND_GRAPH,
    [SEEDED_WORKSPACE_CREATE_RECEIPT],
  );
  const names = narrowed.map((item) => item.function.name);
  assert.ok(names.includes("code_workspace_append"));
  assert.ok(names.includes("code_workspace_patch"));
  // Only the append/patch pair widens; the rest of the pin holds.
  assert.ok(!names.includes("code_workspace_create_file"));
  assert.ok(!names.includes("code_workspace_write_expected"));
  assert.ok(!names.includes("code_workspace_mkdir"));
});

test("a pinned append over a scratch workspace stays append-only", () => {
  // A scratch workspace is empty at creation, so the planned append targets a
  // file the mission itself creates: no seeded content exists to replace and
  // the original pin is unchanged.
  const scratch = narrowAdaptiveCodeMutationsToPlannedWritesV1(
    CODE_MENU,
    PINNED_APPEND_GRAPH,
    [SCRATCH_WORKSPACE_CREATE_RECEIPT],
  );
  assert.ok(!scratch.some((item) => item.function.name === "code_workspace_patch"));
  assert.ok(scratch.some((item) => item.function.name === "code_workspace_append"));

  const noReceipts = narrowAdaptiveCodeMutationsToPlannedWritesV1(
    CODE_MENU,
    PINNED_APPEND_GRAPH,
  );
  assert.ok(!noReceipts.some((item) => item.function.name === "code_workspace_patch"));
});

test("the shared seeded-file predicate is the single authority for the widening", () => {
  // Production and tests must consume this one predicate; the expression is
  // never re-derived at a plant site.
  assert.equal(
    pinnedAppendFrontierRequiresSeededFilePatchV1(
      new Set(["code_workspace_append"]),
      [SEEDED_WORKSPACE_CREATE_RECEIPT],
    ),
    true,
  );
  // A planned patch already on the pin needs no widening.
  assert.equal(
    pinnedAppendFrontierRequiresSeededFilePatchV1(
      new Set(["code_workspace_append", "code_workspace_patch"]),
      [SEEDED_WORKSPACE_CREATE_RECEIPT],
    ),
    false,
  );
  // Non-append pins never widen.
  assert.equal(
    pinnedAppendFrontierRequiresSeededFilePatchV1(
      new Set(["code_workspace_create_file"]),
      [SEEDED_WORKSPACE_CREATE_RECEIPT],
    ),
    false,
  );
  // The proof must be a verified, committed workspace creation over a
  // repository scope; an unverified or scratch receipt proves nothing.
  assert.equal(
    workspaceCreateReceiptProvesSeededFilesV1(SEEDED_WORKSPACE_CREATE_RECEIPT),
    true,
  );
  assert.equal(
    workspaceCreateReceiptProvesSeededFilesV1(SCRATCH_WORKSPACE_CREATE_RECEIPT),
    false,
  );
  assert.equal(
    workspaceCreateReceiptProvesSeededFilesV1({
      ...SEEDED_WORKSPACE_CREATE_RECEIPT,
      readback: { status: "failed" },
    }),
    false,
  );
});

test("an active validation recovery window is never narrowed", () => {
  // A red validation opens the diagnostic + correction set on purpose. If a
  // ready node also names an adaptive mutation, pinning would strip exactly
  // the correction tools the repair cycle depends on.
  const narrowed = narrowAdaptiveCodeMutationsToPlannedWritesV1(CODE_MENU, {
    nodes: {
      "tool-06-code_validate_fast": {
        status: "queued",
        allowedTools: ["code_validate_fast"],
        outputs: {
          validationRecovery: {
            status: "awaiting_correction",
            fastNodeId: "tool-06-code_validate_fast",
            repairNodeId: "tool-07-code_repair_record_cycle",
          },
        },
      },
      "tool-07-code_repair_record_cycle": {
        status: "ready",
        allowedTools: ["code_repair_record_cycle"],
      },
      "tool-05-code_workspace_append": {
        status: "ready",
        allowedTools: ["code_workspace_append"],
      },
    },
  });
  assert.deepEqual(narrowed, CODE_MENU);
});

test("an exact planned frontier never advertises a tool its own authority will refuse", () => {
  // Stage 8, 45 consecutive refusals. The offered menu carried the whole
  // GitHub read surface while MissionGraphSession refused every one of them
  // with "not ready in the exact authoritative mission graph". The model had
  // no way to learn which entries were callable except by calling them, so it
  // enumerated the list one refused call at a time.
  //
  // The two computations disagreed on one term. The offer read
  // `setLooseCompoundEnabled || !missionGraphUsesExactPlannedFrontier`; the
  // authority read `!missionGraphUsesExactPlannedFrontier`. On a set-loose
  // compound mission with an exact planned frontier the first is true and the
  // second is false, so everything unplanned was advertised and nothing
  // unplanned was admitted.
  const menu = [
    "read_template",
    "web_search",
    "github_get_repository",
    "github_get_commit",
    "github_get_reference",
    "github_list_branches",
    "github_get_tree",
    "append_jupyter_reflection",
  ];
  const definitions = menu.map(tool);
  // The terminal shape: the reflection node has paid and nothing is ready.
  const graph = {
    nodes: {
      reflect: {
        id: "reflect",
        status: "complete",
        allowedTools: ["append_jupyter_reflection"],
        inputs: {},
        outputs: {},
      },
      final: { id: "final", status: "queued", allowedTools: [], inputs: {}, outputs: {} },
    },
    capabilityEnvelope: { tools: {} },
  } as any;

  assert.deepEqual(
    readyMissionGraphFrontierToolNamesV1(graph),
    [],
    "nothing is ready in this graph",
  );

  const offeredUnderExactFrontier = constrainToolsToMissionGraphFrontier(
    definitions,
    graph,
    {
      setLooseOfferedToolNames: menu,
      allowDynamicReadContinuation: false,
    },
  ).map((definition) => definition.function.name);

  for (const name of [
    "github_get_repository",
    "github_get_commit",
    "github_get_reference",
    "github_list_branches",
    "github_get_tree",
  ]) {
    assert.equal(
      offeredUnderExactFrontier.includes(name),
      false,
      `${name} has no ready node and no dynamic continuation; offering it advertises a refusal`,
    );
  }

  // Without an exact planned frontier the same unplanned reads stay available,
  // because there authority really will materialize a bounded dynamic node.
  const offeredUnderDynamicFrontier = constrainToolsToMissionGraphFrontier(
    definitions,
    graph,
    {
      setLooseOfferedToolNames: menu,
      allowDynamicReadContinuation: true,
    },
  ).map((definition) => definition.function.name);
  assert.ok(
    offeredUnderDynamicFrontier.includes("github_get_commit"),
    "dynamic read continuation must keep unplanned companions callable",
  );
});

test("slot counting and frontier naming are one readiness answer", () => {
  // Three predicates for "may this tool run now?" is how the offer and the
  // authority drifted apart. Anything that decides what to offer, what to
  // schedule, or what to name as the next call must agree with the node-level
  // rule MissionGraphSession admits calls from.
  const graph = {
    nodes: {
      a: { id: "a", status: "ready", allowedTools: ["code_workspace_append"], inputs: {}, outputs: {} },
      b: { id: "b", status: "ready", allowedTools: ["code_validate_fast"], inputs: {}, outputs: {} },
      c: { id: "c", status: "running", allowedTools: ["github_create_repository"], inputs: {}, outputs: {} },
      d: { id: "d", status: "queued", allowedTools: ["github_get_commit"], inputs: {}, outputs: {} },
    },
    capabilityEnvelope: { tools: {} },
  } as any;

  const named = readyMissionGraphFrontierToolNamesV1(graph);
  assert.deepEqual(named.sort(), ["code_validate_fast", "code_workspace_append"]);
  for (const name of [
    "code_workspace_append",
    "code_validate_fast",
    "github_create_repository",
    "github_get_commit",
    "never_planned_tool",
  ]) {
    assert.equal(
      countReadyMissionGraphToolSlots(graph, name) > 0,
      named.includes(name),
      `${name}: slot count and frontier naming must give the same answer`,
    );
  }
});

test("an implementation frontier keeps the reads its hash-bound writes depend on", () => {
  // Regression I caused. Narrowing the offer to match authority, I gated the
  // whole "soft or observation" branch on dynamic read continuation. But the
  // observation tools are not unplanned companions needing a dynamic node:
  // mayBypassMissionGraphStartForSetLooseSoftCompanion names them explicitly
  // and grants them a graph-start bypass -- gated on their being offered. So
  // dropping them from the menu silently disabled their own authority path,
  // and a frontier offering code_workspace_write_expected had no tool left
  // that could inspect the target it writes to.
  const menu = [
    "code_workspace_read",
    "code_workspace_list",
    "code_workspace_stat",
    "code_workspace_write_expected",
    "code_workspace_patch",
    "github_get_repository",
    "github_get_commit",
    "web_search",
  ];
  const definitions = menu.map(tool);
  const graph = {
    nodes: {
      write: {
        id: "write",
        status: "ready",
        allowedTools: ["code_workspace_write_expected"],
        inputs: {},
        outputs: {},
      },
    },
    capabilityEnvelope: { tools: {} },
  } as any;

  const offered = constrainToolsToMissionGraphFrontier(definitions, graph, {
    setLooseOfferedToolNames: menu,
    allowDynamicReadContinuation: false,
  }).map((definition) => definition.function.name);

  for (const readTool of [
    "code_workspace_read",
    "code_workspace_list",
    "code_workspace_stat",
  ]) {
    assert.ok(
      offered.includes(readTool),
      `${readTool} must stay callable beside a hash-bound write`,
    );
  }
  assert.ok(offered.includes("code_workspace_write_expected"));

  // The enumeration surface that caused 45 refusals must stay closed: those
  // are ordinary Soft companions with no bypass and no ready node.
  for (const enumerated of ["github_get_repository", "github_get_commit", "web_search"]) {
    assert.equal(
      offered.includes(enumerated),
      false,
      `${enumerated} has no graph-start bypass and must stay off an exact frontier`,
    );
  }
});

test("a tool-less ready final still offers current-note writes when no mutation has paid", () => {
  // Proof-matrix interrupted-continuation, 2026-08-25: resume of a streamed
  // two-append mission restored only `final` with allowedTools=[], offered the
  // model zero tools, and died after two empty turns.
  const definitions = [
    "web_search",
    "linear_create_issue",
    "append_to_current_file",
    "replace_current_file",
    "read_current_file",
  ].map(tool);
  const streamingStub = {
    nodes: {
      dispatch: {
        id: "dispatch",
        status: "complete",
        allowedTools: [],
        inputs: {},
        outputs: {},
      },
      final: {
        id: "final",
        status: "ready",
        allowedTools: [],
        inputs: {},
        outputs: {},
        completionContract: { requiredEvidenceKinds: ["final-output"] },
      },
    },
    capabilityEnvelope: { tools: {} },
  } as any;

  const offered = constrainToolsToMissionGraphFrontier(definitions, streamingStub, {
    route: "single_model_writeback",
  }).map((definition) => definition.function.name);
  assert.ok(
    offered.includes("append_to_current_file"),
    `resume must offer append, got ${offered.join(",")}`,
  );
  assert.equal(offered.includes("linear_create_issue"), false);
  assert.equal(offered.includes("web_search"), false);

  // "Paid" requires proof: only a completed write node CARRYING its receipt
  // closes the fallback. A status flip alone proves nothing (a crash can
  // persist `complete` without the receipt), and the graph authority would
  // still authorize the re-offered append through a dynamic continuation.
  const afterPaidWrite = {
    nodes: {
      write: {
        id: "write",
        status: "complete",
        allowedTools: ["append_to_current_file"],
        inputs: {},
        outputs: {},
        receipts: [
          {
            id: "receipt-append-1",
            kind: "action-receipt",
            fingerprint: `sha256:${"a".repeat(64)}`,
            observedAt: "2026-08-25T22:41:00.000Z",
          },
        ],
      },
      final: {
        id: "final",
        status: "ready",
        allowedTools: [],
        inputs: {},
        outputs: {},
        completionContract: { requiredEvidenceKinds: ["final-output"] },
      },
    },
    capabilityEnvelope: { tools: {} },
  } as any;
  assert.deepEqual(
    constrainToolsToMissionGraphFrontier(definitions, afterPaidWrite, {
      route: "single_model_writeback",
    }).map((definition) => definition.function.name),
    [],
    "paid current-note writes must not re-open append on the final node",
  );

  const completeWithoutProof = {
    ...afterPaidWrite,
    nodes: {
      ...afterPaidWrite.nodes,
      write: { ...afterPaidWrite.nodes.write, receipts: [] },
    },
  } as any;
  assert.ok(
    constrainToolsToMissionGraphFrontier(definitions, completeWithoutProof, {
      route: "single_model_writeback",
    })
      .map((definition) => definition.function.name)
      .includes("append_to_current_file"),
    "a completed write node with neither receipts nor evidence proved nothing; the owed current-note write must stay offered",
  );
});

test("the final-only stub-owes predicate answers the crash shape and its proven complement", () => {
  const finalReady = {
    id: "final",
    status: "ready",
    allowedTools: [],
    inputs: {},
    outputs: {},
    completionContract: { requiredEvidenceKinds: ["final-output"] },
  };
  // The exact deadlock artifact: ONE ready tool-less `final`, nothing else.
  // missionGraphOnlyFinalSynthesisRemainsV1 is satisfied VACUOUSLY here (no
  // non-final node exists to check) — pin both halves so neither predicate
  // can silently stop covering the shape that burned the continuation budget
  // (proof-matrix interrupted-continuation, 2026-08-25 22:41Z).
  const bareStub = {
    nodes: { final: finalReady },
    capabilityEnvelope: { tools: {} },
  } as any;
  assert.equal(missionGraphOnlyFinalSynthesisRemainsV1(bareStub), true);
  assert.equal(missionGraphFinalOnlyStubOwesRequiredWorkV1(bareStub), true);

  // Same shape reached by the second path — a replan whose append node was
  // filtered because a goal was marked done WITHOUT a receipt — must answer
  // identically: a goal flag is not proof.
  const receipt = {
    id: "receipt-1",
    kind: "action-receipt",
    fingerprint: `sha256:${"b".repeat(64)}`,
    observedAt: "2026-08-25T22:41:00.000Z",
  };
  const paidStub = {
    nodes: {
      final: finalReady,
      write: {
        id: "write",
        status: "complete",
        allowedTools: ["append_to_current_file"],
        inputs: {},
        outputs: {},
        receipts: [receipt],
      },
    },
    capabilityEnvelope: { tools: {} },
  } as any;
  assert.equal(missionGraphFinalOnlyStubOwesRequiredWorkV1(paidStub), false);

  const unprovenComplete = {
    ...paidStub,
    nodes: {
      ...paidStub.nodes,
      write: { ...paidStub.nodes.write, receipts: [], evidence: [] },
    },
  } as any;
  assert.equal(
    missionGraphFinalOnlyStubOwesRequiredWorkV1(unprovenComplete),
    true,
    "a completed node carrying neither receipts nor evidence proved nothing",
  );

  const liveFrontier = {
    ...paidStub,
    nodes: {
      ...paidStub.nodes,
      write: { ...paidStub.nodes.write, status: "ready", receipts: [] },
    },
  } as any;
  assert.equal(
    missionGraphFinalOnlyStubOwesRequiredWorkV1(liveFrontier),
    false,
    "a real ready frontier is not the stub shape; the graph serves the tool itself",
  );

  assert.equal(missionGraphFinalOnlyStubOwesRequiredWorkV1(null), false);
  assert.equal(
    missionGraphFinalOnlyStubOwesRequiredWorkV1({
      nodes: {},
      capabilityEnvelope: { tools: {} },
    } as any),
    false,
  );
});

// --- Instance #17: one authority for every message that names a tool -------

test("the end-of-mission capability-read menu is not an authoritative frontier", () => {
  // Reproduces the exact live shape (main @3860ee6). `write_project_results`
  // had already paid at step 20; every node is terminal and the graph's ready
  // frontier is empty. The OFFERED menu is still six names, because
  // `includeCapabilityReads` unions every read-effect capability grant into it
  // (AgentRunner passes `setLooseCompoundEnabled || dynamicRead...`) while the
  // authority is handed only `allowDynamicReadContinuation:
  // dynamicReadContinuationAllowed()`. Those two booleans disagree by exactly
  // this set, which is why step 21's refusal advertised it and step 22 refused
  // the first name on it.
  const offered = [
    "read_current_file",
    "list_markdown_files",
    "read_file",
    "read_template",
    "web_search",
    "web_fetch",
  ];
  const graph = {
    nodes: {
      "tool-20-write_project_results": {
        id: "tool-20-write_project_results",
        status: "complete",
        allowedTools: ["write_project_results"],
        inputs: {},
        outputs: {},
      },
      // Queued, not complete: the mission had not emitted its final answer
      // yet, which is why the run was still calling tools at step 21 — and why
      // `shouldSuppressOptionalMissionGraphFrontier` does NOT fire and the
      // capability reads reach the offered menu.
      final: {
        id: "final",
        status: "queued",
        allowedTools: [],
        inputs: {},
        outputs: {},
      },
    },
    capabilityEnvelope: {
      tools: Object.fromEntries(
        offered.map((name) => [name, { effect: "read" }]),
      ),
    },
  } as any;

  assert.deepEqual(
    readyMissionGraphFrontierToolNamesV1(graph),
    [],
    "the authoritative frontier really is empty here",
  );
  // The menu the refusal used to print.
  const offeredUnderCapabilityReads = constrainToolsToMissionGraphFrontier(
    offered.map(tool),
    graph,
    { includeCapabilityReads: true },
  ).map((definition) => definition.function.name);
  assert.deepEqual(
    offeredUnderCapabilityReads,
    offered,
    "the offered menu is the six capability reads, exactly as observed live",
  );
  // The list any message is allowed to name, under the same flag the authority
  // was given. Empty: nothing here is callable.
  assert.deepEqual(
    authoritativeRefusalFrontierToolNamesV1({
      graph,
      candidateToolNames: offeredUnderCapabilityReads,
      allowDynamicReadContinuation: false,
    }),
    [],
  );
  // Flip only the authority's own flag and the same names become callable,
  // because `beginToolExecution` will materialize a bounded dynamic read node.
  // The predicate tracks the authority in both directions; it is not a blanket
  // "reads are never allowed" rule.
  assert.deepEqual(
    authoritativeRefusalFrontierToolNamesV1({
      graph,
      candidateToolNames: offeredUnderCapabilityReads,
      allowDynamicReadContinuation: true,
    }),
    offered,
  );
});

test("the shared predicate never widens past the authority", () => {
  const graph = {
    nodes: {
      a: {
        id: "a",
        status: "ready",
        allowedTools: ["code_validate_fast"],
        inputs: {},
        outputs: {},
      },
      b: {
        id: "b",
        status: "queued",
        allowedTools: ["code_commit_verified"],
        inputs: {},
        outputs: {},
      },
      c: {
        id: "c",
        status: "complete",
        allowedTools: ["code_workspace_create"],
        inputs: {},
        outputs: {},
      },
    },
    capabilityEnvelope: { tools: { read_file: { effect: "read" } } },
  } as any;
  const menu = [
    "code_validate_fast",
    "code_commit_verified",
    "code_workspace_create",
    "read_file",
  ];
  // Queued and complete nodes are not ready; a read grant is admitted only
  // under the authority's own continuation flag.
  assert.deepEqual(
    authoritativeRefusalFrontierToolNamesV1({
      graph,
      candidateToolNames: menu,
    }),
    ["code_validate_fast"],
  );
  assert.deepEqual(
    authoritativeRefusalFrontierToolNamesV1({
      graph,
      candidateToolNames: menu,
      allowDynamicReadContinuation: true,
    }),
    ["code_validate_fast", "read_file"],
  );
  // The refused name is never advertised back at the model that just tried it.
  assert.deepEqual(
    authoritativeRefusalFrontierToolNamesV1({
      graph,
      candidateToolNames: menu,
      excludeToolNames: ["code_validate_fast"],
    }),
    [],
  );
  // A candidate the model has no schema for is never named, even when the
  // graph would admit it: the intersection runs both ways.
  assert.deepEqual(
    authoritativeRefusalFrontierToolNamesV1({
      graph,
      candidateToolNames: ["read_file"],
    }),
    [],
  );
  // No graph means no MissionGraphSession and therefore no authority to
  // contradict; the seat's own menu is the truth.
  assert.deepEqual(
    authoritativeRefusalFrontierToolNamesV1({
      graph: null,
      candidateToolNames: menu,
      excludeToolNames: ["read_file"],
    }),
    ["code_validate_fast", "code_commit_verified", "code_workspace_create"],
  );
});
