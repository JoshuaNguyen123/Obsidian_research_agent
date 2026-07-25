import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_DIRECTIVE_TEXT_CHARS,
  MAX_PENDING_DIRECTIVES,
  NARROWING_DIRECTIVE_KINDS,
  applySteeringToStepPrompt,
  createRunSteeringQueue,
  drainSteeringDirectives,
  enqueueSteeringDirective,
  isNarrowingDirectiveKind,
  toolNamesDroppedBySteering,
  type RunSteeringQueueV1,
} from "../src/agent/runSteering";

const AT = "2026-07-23T12:00:00.000Z";

function enqueueOrThrow(
  queue: RunSteeringQueueV1,
  input: Parameters<typeof enqueueSteeringDirective>[1],
): RunSteeringQueueV1 {
  const result = enqueueSteeringDirective(queue, input);
  assert.equal(result.ok, true, `expected enqueue to succeed for ${input.kind}`);
  return (result as Extract<typeof result, { ok: true }>).queue;
}

test("every supported directive kind is narrowing", () => {
  for (const kind of NARROWING_DIRECTIVE_KINDS) {
    assert.equal(isNarrowingDirectiveKind(kind), true);
  }
});

test("a directive that would widen authority is rejected", () => {
  // These are the shapes an escalation attempt would take: reaching a tool the
  // user never approved, or re-opening a path the host narrowed.
  for (const kind of [
    "add_tool",
    "grant_authority",
    "widen_scope",
    "allow_tool",
    "escalate",
  ]) {
    const result = enqueueSteeringDirective(createRunSteeringQueue(), {
      kind,
      text: "use the github publication tool",
      enqueuedAt: AT,
    });

    assert.equal(result.ok, false, `${kind} must be rejected`);
    assert.equal(
      (result as Extract<typeof result, { ok: false }>).code,
      "would_widen_authority",
    );
  }
});

