import type { JsonCanvas } from "../../src/design/jsonCanvas";

export interface RelevanceCriterionV1 {
  id: string;
  passed: boolean;
  detail: string;
}

export interface ArtifactRelevanceV1 {
  version: 1;
  artifact: "markdown" | "canvas" | "binding";
  passed: boolean;
  criteria: RelevanceCriterionV1[];
}

const TRANSFORMER_CONCEPTS = Object.freeze([
  ["tokens and embeddings", /\btoken(?:s|ization)?\b[\s\S]{0,120}\bembedding(?:s)?\b/iu],
  ["positional information", /\bposition(?:al)?\b[\s-]*(?:encoding|embedding|information)/iu],
  ["queries keys values", /\bquer(?:y|ies)\b[\s\S]{0,160}\bkeys?\b[\s\S]{0,160}\bvalues?\b/iu],
  ["self attention", /\bself[\s-]*attention\b|\bscaled dot[\s-]*product attention\b/iu],
  ["multi head attention", /\bmulti[\s-]*head(?:ed)?[\s-]*attention\b/iu],
  ["feed forward network", /\bfeed[\s-]*forward\b|\bffn\b/iu],
  ["residual and normalization", /\b(?:residual|skip) connection(?:s)?\b[\s\S]{0,180}\b(?:layer\s*)?norm(?:alization)?\b/iu],
  ["encoder decoder", /\bencoder\b[\s\S]{0,200}\bdecoder\b/iu],
  ["masking", /\b(?:causal|masked?) (?:self[\s-]*)?attention\b|\battention mask(?:ing)?\b/iu],
  ["parallelism and importance", /\bparallel(?:ism|izable|ization)?\b[\s\S]{0,240}\b(?:important|importance|impact|scale|scaling)\b/iu],
] as const);

const CANVAS_CONCEPTS = Object.freeze([
  /\binput|token/iu,
  /embedding/iu,
  /position/iu,
  /attention/iu,
  /encoder/iu,
  /decoder/iu,
  /feed[\s-]*forward|ffn/iu,
  /output|prediction|probabilit/iu,
]);

export function evaluateTransformerBriefMarkdown(
  markdown: string,
): ArtifactRelevanceV1 {
  const words = markdown.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/gu) ?? [];
  const headings = markdown.match(/^#{1,6}\s+\S.+$/gmu) ?? [];
  const conceptCount = TRANSFORMER_CONCEPTS.filter(([, pattern]) =>
    pattern.test(markdown)
  ).length;
  const criteria: RelevanceCriterionV1[] = [
    criterion(
      "brief_length",
      words.length >= 500 && words.length <= 2_200,
      `${words.length} words; expected 500-2200`,
    ),
    criterion(
      "structured_sections",
      headings.length >= 4,
      `${headings.length} Markdown headings; expected at least 4`,
    ),
    criterion(
      "transformer_concept_coverage",
      conceptCount >= 7,
      `${conceptCount}/${TRANSFORMER_CONCEPTS.length} required concept groups present; expected at least 7`,
    ),
    criterion(
      "importance_explained",
      /\b(?:importance|impact|significance|advantages?|breakthrough|transformative|transformed|foundational|foundation|consequential|decisive|took over|why\b[\s\S]{0,100}\b(?:matter|changed|important|powerful|useful))\b/iu.test(markdown) &&
        /\b(?:language models?|translation|vision|multimodal|parallel|scal(?:e|ing)|transfer learning)\b/iu.test(markdown),
      "importance claim and at least one concrete consequence must both be present",
    ),
    criterion(
      "no_unrelated_template_output",
      !/[\u3400-\u9fff]/u.test(markdown) &&
        !/\b(?:lorem ipsum|todo: fill|placeholder content|template goes here)\b/iu.test(markdown),
      "no unrelated CJK or placeholder/template output",
    ),
  ];
  return result("markdown", criteria);
}

