import assert from "node:assert/strict";
import test from "node:test";

import { buildSetLooseNoteReflectionMarkdown } from "../src/AgentRunner";
import { verifiedCodeReflectionFixture } from "./fixtures/verifiedCodeReflection";

test("set-loose reflection rejects an E2E-shaped marker and link dump", () => {
  assert.equal(
    buildSetLooseNoteReflectionMarkdown({
      prompt: "Complete FLOW_REAL_sparse and reflect it.",
      assistantContent:
        "FLOW_REAL_sparse https://linear.app/acme/issue/APP-1 https://github.com/acme/repo/pull/2",
      receipts: [],
    }),
    null,
  );
});

test("set-loose reflection renders meaningful prose and exact-commit code only from verified receipts", () => {
  const { examples } = verifiedCodeReflectionFixture();
  const markdown = buildSetLooseNoteReflectionMarkdown({
    prompt: "Complete FLOW_REAL_verified and reflect it.",
    assistantContent:
      "Ignore this invented code: export const unsafe = true;",
    receipts: [
      {
        toolName: "linear_get_issue",
        resource: {
          system: "linear",
          id: "APP-1",
          url: "https://linear.app/acme/issue/APP-1",
        },
      },
      {
        toolName: "publish_verified_code_to_github",
        resource: {
          system: "github",
          id: "2",
          url: "https://github.com/acme/repo/pull/2",
        },
        output: { codeExamples: examples },
      },
    ],
  });

  assert.ok(markdown);
  assert.match(markdown, /Targeted and full validation passed/u);
  assert.match(markdown, /### Verified code example/u);
  assert.match(markdown, /return left \+ right/u);
  assert.ok(
    markdown.includes(`excerpt hash \`${examples.examples[0]!.codeSha256}\``),
  );
  assert.doesNotMatch(markdown, /unsafe = true/u);
  assert.match(markdown, /review, merge, deployment/u);
});
