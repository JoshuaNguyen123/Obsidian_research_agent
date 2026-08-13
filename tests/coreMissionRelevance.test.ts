import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateBriefCanvasBinding,
  evaluateTransformerBriefMarkdown,
  evaluateTransformerCanvas,
} from "../e2e/fixtures/coreMissionRelevance";
import type { JsonCanvas } from "../src/design/jsonCanvas";

const section = (title: string, body: string) =>
  `## ${title}\n\n${`${body} `.repeat(12)}\n\n`;

test("transformer relevance accepts a substantial, structured brief and connected canvas", () => {
  const markdown = [
    "# Transformer Architecture",
    "",
    section(
      "Tokens and embeddings",
      "Tokenization maps tokens to embeddings and positional encoding adds order information.",
    ),
    section(
      "Self-attention",
      "Self-attention builds queries, keys, and values for scaled dot-product attention and multi-head attention.",
    ),
    section(
      "Transformer blocks",
      "Each feed-forward network or FFN follows attention with a residual connection and layer normalization.",
    ),
    section(
      "Encoder and decoder",
      "The encoder forms contextual representations while the decoder uses causal masked attention to predict output tokens.",
    ),
    section(
      "Why it matters",
      "This architecture transformed sequence modeling because parallelism supports scaling, transfer learning, language models, translation, vision, and multimodal applications.",
    ),
    "See [[Designs/Transformer Architecture.canvas|architecture diagram]].",
  ].join("\n");
  const canvas = transformerCanvas();

  assert.equal(evaluateTransformerBriefMarkdown(markdown).passed, true);
  assert.equal(evaluateTransformerCanvas(canvas).passed, true);
  assert.equal(
    evaluateBriefCanvasBinding(
      markdown,
      "Designs/Transformer Architecture.canvas",
    ).passed,
    true,
  );
});

test("transformer relevance rejects fluent but irrelevant or structurally empty artifacts", () => {
  const markdown = [
    "# Quarterly Sales",
    "",
    "## Overview",
    "A short unrelated report about revenue. Lorem ipsum.",
  ].join("\n");
  const canvas: JsonCanvas = { nodes: [], edges: [] };

  assert.equal(evaluateTransformerBriefMarkdown(markdown).passed, false);
  assert.equal(evaluateTransformerCanvas(canvas).passed, false);
  assert.equal(
    evaluateBriefCanvasBinding(
      markdown,
      "Designs/Transformer Architecture.canvas",
    ).passed,
    false,
  );
});

test("transformer relevance accepts natural importance language without requiring one exact phrase", () => {
  const markdown = [
    "# Transformer Architecture",
    section(
      "Tokens and embeddings",
      "Tokenization maps tokens to embeddings and positional encoding adds order information.",
    ),
    section(
      "Attention internals",
      "Self-attention builds queries, keys, and values for scaled dot-product attention and multi-head attention.",
    ),
    section(
      "Blocks and stacks",
      "A feed-forward network follows attention; each residual connection and layer normalization stabilizes the encoder and decoder.",
    ),
    section(
      "Generation",
      "Causal masked attention predicts output tokens in the decoder.",
    ),
    section(
      "What made it a breakthrough",
      "The architecture transformed sequence modeling by enabling parallel training and scaling modern language models.",
    ),
  ].join("\n");

  assert.equal(evaluateTransformerBriefMarkdown(markdown).passed, true);
});

test("transformer relevance rejects a long structured brief on the wrong subject", () => {
  const unrelatedSection = (title: string) =>
    `## ${title}\n\n${"Revenue, customers, pipeline, margin, and quarterly planning require careful review. ".repeat(20)}\n`;
  const markdown = [
    "# Quarterly Business Review",
    unrelatedSection("Revenue"),
    unrelatedSection("Pipeline"),
    unrelatedSection("Customer retention"),
    unrelatedSection("Operating plan"),
  ].join("\n");

  assert.equal(evaluateTransformerBriefMarkdown(markdown).passed, false);
});

function transformerCanvas(): JsonCanvas {
  const labels = [
    "Input tokens",
    "Token embeddings and positional encoding",
    "Multi-head self-attention",
    "Feed-forward network",
    "Encoder stack",
    "Masked decoder",
    "Output probabilities",
  ];
  return {
    nodes: labels.map((text, index) => ({
      id: `node-${index}`,
      type: "text" as const,
      x: (index % 3) * 320,
      y: Math.floor(index / 3) * 220,
      width: 280,
      height: 160,
      text,
    })),
    edges: labels.slice(1).map((_, index) => ({
      id: `edge-${index}`,
      fromNode: `node-${index}`,
      toNode: `node-${index + 1}`,
    })),
  };
}