export function evaluateTransformerCanvas(
  canvas: JsonCanvas,
): ArtifactRelevanceV1 {
  const visibleText = [
    ...canvas.nodes.flatMap((node) => [
      node.type === "text" ? node.text : "",
      node.type === "file" ? node.file : "",
      node.type === "link" ? node.url : "",
      node.type === "group" ? node.label ?? "" : "",
    ]),
    ...canvas.edges.map((edge) => edge.label ?? ""),
  ].join("\n");
  const conceptCount = CANVAS_CONCEPTS.filter((pattern) =>
    pattern.test(visibleText)
  ).length;
  const nodeIds = new Set(canvas.nodes.map((node) => node.id));
  const resolvedEdges = canvas.edges.filter(
    (edge) => nodeIds.has(edge.fromNode) && nodeIds.has(edge.toNode),
  ).length;
  const bounds = canvasBounds(canvas);
  const aspectRatio =
    Math.max(bounds.width, bounds.height) /
    Math.max(1, Math.min(bounds.width, bounds.height));
  return result("canvas", [
    criterion(
      "diagram_structure",
      canvas.nodes.length >= 6 && canvas.edges.length >= 5,
      `${canvas.nodes.length} nodes and ${canvas.edges.length} edges; expected at least 6 and 5`,
    ),
    criterion(
      "diagram_edges_resolve",
      resolvedEdges === canvas.edges.length,
      `${resolvedEdges}/${canvas.edges.length} edges resolve to existing nodes`,
    ),
    criterion(
      "diagram_semantic_coverage",
      conceptCount >= 5,
      `${conceptCount}/${CANVAS_CONCEPTS.length} transformer concept groups present`,
    ),
    criterion(
      "diagram_compact_layout",
      bounds.width <= 6_000 && bounds.height <= 6_000 && aspectRatio <= 4,
      `${bounds.width}x${bounds.height} bounds at ${aspectRatio.toFixed(2)}:1; expected each axis <=6000 and aspect <=4:1`,
    ),
  ]);
}

function canvasBounds(canvas: JsonCanvas): { width: number; height: number } {
  if (canvas.nodes.length === 0) {
    return { width: 0, height: 0 };
  }
  const left = Math.min(...canvas.nodes.map((node) => node.x));
  const top = Math.min(...canvas.nodes.map((node) => node.y));
  const right = Math.max(
    ...canvas.nodes.map((node) => node.x + node.width),
  );
  const bottom = Math.max(
    ...canvas.nodes.map((node) => node.y + node.height),
  );
  return { width: right - left, height: bottom - top };
}

export function evaluateBriefCanvasBinding(
  markdown: string,
  canvasPath: string,
): ArtifactRelevanceV1 {
  const normalized = canvasPath.replace(/\\/gu, "/");
  const basename = normalized.split("/").at(-1) ?? normalized;
  const escapedPath = escapeRegExp(normalized);
  const escapedBasename = escapeRegExp(basename);
  const linked =
    new RegExp(`\\[\\[(?:${escapedPath}|${escapedBasename})(?:\\|[^\\]]+)?\\]\\]`, "iu").test(markdown) ||
    new RegExp(`\\[[^\\]]+\\]\\((?:${escapedPath}|${escapedBasename})\\)`, "iu").test(markdown);
  return result("binding", [
    criterion(
      "brief_links_canvas",
      linked,
      linked
        ? `Markdown links the exact Canvas ${normalized}`
        : `Markdown does not link the exact Canvas ${normalized}`,
    ),
  ]);
}

function criterion(
  id: string,
  passed: boolean,
  detail: string,
): RelevanceCriterionV1 {
  return { id, passed, detail };
}

function result(
  artifact: ArtifactRelevanceV1["artifact"],
  criteria: RelevanceCriterionV1[],
): ArtifactRelevanceV1 {
  return {
    version: 1,
    artifact,
    passed: criteria.every((item) => item.passed),
    criteria,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
