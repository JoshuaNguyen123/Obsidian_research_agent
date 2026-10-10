import test from 'node:test';
import assert from 'node:assert/strict';
import * as frontier from '../src/agent/missionGraphFrontier';
import {authoritativeRefusalFrontierToolNamesV1} from '../src/agent/missionGraphSelectors';
const graph = {nodes:{
  source:{id:'source',status:'complete',allowedTools:['read_file'],inputs:{},outputs:{},
    evidence:[{id:'source-read-proof',kind:'tool-result',fingerprint:'sha256:'+'a'.repeat(64),observedAt:'2026-10-10T00:00:00.000Z'}]},
  final:{id:'final',status:'ready',allowedTools:[],inputs:{},outputs:{},dependencyIds:['source'],completionContract:{requiredEvidenceKinds:['final-output']}},
},capabilityEnvelope:{tools:{}}} as never;
const available=['read_file','read_markdown_files','read_current_file','read_source_section','verify_citation','recall_tool_result','web_search','web_fetch','append_to_current_file','delete_file'];
const expected=available.slice(0,6);
const gather=(input:Record<string,unknown>={})=>{
  const candidate=frontier as typeof frontier & {sealedLocalCitationGatherToolNamesV1?:(input:never)=>string[]};
  return candidate.sealedLocalCitationGatherToolNamesV1?.({graph,explicitNoWeb:true,unpaidAcceptanceMissing:['verifier:claim_grounding:quote_mismatch'],availableToolNames:available,...input} as never)??[];
};
const tool=(name:string)=>({type:'function' as const,function:{name,parameters:{type:'object' as const,properties:{}}}});
test('local-only unpaid quote debt retains available local evidence reads',()=>assert.deepEqual(gather(),expected));
test('gather never restores unavailable reads, network tools or mutation tools',()=>{
  assert.deepEqual(gather({availableToolNames:['web_fetch','delete_file','read_file']}),['read_file']);
  assert.deepEqual(gather({availableToolNames:['web_fetch','delete_file']}),[]);
});
test('sealed local offer and execution refusal use the identical read allowlist',()=>{
  const names=gather();
  const offered=frontier.constrainToolsToMissionGraphFrontier(available.map(tool),graph,{
    keepCitationGatherOnSealedFrontier:names.length>0,citationGatherToolNames:names,
  } as never).map(item=>item.function.name);
  assert.deepEqual(offered,expected);
  assert.deepEqual(authoritativeRefusalFrontierToolNamesV1({graph,candidateToolNames:offered,allowDynamicReadContinuation:false,admittedCompanionToolNames:names}),expected);
});
test('finalization reserve and fetch-only constraints keep their original cap',()=>{
  assert.deepEqual(gather({inFinalizationReserve:true}),[]);
  assert.deepEqual(gather({explicitSingleWebFetchOnly:true}),[]);
});
test('paid claims, unpaid write receipts and absent proof cannot reopen tools',()=>{
  assert.deepEqual(gather({unpaidAcceptanceMissing:[]}),[]);
  assert.deepEqual(gather({unpaidAcceptanceMissing:['write_receipt']}),[]);
  assert.deepEqual(gather({graph:null}),[]);
});
test('local selector does not change existing web research policy',()=>{
  assert.deepEqual(gather({explicitNoWeb:false}),[]);
  assert.equal(frontier.sealedFrontierShouldKeepCitationGatherV1({graph,unpaidAcceptanceMissing:['claim_grounding']}),true);
});
test('queued final stays sealed until its existing forced-final proof guard applies',()=>{
  const queued={...(graph as object),nodes:{source:(graph as any).nodes.source,final:{...(graph as any).nodes.final,status:'queued'}}};
  assert.deepEqual(gather({graph:queued}),[]);
  assert.deepEqual(gather({graph:queued,sealForForcedFinal:true}),expected);
});

test('custom gather names cannot reopen mutation or execution tools',()=>{
  const catalog=['read_file','delete_file','append_to_current_file','execute_code'].map(tool);
  const gathered=frontier.injectCitationGroundingGatherToolsV1([],catalog,['read_file','delete_file','append_to_current_file','execute_code']);
  assert.deepEqual(gathered.map(tool=>tool.function.name),['read_file']);
});
