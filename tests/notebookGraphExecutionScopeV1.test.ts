import test from "node:test";
import assert from "node:assert/strict";
import {notebookGraphExecutionScopeV1,notebookExecutionPathV1} from "../src/agent/notebookGraphExecutionScopeV1";
import type {PreparedAction,ToolDescriptor} from "../src/agent/actions";
import type {MissionBindingGrantV1} from "../src/agent/missionGraphV3";
import {evaluateToolPolicy,deriveRoutedIntentFallback} from "../src/agent/policyEngine";
import {buildHostMissionGraphPlanV1} from "../src/agent/missionGraphHost";
import {DefaultToolRegistry} from "../src/tools/ToolRegistry";

function fixture():Parameters<typeof notebookGraphExecutionScopeV1>[0]{
 const toolName="run_notebook_cells",path="Research/analysis.ipynb",revision="sha256:"+"a".repeat(64);
 const descriptor:ToolDescriptor={version:1,name:toolName,capability:{system:"vault",resourceType:"notebook",action:"execute"},effect:"execution",risk:"medium",approval:{allowPromptGrant:false,allowPersistentGrant:false,fallback:"exact"},execution:{preparation:"required",cacheable:false,parallelSafe:false},durability:{journal:true,receipt:true,readback:"required",reconciliation:"none"},allowedPrincipals:["single_agent"],receiptKind:"artifact"};
 const action:PreparedAction={version:1,id:"action",runId:"run",toolCallId:"call",toolName,target:{system:"vault",resourceType:"notebook",id:path,path},relatedResources:[],normalizedArgs:{path,source_sha256:revision,indices:[0],restart:false},expectedTargetRevision:revision,payloadFingerprint:"sha256:"+"b".repeat(64),preview:{summary:"Run the selected cell.",destination:path,before:{},after:{},outboundBytes:0,warnings:[]},preparedAt:"2026-10-27T00:00:00Z",expiresAt:"2026-10-27T00:05:00Z"};
 const binding:MissionBindingGrantV1={id:"binding-notebook",kind:"notebook",destinationFingerprint:"sha256:"+"c".repeat(64),allowedEffects:["read","execution"]};
 return{prompt:`Run the selected cell in ${path}. Do not edit its cells.`,toolName,descriptor,action,binding,node:{executionHost:"obsidian_core",effect:"execution",status:"running",allowedTools:[toolName],destination:{bindingId:binding.id,effect:"execution",selector:path},resourceLocks:[{bindingId:binding.id,mode:"exclusive"}]}};
}