test("a rejected directive never reaches the prompt or the queue", () => {
  const queue = createRunSteeringQueue();
  const result = enqueueSteeringDirective(queue, {
    kind: "add_tool",
    text: "enable web_fetch",
    enqueuedAt: AT,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(queue.pending, []);
  assert.equal(applySteeringToStepPrompt(queue.pending), null);
});

test("narrowing directives are accepted and queued in order", () => {
  let queue = createRunSteeringQueue();
  queue = enqueueOrThrow(queue, {
    kind: "narrow_scope",
    text: "only the 2024 papers",
    enqueuedAt: AT,
  });
  queue = enqueueOrThrow(queue, {
    kind: "add_constraint",
    text: "cite every claim",
    enqueuedAt: AT,
  });

  assert.equal(queue.pending.length, 2);
  assert.equal(queue.pending[0]?.kind, "narrow_scope");
  assert.equal(queue.pending[1]?.kind, "add_constraint");
});

test("drop_tool requires the tool name it intends to remove", () => {
  const result = enqueueSteeringDirective(createRunSteeringQueue(), {
    kind: "drop_tool",
    text: "stop fetching the web",
    enqueuedAt: AT,
  });

  assert.equal(result.ok, false);
  assert.equal(
    (result as Extract<typeof result, { ok: false }>).code,
    "missing_tool_name",
  );
});

test("empty or whitespace-only directives are rejected", () => {
  for (const text of ["", "   ", "\n\t "]) {
    const result = enqueueSteeringDirective(createRunSteeringQueue(), {
      kind: "add_constraint",
      text,
      enqueuedAt: AT,
    });
    assert.equal(result.ok, false);
    assert.equal(
      (result as Extract<typeof result, { ok: false }>).code,
      "empty_directive",
    );
  }
});

test("directive text is capped so steering cannot become an injection channel", () => {
  const queue = enqueueOrThrow(createRunSteeringQueue(), {
    kind: "add_constraint",
    text: "x".repeat(MAX_DIRECTIVE_TEXT_CHARS * 3),
    enqueuedAt: AT,
  });

  assert.equal(queue.pending[0]?.text.length, MAX_DIRECTIVE_TEXT_CHARS);
});

test("the pending queue is bounded", () => {
  let queue = createRunSteeringQueue();
  for (let index = 0; index < MAX_PENDING_DIRECTIVES; index += 1) {
    queue = enqueueOrThrow(queue, {
      kind: "add_constraint",
      text: `constraint ${index}`,
      enqueuedAt: AT,
    });
  }

  const overflow = enqueueSteeringDirective(queue, {
    kind: "add_constraint",
    text: "one too many",
    enqueuedAt: AT,
  });

  assert.equal(overflow.ok, false);
  assert.equal(
    (overflow as Extract<typeof overflow, { ok: false }>).code,
    "queue_full",
  );
});

test("draining moves pending directives to applied exactly once", () => {
  let queue = enqueueOrThrow(createRunSteeringQueue(), {
    kind: "narrow_scope",
    text: "only the 2024 papers",
    enqueuedAt: AT,
  });

  const first = drainSteeringDirectives(queue);
  assert.equal(first.drained.length, 1);
  assert.deepEqual(first.queue.pending, []);
  assert.equal(first.queue.applied.length, 1);

  // A second step boundary with nothing new must not re-apply the directive.
  const second = drainSteeringDirectives(first.queue);
  assert.deepEqual(second.drained, []);
  assert.equal(second.queue.applied.length, 1);
});

test("an empty drain returns the identical queue reference", () => {
  const queue = createRunSteeringQueue();
  const drained = drainSteeringDirectives(queue);

  assert.equal(drained.queue, queue);
  assert.deepEqual(drained.drained, []);
});

test("the projected prompt states each directive and restates the narrowing invariant", () => {
  let queue = createRunSteeringQueue();
  queue = enqueueOrThrow(queue, {
    kind: "narrow_scope",
    text: "only the 2024 papers",
    enqueuedAt: AT,
  });
  queue = enqueueOrThrow(queue, {
    kind: "drop_tool",
    text: "the fetches keep timing out",
    toolName: "web_fetch",
    enqueuedAt: AT,
  });
  queue = enqueueOrThrow(queue, {
    kind: "prioritize_target",
    text: "the methodology section",
    enqueuedAt: AT,
  });

  const prompt = applySteeringToStepPrompt(drainSteeringDirectives(queue).drained);
  assert.ok(prompt);
  assert.match(prompt, /Narrow scope to: only the 2024 papers/);
  assert.match(prompt, /Do not use web_fetch/);
  assert.match(prompt, /Prioritize: the methodology section/);
  assert.match(prompt, /never grant new tools or authority/);
});

test("nothing drained projects no message", () => {
  assert.equal(applySteeringToStepPrompt([]), null);
});

test("dropped tool names are deduplicated for subtraction from the step tool set", () => {
  let queue = createRunSteeringQueue();
  for (const toolName of ["web_fetch", "web_fetch", "web_search"]) {
    queue = enqueueOrThrow(queue, {
      kind: "drop_tool",
      text: "too slow",
      toolName,
      enqueuedAt: AT,
    });
  }
  queue = enqueueOrThrow(queue, {
    kind: "add_constraint",
    text: "stay in the vault",
    enqueuedAt: AT,
  });

  assert.deepEqual(
    toolNamesDroppedBySteering(drainSteeringDirectives(queue).drained).sort(),
    ["web_fetch", "web_search"],
  );
});

test("only drop_tool contributes tool subtractions", () => {
  const queue = enqueueOrThrow(createRunSteeringQueue(), {
    kind: "narrow_scope",
    text: "read_file",
    enqueuedAt: AT,
  });

  assert.deepEqual(
    toolNamesDroppedBySteering(drainSteeringDirectives(queue).drained),
    [],
  );
});
