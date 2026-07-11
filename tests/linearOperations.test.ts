import test from "node:test";
import assert from "node:assert/strict";
import {
  LINEAR_OPERATION_CATALOG,
  getLinearOperationDefinition,
  listLinearOperationDefinitions,
} from "../src/integrations/linear";

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
