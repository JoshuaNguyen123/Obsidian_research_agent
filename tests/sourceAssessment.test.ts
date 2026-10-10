import test from "node:test";
import assert from "node:assert/strict";
import * as payload from "../src/model/toolResultPayload";
const assess = (result: any) => {
  const fn = (payload as any).sourceReadResultNeedsAssessmentV1;
  assert.equal(typeof fn, "function", "clipped source assessment predicate must exist");
  return fn(result);
};
test("clipped single-source read needs a model assessment opportunity",()=>assert.equal(assess({ok:true,toolName:"read_file",output:{path:"Input.md",content:"Ordinary filler paragraph. ".repeat(1000)}}),true));
test("complete short source does not add an assessment turn",()=>assert.equal(assess({ok:true,toolName:"read_file",output:{path:"Input.md",content:"The table counts are 44 and 3."}}),false));
test("one clipped batch source needs assessment",()=>assert.equal(assess({ok:true,toolName:"read_markdown_files",output:{files:[{path:"Input.md",content:"Ordinary filler paragraph. ".repeat(1000)}]}}),true));
test("source read error cannot create an assessment proof",()=>assert.equal(assess({ok:false,toolName:"read_file",error:{code:"source_unusable",message:"No file"}}),false));
test("active editor body and mutation results retain their original behavior",()=>{
 for(const toolName of ["read_current_file","append_to_current_file","web_fetch"]){assert.equal(assess({ok:true,toolName,output:{content:"Ordinary filler paragraph. ".repeat(1000)}}),false);}
});