test("a named, source-bound notebook execution is eligible to ask for exact approval without general vault-write scope",()=>{assert.equal(notebookGraphExecutionScopeV1(fixture()),true);});
test("notebook execution scope refuses missing, dormant, broad or mismatched graph authority",()=>{
 for(const change of [(input:ReturnType<typeof fixture>)=>{input.node=null;},(input:ReturnType<typeof fixture>)=>{input.binding=null;},(input:ReturnType<typeof fixture>)=>{input.node!.status="ready";},(input:ReturnType<typeof fixture>)=>{input.node!.allowedTools.push("edit_notebook");},(input:ReturnType<typeof fixture>)=>{input.node!.resourceLocks=[];},(input:ReturnType<typeof fixture>)=>{input.binding!.allowedEffects=["read"];},(input:ReturnType<typeof fixture>)=>{input.binding!.allowedEffects.push("mutation");},(input:ReturnType<typeof fixture>)=>{input.node!.destination!.bindingId="other";},(input:ReturnType<typeof fixture>)=>{input.node!.destination!.selector="other.ipynb";}]){const input=fixture();change(input);assert.equal(notebookGraphExecutionScopeV1(input),false);}
});
test("notebook scope cannot grant prompt/persistent execution or substitute a different source or resource",()=>{
 for(const change of [(input:ReturnType<typeof fixture>)=>{input.descriptor.approval.allowPromptGrant=true;},(input:ReturnType<typeof fixture>)=>{input.descriptor.approval.allowPersistentGrant=true;},(input:ReturnType<typeof fixture>)=>{input.descriptor.capability.resourceType="markdown";},(input:ReturnType<typeof fixture>)=>{input.action.normalizedArgs.source_sha256="changed";},(input:ReturnType<typeof fixture>)=>{input.action.target.path="../analysis.ipynb";input.action.target.id="../analysis.ipynb";input.action.normalizedArgs.path="../analysis.ipynb";},(input:ReturnType<typeof fixture>)=>{input.action.expectedTargetRevision=null;}]){const input=fixture();change(input);assert.equal(notebookGraphExecutionScopeV1(input),false);}
});
test("questions, negated execution, unnamed files and path substrings do not establish notebook execution scope",()=>{
 for(const prompt of ["Explain how to run Research/analysis.ipynb.","Do not execute Research/analysis.ipynb.","Run Research/analysis.ipynb. Do not execute it.","Inspect Research/analysis.ipynb.","Run other.ipynb.","Run OtherResearch/analysis.ipynb."]){const input=fixture();input.prompt=prompt;assert.equal(notebookGraphExecutionScopeV1(input),false,prompt);}
});
test("eligible notebook scope still requires exact prepared approval under the existing policy",()=>{
 const input=fixture(),decision=evaluateToolPolicy({toolName:input.toolName,args:{},intent:deriveRoutedIntentFallback({writeAutonomy:false,writeToolExposed:false}),isDesktop:true,approvalGranted:false,writeAutonomy:false,codeRunCount:0,descriptor:input.descriptor,preparedAction:input.action,principal:"single_agent",scopeAllowed:notebookGraphExecutionScopeV1(input),now:new Date("2026-10-27T00:01:00Z")});assert.equal(decision.action,"require_approval");assert.equal(decision.payloadFingerprint,input.action.payloadFingerprint);
});
test("notebook execution resolves one explicit destination and refuses ambiguous notebook targets",()=>{
 assert.equal(notebookExecutionPathV1('Run analysis.ipynb. Use inspect_notebook to read Research/analysis.ipynb.'),'Research/analysis.ipynb');assert.equal(notebookExecutionPathV1('Run "Research/Notebook A.ipynb".'),'Research/Notebook A.ipynb');assert.equal(notebookExecutionPathV1('Run first.ipynb and second.ipynb.'),null);assert.equal(notebookExecutionPathV1('Run ../analysis.ipynb.'),null);
});
test("the real host graph binds notebook execution to its named path instead of a generic vault selector",async()=>{
 const input=fixture(),registry=new DefaultToolRegistry([{name:input.toolName,description:'Run the notebook.',parameters:{type:'object',properties:{}},descriptor:input.descriptor,execute:async()=>''}]);const plan=await buildHostMissionGraphPlanV1({missionId:'notebook-run',objective:input.prompt,toolRegistry:registry,allowedToolNames:[input.toolName],plannedToolNames:[input.toolName],currentNotePath:null,maxToolCalls:4,maxWallClockMs:30000});const node=Object.values(plan.deterministicProposal.nodes).find(node=>node.allowedTools.includes(input.toolName));assert.equal(node?.destination?.selector,input.action.target.path);assert.equal(node?.destination?.effect,'execution');
});


test("combined notebook editing and execution retain separate least-authority bindings",async()=>{
 const input=fixture(),editDescriptor:ToolDescriptor={...input.descriptor,name:"edit_notebook",capability:{system:"vault",resourceType:"notebook",action:"update"},effect:"mutation"};
 const registry=new DefaultToolRegistry([input.descriptor,editDescriptor].map(descriptor=>({name:descriptor.name,description:"Notebook action.",parameters:{type:"object",properties:{}},descriptor,execute:async()=>""})));
 const plan=await buildHostMissionGraphPlanV1({missionId:"notebook-repair-run",objective:"Edit Research/analysis.ipynb and run it.",toolRegistry:registry,allowedToolNames:["edit_notebook",input.toolName],plannedToolNames:["edit_notebook",input.toolName],currentNotePath:null,maxToolCalls:8,maxWallClockMs:30000});
 const graph=plan.deterministicProposal,execution=Object.values(graph.nodes).find(node=>node.allowedTools.includes(input.toolName))!,edit=Object.values(graph.nodes).find(node=>node.allowedTools.includes("edit_notebook"))!;
 assert.ok(execution&&edit);assert.notEqual(execution.destination?.bindingId,edit.destination?.bindingId);
 const binding=plan.capabilityEnvelope.bindings[execution.destination!.bindingId];assert.deepEqual([...binding.allowedEffects].sort(),["execution","read"]);
 assert.equal(notebookGraphExecutionScopeV1({...input,node:{...execution,status:"running"},binding}),true);
 assert.ok(!binding.allowedEffects.includes("mutation"));
});
