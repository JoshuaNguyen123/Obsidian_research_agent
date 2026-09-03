import test from "node:test";
import assert from "node:assert/strict";
import {
  ROUTING_BASELINE_ACCURACY,
  ROUTING_GOLDEN_CORPUS,
  observeProductionRouting,
  type RoutingGoldenCaseV1,
} from "./fixtures/routingGoldenCorpus";

test("golden routing corpus pins every case at its expected or recorded-current output", () => {
  for (const item of ROUTING_GOLDEN_CORPUS) {
    const observed = observeProductionRouting({
      prompt: item.prompt,
      extraTools: item.extraTools,
    });
    const wanted = resolveAssertedFields(item);
    if (wanted.speechAct !== undefined) {
      assert.equal(observed.speechAct, wanted.speechAct, label(item, "speechAct"));
    }
    if (wanted.executionTier !== undefined) {
      assert.equal(
        observed.executionTier,
        wanted.executionTier,
        label(item, "executionTier"),
      );
    }
    if (wanted.route !== undefined) {
      assert.equal(observed.route, wanted.route, label(item, "route"));
    }
    if (wanted.requiredCodeToolNames !== undefined) {
      assert.deepEqual(
        observed.requiredCodeToolNames,
        [...wanted.requiredCodeToolNames],
        label(item, "requiredCodeToolNames"),
      );
    }
    if (wanted.streamingWritebackKind !== undefined) {
      assert.equal(
        observed.streamingWritebackKind,
        wanted.streamingWritebackKind,
        label(item, "streamingWritebackKind"),
      );
    }
    if (wanted.directCurrentNoteWritebackKind !== undefined) {
      assert.equal(
        observed.directCurrentNoteWritebackKind,
        wanted.directCurrentNoteWritebackKind,
        label(item, "directCurrentNoteWritebackKind"),
      );
    }
    if (wanted.noteOutputDestination !== undefined) {
      assert.equal(
        observed.noteOutput.destination,
        wanted.noteOutputDestination,
        label(item, "noteOutputDestination"),
      );
    }
    if (wanted.noteOutputMutation !== undefined) {
      assert.equal(
        observed.noteOutput.mutation,
        wanted.noteOutputMutation,
        label(item, "noteOutputMutation"),
      );
    }
    if (wanted.noteOutputDelivery !== undefined) {
      assert.equal(
        observed.noteOutput.delivery,
        wanted.noteOutputDelivery,
        label(item, "noteOutputDelivery"),
      );
    }
    // reasonsInclude is asserted only for pass cases: it describes the
    // desired route derivation, which a known_miss case does not produce yet.
    if (item.status === "pass" && item.expected.reasonsInclude) {
      for (const reason of item.expected.reasonsInclude) {
        assert.ok(
          observed.traceReasons.includes(reason),
          `${label(item, "reasonsInclude")}: missing ${reason} in ${JSON.stringify(observed.traceReasons)}`,
        );
      }
    }
  }
});

test("routing accuracy never drops below the checked-in baseline ratchet", () => {
  const passCount = ROUTING_GOLDEN_CORPUS.filter(
    (item) => item.status === "pass",
  ).length;
  const accuracy = passCount / ROUTING_GOLDEN_CORPUS.length;
  assert.ok(
    accuracy >= ROUTING_BASELINE_ACCURACY,
    `corpus accuracy ${accuracy.toFixed(3)} fell below baseline ${ROUTING_BASELINE_ACCURACY.toFixed(3)}`,
  );
  // The recorded baseline must match reality so the ratchet is honest: when a
  // known_miss case is fixed, flip its status AND raise the constant.
  assert.equal(
    accuracy,
    ROUTING_BASELINE_ACCURACY,
    "ROUTING_BASELINE_ACCURACY is stale; update it to passCount/total after changing case statuses",
  );
});

test("every known_miss case records the differing current fields", () => {
  for (const item of ROUTING_GOLDEN_CORPUS) {
    if (item.status === "known_miss") {
      assert.ok(
        item.current && Object.keys(item.current).length > 0,
        `${item.id}: known_miss cases must pin their present-day output`,
      );
    } else {
      assert.equal(
        item.current,
        undefined,
        `${item.id}: pass cases must not carry a current override`,
      );
    }
  }
});

test("every corpus case pins route, writeback kind, and note-output destination", () => {
  for (const item of ROUTING_GOLDEN_CORPUS) {
    const wanted = resolveAssertedFields(item);
    assert.notEqual(
      wanted.route,
      undefined,
      `${item.id}: must pin route (expected or current)`,
    );
    assert.notEqual(
      wanted.streamingWritebackKind,
      undefined,
      `${item.id}: must pin streamingWritebackKind (expected or current)`,
    );
    assert.notEqual(
      wanted.directCurrentNoteWritebackKind,
      undefined,
      `${item.id}: must pin directCurrentNoteWritebackKind (expected or current)`,
    );
    assert.notEqual(
      wanted.noteOutputDestination,
      undefined,
      `${item.id}: must pin noteOutputDestination (expected or current)`,
    );
  }
});

/** pass → assert expected; known_miss → current overrides the differing fields. */
function resolveAssertedFields(item: RoutingGoldenCaseV1) {
  return item.status === "pass"
    ? item.expected
    : { ...item.expected, ...item.current };
}

function label(item: RoutingGoldenCaseV1, field: string): string {
  return `[${item.id}] ${field} (${item.status}) :: ${item.prompt}`;
}
