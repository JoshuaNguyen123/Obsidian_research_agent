import test from "node:test";
import assert from "node:assert/strict";
import {
  LINEAR_OPERATION_CATALOG,
  getLinearOperationDefinition,
  listLinearOperationDefinitions,
} from "../src/integrations/linear/operations";

test("the fixed catalog covers every capability gate without gate-zero writes", () => {
  const definitions = Object.values(LINEAR_OPERATION_CATALOG);
  assert.deepEqual(
    [...new Set(definitions.map((definition) => definition.gate))].sort(),
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(
    definitions.some(
      (definition) => definition.gate === 0 && definition.access === "write",
    ),
    false,
  );
  assert.equal(getLinearOperationDefinition("connection.context")?.gate, 0);
  assert.equal(
    getLinearOperationDefinition("connection.context")?.access,
    "read",
  );
});

test("operation documents are named fixed queries or mutations", () => {
  const definitions = Object.values(LINEAR_OPERATION_CATALOG);
  const names = definitions.map((definition) => definition.operationName);

  assert.equal(new Set(names).size, names.length);
  for (const definition of definitions) {
    assert.match(definition.operationName, /^Linear[A-Za-z0-9]+$/);
    assert.match(
      definition.document.trim(),
      definition.access === "read" ? /^query\s+Linear/ : /^mutation\s+Linear/,
    );
    assert.match(definition.document, new RegExp(`\\b${definition.rootField}\\b`));
    assert.doesNotMatch(definition.document, /\b(?:__schema|__type)\b/);
  }
});

test("catalog maps higher gates to the current Linear GraphQL names", () => {
  assert.equal(
    getLinearOperationDefinition("customer_requests.create")?.rootField,
    "customerNeedCreate",
  );
  assert.equal(
    getLinearOperationDefinition("customer_requests.list")?.rootField,
    "customerNeeds",
  );
  assert.equal(
    getLinearOperationDefinition("initiative_project_links.list")?.rootField,
    "initiativeToProjects",
  );
  assert.equal(
    getLinearOperationDefinition("initiative_project_links.get")?.rootField,
    "initiativeToProject",
  );
  assert.equal(
    getLinearOperationDefinition("projects.trash")?.rootField,
    "projectDelete",
  );
  assert.equal(
    getLinearOperationDefinition("projects.archive")?.rootField,
    "projectArchive",
  );
  assert.equal(
    getLinearOperationDefinition("project_updates.delete")?.rootField,
    "projectUpdateDelete",
  );
  assert.match(
    getLinearOperationDefinition("issues.delete_permanently")?.document ?? "",
    /issueDelete\(id: \$id, permanentlyDelete: true\)/,
  );
  assert.match(
    getLinearOperationDefinition("issues.trash")?.document ?? "",
    /issueDelete\(id: \$id, permanentlyDelete: false\)/,
  );
  assert.doesNotMatch(
    getLinearOperationDefinition("initiatives.get")?.document ?? "",
    /\b(?:identifier|priority|canceledAt)\b/,
  );
  assert.doesNotMatch(
    getLinearOperationDefinition("documents.get")?.document ?? "",
    /\bteam\s*\{/,
  );
  assert.equal(getLinearOperationDefinition("initiatives.add_label"), undefined);
  assert.equal(getLinearOperationDefinition("initiatives.remove_label"), undefined);
});

test("catalog filters enforce capability and access bounds", () => {
  const readsThroughGateOne = listLinearOperationDefinitions({
    maxGate: 1,
    access: "read",
  });

  assert.ok(readsThroughGateOne.length > 0);
  assert.ok(
    readsThroughGateOne.every(
      (definition) => definition.gate <= 1 && definition.access === "read",
    ),
  );
  assert.ok(
    readsThroughGateOne.some((definition) => definition.key === "issues.list"),
  );
  assert.equal(
    readsThroughGateOne.some(
      (definition) => definition.key === "projects.create",
    ),
    false,
  );
});

test("destructive and reversible metadata distinguishes mutation authority", () => {
  assert.deepEqual(
    pickAuthority("issues.trash"),
    { access: "write", destructive: true, reversible: true },
  );
  assert.deepEqual(
    pickAuthority("issues.delete_permanently"),
    { access: "write", destructive: true, reversible: false },
  );
  assert.deepEqual(
    pickAuthority("comments.delete"),
    { access: "write", destructive: true, reversible: false },
  );
  assert.deepEqual(
    pickAuthority("issues.create"),
    { access: "write", destructive: false, reversible: false },
  );
});

function pickAuthority(key: string) {
  const definition = getLinearOperationDefinition(key);
  assert.ok(definition, `Missing catalog operation ${key}`);
  return {
    access: definition.access,
    destructive: definition.destructive === true,
    reversible: definition.reversible === true,
  };
}

test("unknown or empty operation keys are not catalog entries", () => {
  const cases: Array<{ key: string; rule: string }> = [
    { key: "", rule: "an empty operation key cannot select a GraphQL document" },
    { key: "   ", rule: "whitespace is not a Linear operation id" },
    { key: "issues.unknown", rule: "unregistered operation keys must not resolve" },
    { key: "query { __schema }", rule: "raw GraphQL is not a catalog key" },
    { key: "../../etc/passwd", rule: "path-like keys must not resolve to an operation" },
  ];
  for (const { key, rule } of cases) {
    assert.equal(getLinearOperationDefinition(key), undefined, rule);
  }
});

test("catalog payloads encode id and selection contracts by operation kind", () => {
  const definitions = Object.values(LINEAR_OPERATION_CATALOG);
  const gets = definitions.filter((definition) => definition.key.endsWith(".get"));
  const lists = definitions.filter((definition) => definition.key.endsWith(".list"));
  const creates = definitions.filter((definition) => definition.key.endsWith(".create"));
  const updates = definitions.filter((definition) => definition.key.endsWith(".update"));
  const idMutations = definitions.filter(
    (definition) =>
      definition.access === "write" &&
      definition.resultKind === "mutation" &&
      JSON.stringify(definition.variables.required ?? []) === JSON.stringify(["id"]) &&
      JSON.stringify(definition.variables.allowed ?? []) === JSON.stringify(["id"]),
  );

  assert.ok(gets.length > 0, "the catalog must include get operations");
  for (const definition of gets) {
    assert.deepEqual(
      definition.variables.required,
      ["id"],
      `${definition.key} get operations require an id variable`,
    );
    assert.match(
      definition.document,
      /\$id:\s*String!/u,
      `${definition.key} get documents must declare a required id`,
    );
    assert.match(
      definition.document,
      /\bid\b/u,
      `${definition.key} resource selections must include id`,
    );
  }

  assert.ok(lists.length > 0, "the catalog must include list operations");
  for (const definition of lists) {
    assert.equal(
      definition.variables.paginated,
      true,
      `${definition.key} list operations are paginated`,
    );
    assert.match(
      definition.document,
      /pageInfo\s*\{[\s\S]*hasNextPage[\s\S]*endCursor/u,
      `${definition.key} list selections must include pageInfo`,
    );
    assert.ok(
      (definition.variables.allowed ?? []).includes("first"),
      `${definition.key} list operations allow a page size`,
    );
  }

  assert.ok(creates.length > 0, "the catalog must include create operations");
  for (const definition of creates) {
    assert.deepEqual(
      definition.variables.required,
      ["input"],
      `${definition.key} create operations require an input payload`,
    );
  }

  assert.ok(updates.length > 0, "the catalog must include update operations");
  for (const definition of updates) {
    assert.deepEqual(
      definition.variables.required,
      ["id", "input"],
      `${definition.key} update operations require both id and input`,
    );
  }

  assert.ok(idMutations.length > 0, "the catalog must include id mutations");
  for (const definition of idMutations) {
    assert.deepEqual(
      definition.variables.allowed,
      ["id"],
      `${definition.key} id mutations accept only an id`,
    );
  }
});
