import test from "node:test";
import assert from "node:assert/strict";
import {serializeToolResultForModel} from "../src/model/toolResultPayload";
import {createToolResultStoreV1} from "../src/agent/toolResultStore";
import {recallToolResultTool} from "../src/tools/recallTools";
import {readFileTool,readMarkdownFilesTool} from "../src/tools/vaultTools";
import type {ToolExecutionContext} from "../src/tools/types";
const payload=(toolName:string,output:unknown)=>JSON.parse(serializeToolResultForModel({toolName,ok:true,output}));
for(const status of ["supported","unsupported","unverifiable"]){
  test("citation model payload preserves "+status+" verdict without claiming semantic assessment",()=>{
    const output={status,verificationScope:"quote-occurrence",semanticAssessed:false,assessmentCoverage:status==="unverifiable"?"partial":"complete",scannedSections:2,sectionCount:4,message:"Exact version unavailable or quote absent; this is not a semantic verdict.",internalSecret:"must-not-cross"};
    const actual=payload("verify_citation",output);
    assert.equal(actual.status,"success");assert.equal(actual.output.status,status);
    assert.equal(actual.output.verificationScope,"quote-occurrence");assert.equal(actual.output.semanticAssessed,false);
    assert.equal(actual.output.assessmentCoverage,output.assessmentCoverage);
    assert.equal(actual.output.scannedSections,2);assert.equal(actual.output.sectionCount,4);
    assert.equal(actual.output.message,output.message);assert.doesNotMatch(JSON.stringify(actual),/must-not-cross/);
  });
}
for(const status of ["unknown","evicted","unavailable"]){
  test("recall model payload preserves "+status+" and explicit null evidence",()=>{
    const actual=payload("recall_tool_result",{operation:"recall_tool_result",status,key:"tr_fixture_99",content:null,totalChars:null,truncated:false,matchLines:[],message:"No evidence is available for this key."});
    assert.equal(actual.status,"success");assert.equal(actual.output.status,status);
    assert.equal(actual.output.content,null);assert.equal(actual.output.key,"tr_fixture_99");
    assert.equal(actual.output.message,"No evidence is available for this key.");
  });
}
test("actual store recall preserves the exact matching line through the model serializer",async()=>{
  const store=createToolResultStoreV1("context-fixture");
  const quote="The observational cohort does not establish that treatment caused the outcome.";
  const key=store.stash({toolName:"web_fetch",step:3,content:"Background\n"+quote+"\nAppendix"});
  const output=await recallToolResultTool.execute({key,query:"observational"},{toolResultStore:store} as ToolExecutionContext);
  const actual=payload("recall_tool_result",output);
  assert.equal(actual.output.status,"found");assert.equal(actual.output.content,"2: "+quote);
  assert.deepEqual(actual.output.matchLines,[2]);assert.equal(actual.output.toolName,"web_fetch");
  assert.equal(actual.trust,"untrusted_external_content");assert.ok(actual.guard);
});
test("pathological recalled text remains bounded and cannot erase found verdict",()=>{
  const actual=payload("recall_tool_result",{status:"found",key:"tr_fixture_1",content:"\u0000".repeat(9000),totalChars:9000,truncated:false,matchLines:Array.from({length:100},(_,i)=>i+1),message:"Bounded recalled source data."});
  assert.ok(JSON.stringify(actual).length<=8000);assert.equal(actual.output.status,"found");
  assert.equal(actual.output.key,"tr_fixture_1");assert.equal(actual.output.truncated,true);
});
function contextFor(content:string,prompt:string):ToolExecutionContext{
  const file={path:"Inputs/Large.md",extension:"md",basename:"Large"};
  return {originalPrompt:prompt,app:{vault:{getFileByPath:(path:string)=>path===file.path?file:null,cachedRead:async()=>content}}} as unknown as ToolExecutionContext;
}
const quote="The intervention was associated with improved outcomes in this observational cohort, which does not establish a causal effect.";
const content="Neutral auxiliary detail. ".repeat(380)+"\n\n"+quote+"\n\n"+"Unrelated appendix material. ".repeat(1400);
test("actual local read targets mission-relevant evidence outside head middle and tail",async()=>{
  const output=await readFileTool.execute({path:"Inputs/Large.md"},contextFor(content,"Does the observational intervention establish a causal effect?"));
  const actual=payload("read_file",output);
  assert.ok(actual.output.contentEvidence.passages.some((p:any)=>p.text.includes(quote)));
  assert.ok(actual.output.contentEvidence.includedChars<=2100);
  for(const passage of actual.output.contentEvidence.passages)assert.equal(passage.text,content.slice(passage.startChar,passage.endChar));
});
test("explicit quote focus overrides mission topic for a batch read without changing source bytes",async()=>{
  const batchContent="Neutral material. ".repeat(100)+"\n\n"+quote+"\n\n"+"Appendix details. ".repeat(100);
  const output=await readMarkdownFilesTool.execute({paths:["Inputs/Large.md"],maxCharsPerFile:6000,query:"observational intervention causal"},contextFor(batchContent,"Unrelated mission phrasing"));
  const actual=payload("read_markdown_files",output);
  assert.ok(actual.output.files[0].contentEvidence.passages.some((p:any)=>p.text.includes("observational cohort")));
  assert.ok(actual.output.files[0].contentEvidence.includedChars<=600);
});
test("passage focus cannot broaden a read outside the authorized vault-relative path",async()=>{
  await assert.rejects(readFileTool.execute({path:"../outside.md",query:"observational"},contextFor(content,"mission")));
});
