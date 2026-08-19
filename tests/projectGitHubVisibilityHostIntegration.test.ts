import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
const sourceFile = ts.createSourceFile(
  "main.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

test("cleanup resolves GitHub publication by stage instead of a historical commit index", () => {
  const method = methodText("persistCleanupProjectLineage");
  assert.doesNotMatch(
    method,
    /lineage\.commits\s*\[\s*3\s*\]/u,
    "the Validation stage now occupies the historical GitHub index",
  );
  assert.match(
    method,
    /const publicationCommit = lineage\.commits\.find\([\s\S]*commit\.stage === "private_github_publication"/u,
  );
  assert.match(
    method,
    /parseGitHubPublicationLineageProofV2\(\s*publicationCommit\.proof/u,
  );
  assert.match(
    method,
    /publicationProof\.visibility !== "private"/u,
    "private repository cleanup must reject a public visibility proof",
  );
});

test("the host persists public publication as explicit visibility-bound lineage proof", () => {
  const method = methodText("persistPrivateGitHubProjectLineage");
  assert.match(
    method,
    /canonicalProof\.visibility === "private"[\s\S]*projectGitHubPublicationLineageProofV2ToV1\(canonicalProof\)[\s\S]*projectGitHubPublicationLineageProofV2ToCompatibleV1/u,
  );
  assert.doesNotMatch(
    method,
    /canonicalProof\.visibility === "public"\)\s*return/u,
    "public publication must no longer disappear before project progress and reflection",
  );
  assert.match(
    method,
    /JSON\.stringify\(existingCanonical\) !== JSON\.stringify\(canonicalProof\)/u,
    "idempotent replay must compare the complete visibility-bound proof",
  );

  const reflectionMethod = methodText("persistReflectionProjectLineage");
  assert.match(
    reflectionMethod,
    /latestStage !== "private_github_publication"/u,
    "both legacy-private and visibility-bound publication use the compatibility ordering label",
  );
  assert.doesNotMatch(reflectionMethod, /Public publication[\s\S]*return null/u);
});

function methodText(name: string): string {
  let match: ts.MethodDeclaration | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isMethodDeclaration(node) &&
      node.name !== undefined &&
      propertyName(node.name) === name
    ) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(match, `main.ts must define ${name}`);
  return (match as ts.MethodDeclaration).getText(sourceFile);
}

function propertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return name.getText(sourceFile);
}
