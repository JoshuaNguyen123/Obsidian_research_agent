import assert from "node:assert/strict";
import test from "node:test";
import { classifyMissionIntent, getExplicitCodeToolNames, getRequiredCodeWorkflowToolNames } from "../src/AgentRunner";
import { isAllowedForMission } from "../src/agent/toolOfferGates";
import { hasCodeDeliverableIntent } from "../src/agent/codeDeliverableIntent";
import { toolsAllowedForLifecycleStage } from "../src/agent/lifecycleStagePolicy";
import { toolsAllowedForEnvelopeStage } from "../src/agent/missionStageEnvelope";
import { constrainToolsToMissionGraphFrontier, mayBypassMissionGraphStartForSetLooseSoftCompanion } from "../src/agent/missionGraphFrontier";
import { bindVerifiedWorkspaceIdentityToolCall, bindVerifiedWorkspaceIdentityToolSchemas } from "../src/agent/verifiedWorkspaceBinding";
import { SET_LOOSE_WORKSPACE_STALL_TOOL_NAMES } from "../src/agent/setLooseCompoundAutonomy";
import { ROUTE_BASE_TOOLS } from "../src/agent/toolSchemaPolicy";
import type { AgentRunReceipt } from "../src/AgentRunner";
import type { ModelToolDefinition } from "../src/model/types";

const name = "code_workspace_inspect";
const tool = (value: string): ModelToolDefinition => ({type:"function", function:{name:value, parameters:{type:"object", properties:{workspaceId:{type:"string"}}}}});
test("a named inspection enters the code workflow without selecting a write or validation", () => {
  const prompt = "Use code_workspace_inspect to inspect symbols in source.ts in workspace fixture.";
  assert.deepEqual(getExplicitCodeToolNames(prompt), [name]);
  const planned = getRequiredCodeWorkflowToolNames(prompt);
  assert.ok(planned.includes(name));
  const intent = classifyMissionIntent(prompt);
  assert.equal(intent.explicitMutation, false);
  assert.equal(isAllowedForMission(name, prompt, intent), true);
  assert.equal(isAllowedForMission("code_workspace_patch", prompt, intent), false);
  for (const forbidden of ["code_workspace_patch", "code_workspace_write_expected", "code_validate_full", "code_commit_verified"]) assert.ok(!planned.includes(forbidden), forbidden);
});
test("source filenames in observation requests do not authorize authoring, while mixed requests still do", () => {
  for (const prompt of ["Inspect source.ts", "Read source.py", "Review main.js", "Use code_workspace_read to read source.ts", "Explain source.ts", "Inspect write.ts", "Read scripts/build.py"]) {
    assert.equal(hasCodeDeliverableIntent(prompt), false, prompt);
  }
  for (const prompt of ["Create source.ts", "Read source.ts and fix the bug", "Inspect source.ts; write main.ts", "Use code_workspace_inspect on source.ts and patch source.ts", "Read main.py and run tests"]) {
    assert.equal(hasCodeDeliverableIntent(prompt), true, prompt);
  }
});
test("inspection stays absent from unrelated note work and grants no workspace writes", () => {
  const read = "Inspect the repo";
  assert.equal(isAllowedForMission(name, read, classifyMissionIntent(read)), true);
  assert.equal(isAllowedForMission("code_workspace_patch", read, classifyMissionIntent(read)), false);
  const unrelated = "Write a note about photosynthesis.";
  assert.equal(isAllowedForMission(name, unrelated, classifyMissionIntent(unrelated)), false);
});
test("inspection shares the code implementation route and envelope without granting validation mutations", () => {
  assert.ok(ROUTE_BASE_TOOLS.code.includes(name));
  assert.ok(toolsAllowedForLifecycleStage("code_execution").includes(name));
  assert.ok(toolsAllowedForEnvelopeStage("code_execution").includes(name));
  assert.ok(!toolsAllowedForLifecycleStage("code_execution").includes("code_commit_verified"));
  assert.ok(SET_LOOSE_WORKSPACE_STALL_TOOL_NAMES.has(name), "inspection must not evade the delivery stall limit");
});
test("an exact write frontier admits inspection only while offered, with unrelated soft tools still refused", () => {
  const menu = [name, "code_workspace_write_expected", "web_search", "github_get_repository"];
  const graph = {nodes:{write:{id:"write",status:"ready",allowedTools:["code_workspace_write_expected"],inputs:{},outputs:{}}}, capabilityEnvelope:{tools:{}}} as any;
  const offered = constrainToolsToMissionGraphFrontier(menu.map(tool), graph, {setLooseOfferedToolNames:menu, allowDynamicReadContinuation:false}).map(t => t.function.name);
  assert.ok(offered.includes(name));
  assert.ok(offered.includes("code_workspace_write_expected"));
  assert.ok(!offered.includes("web_search"));
  assert.ok(!offered.includes("github_get_repository"));
  assert.equal(mayBypassMissionGraphStartForSetLooseSoftCompanion(name, offered, graph), true);
  assert.equal(mayBypassMissionGraphStartForSetLooseSoftCompanion(name, [], graph), false);
});
const receiptFor = (workspaceId:string): AgentRunReceipt => ({toolName:"code_workspace_create",operation:"create",message:"Created workspace.",commitKind:"committed",readback:{status:"verified",checkedAt:"2026-10-13T00:00:00.000Z"},resource:{system:"workspace",resourceType:"code_workspace",id:workspaceId+":"+workspaceId,path:workspaceId,workspaceId}});
test("inspection schema and execution use the verified workspace, never a model alias", () => {
  const receipts = [receiptFor("verified-workspace")];
  const definition = tool(name);
  const projected = bindVerifiedWorkspaceIdentityToolSchemas([definition], receipts);
  assert.deepEqual(projected[0].function.parameters.properties?.workspaceId.enum, ["verified-workspace"]);
  assert.equal(definition.function.parameters.properties?.workspaceId.enum, undefined);
  const call = {name, arguments:{workspaceId:"wrong-workspace",path:"source.ts",operation:"symbols"}};
  assert.deepEqual(bindVerifiedWorkspaceIdentityToolCall(call, receipts)?.arguments, {...call.arguments,workspaceId:"verified-workspace"});
  assert.equal(bindVerifiedWorkspaceIdentityToolCall(call, []), null);
  assert.equal(bindVerifiedWorkspaceIdentityToolCall(call, [...receipts, receiptFor("other-workspace")]), null);
});
