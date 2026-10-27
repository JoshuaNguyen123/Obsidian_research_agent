import {createHash} from "node:crypto";
import type {RepositoryProfileV2,RepositoryValidationCommandV2} from "../repositories/RepositoryProfileV2";
import type {SandboxStagedFileBytesV2,SandboxStagingEntryV2,PreparedSandboxActionV2} from "./SandboxManager";
import {codeSandboxRunPolicyV1,type CodeSandboxRunCommandV1} from "./SandboxCommandPolicyV1";

/** Host-only input, never a persisted setting or model argument. Archives/setup are already approved by the host. */
export interface HostSandboxDependenciesV1 {
 fingerprint:string;node:string;python:string;files:readonly SandboxStagedFileBytesV2[];
}
const PREFIX="__rap_dependencies__/";
const sha=(bytes:Uint8Array)=>`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export function sandboxDependencyFilesV1(input:HostSandboxDependenciesV1|null|undefined):Map<string,SandboxStagedFileBytesV2>{
 const files=new Map<string,SandboxStagedFileBytesV2>();if(!input)return files;
 if(!/^sha256:[a-f0-9]{64}$/u.test(input.fingerprint)||!Array.isArray(input.files)||input.files.length>1000)throw new Error("The host dependency prelude is invalid.");let total=0;
 for(const file of input.files){
  if(typeof file.path!=="string"||!file.path.startsWith(PREFIX)||file.path.length>1000||/[\\\u0000-\u001f:]/u.test(file.path)||file.path.split('/').some(part=>!part||part==='.'||part==='..'||part.toLowerCase()==='.git')||files.has(file.path)||!(file.bytes instanceof Uint8Array)||file.bytes.byteLength>2000000)throw new Error("The host dependency prelude leaves its reserved staging boundary.");
  total+=file.bytes.byteLength;if(total>10000000)throw new Error("The host dependency prelude exceeds staging limits.");files.set(file.path,{path:file.path,bytes:new Uint8Array(file.bytes)});
 }
 if(!files.has(input.node)||!files.has(input.python))throw new Error("The host dependency prelude lacks its pinned launchers.");return files;
}
export function sandboxDependencyStagingV1(source:readonly SandboxStagingEntryV2[],dependencies:HostSandboxDependenciesV1|null|undefined):SandboxStagingEntryV2[]{
 if(!dependencies)return [...source];const files=sandboxDependencyFilesV1(dependencies);
 if(source.some(file=>file.path==='__rap_dependencies__'||file.path.startsWith(PREFIX)))throw new Error("Source collides with the reserved verification dependency folder.");
 const staged=[...source,...[...files.values()].map(file=>({path:file.path,sha256:sha(file.bytes),bytes:file.bytes.byteLength}))];
 if(staged.length>1000||staged.some(file=>file.bytes>2000000)||staged.reduce((total,file)=>total+file.bytes,0)>10000000)throw new Error("Source and approved dependencies exceed existing sandbox staging limits.");return staged;
}
export function sandboxDependencyCommandV1(command:RepositoryValidationCommandV2,dependencies:HostSandboxDependenciesV1|null|undefined):RepositoryValidationCommandV2{
 if(!dependencies)return command;sandboxDependencyFilesV1(dependencies);
 if(command.cwd!=='.')throw new Error("Independent dependency setup currently supports root project commands only.");
 const python=['python','python3'].includes(command.executable),node=['node','npm','npx'].includes(command.executable);
 if(!python&&!node)throw new Error("This validation program has no approved dependency prelude.");
 const original=Buffer.from(JSON.stringify({executable:command.executable,args:command.args,cwd:command.cwd})).toString('base64');
 return{...command,executable:python?'python3':'node',args:[...(python?['-I']:[]),python?dependencies.python:dependencies.node,'--execute',dependencies.fingerprint,original]};
}
export function sandboxDependencyProfileV1(profile:RepositoryProfileV2,commandId:string,dependencies:HostSandboxDependenciesV1|null|undefined):RepositoryProfileV2{
 if(!dependencies)return profile;return{...profile,validationCatalog:profile.validationCatalog.map(command=>command.id===commandId?sandboxDependencyCommandV1(command,dependencies):command)};
}
export function assertSandboxDependencyCommandV1(actual:PreparedSandboxActionV2['command'],original:RepositoryValidationCommandV2,dependencies:HostSandboxDependenciesV1|null|undefined):void{
 const expected=sandboxDependencyCommandV1(original,dependencies);if(actual.executable!==expected.executable||actual.cwd!==expected.cwd||actual.timeoutMs!==expected.timeoutMs||JSON.stringify(actual.args)!==JSON.stringify(expected.args))throw new Error("The prepared dependency command differs from the current approved command. Prepare again.");
}
export function assertSandboxDependencyStagingV1(staging:readonly SandboxStagingEntryV2[],dependencies:HostSandboxDependenciesV1|null|undefined):Map<string,SandboxStagedFileBytesV2>{
 const files=sandboxDependencyFilesV1(dependencies);
 for(const file of files.values()){const entry=staging.find(entry=>entry.path===file.path);if(!entry||entry.bytes!==file.bytes.byteLength||entry.sha256!==sha(file.bytes))throw new Error("Approved dependency files changed after preparation.");}
 if(staging.some(entry=>entry.path.startsWith(PREFIX)&&!files.has(entry.path)))throw new Error("The prepared dependency prelude is no longer approved.");return files;
}
export function originalSandboxDependencyCommandV1(actual:PreparedSandboxActionV2['command'],dependencies:HostSandboxDependenciesV1):CodeSandboxRunCommandV1{
 let value:{executable:string;args:string[];cwd:string};try{value=JSON.parse(Buffer.from(actual.args.at(-1)??'','base64').toString('utf8'));}catch{throw new Error("The prepared dependency command has no valid original argv.");}
 const decision=codeSandboxRunPolicyV1({argv:[value.executable,...(Array.isArray(value.args)?value.args:[])],cwd:value.cwd,timeoutSeconds:actual.timeoutMs/1000});
 if(!decision.ok)throw new Error("The original command no longer satisfies the sandbox command policy: "+decision.reason);
 const original:RepositoryValidationCommandV2={id:'host-original',projectId:'host-project',phase:'targeted',executable:decision.command.executable,args:decision.command.args,cwd:decision.command.cwd,timeoutMs:decision.command.timeoutMs,network:'disabled',credentialPolicy:'none',lockfile:null};
 assertSandboxDependencyCommandV1(actual,original,dependencies);return decision.command;
}
