import { Category } from '@humanize/domain';
import type { RunnerResult } from '@humanize/domain';
import { OllamaProvider } from '@humanize/providers';
import { sweepWorkspaces } from '@humanize/scanner';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerClient } from './client.js';
import { executeReview } from './executor.js';
import { pollForWork } from './loop.js';
import type { CategoryName } from '@humanize/review';

const controlPlaneUrl=process.env.HUMANIZE_CONTROL_PLANE_URL,credential=process.env.HUMANIZE_RUNNER_TOKEN;
const ollamaUrl=process.env.OLLAMA_BASE_URL??'http://127.0.0.1:11434';
const version=process.env.HUMANIZE_RUNNER_VERSION??'0.1.0';
if(!controlPlaneUrl||!credential)throw Error('HUMANIZE_CONTROL_PLANE_URL and HUMANIZE_RUNNER_TOKEN are required');

// The runner exists so private content stays inside this network; it only ever speaks to a
// local model, and a cloud profile on a leased job is refused rather than quietly honoured.
const provider=new OllamaProvider(ollamaUrl,true);
const client=new RunnerClient({controlPlaneUrl,credential});
const enabled=Object.fromEntries(Category.options.map(category=>[category,true])) as Record<CategoryName,boolean>;
// The container mounts a tmpfs here, so repository content never reaches disk.
const workspaceRoot=process.env.HUMANIZE_WORKSPACE_ROOT??join(tmpdir(),'humanize-workspaces');
// Reclaim workspaces abandoned by a previous process before taking new work.
await sweepWorkspaces(workspaceRoot,60*60*1000);

// The local model is checked before any work is claimed, and a failure here is reported as
// a sentence an operator can act on rather than an unhandled fetch error from Node internals.
let models:string[];
try{models=await provider.listModels();}
catch{
  console.error(JSON.stringify({event:'runner.model_unreachable',ollamaUrl,
    message:`Cannot reach a local model at ${ollamaUrl}. Start Ollama, or set OLLAMA_BASE_URL to where it is listening. From a container this is usually http://host.docker.internal:11434.`}));
  process.exit(1);
}
if(!models.length){
  console.error(JSON.stringify({event:'runner.no_models',ollamaUrl,
    message:`No local models are installed at ${ollamaUrl}. Install one with "ollama pull <model>" before starting the runner.`}));
  process.exit(1);
}

// A runner that has started and found its model should say so: silence and a crash loop
// look identical to an operator otherwise.
console.log(JSON.stringify({event:'runner.started',controlPlaneUrl,ollamaUrl,models:models.length,version}));

const controller=new AbortController();
const stop=()=>controller.abort(new Error('SHUTDOWN'));
process.once('SIGTERM',stop);process.once('SIGINT',stop);

await pollForWork(client,async({lease,credential:jobCredential,signal})=>{
  // An operator needs to see that work was taken, not infer it from silence.
  console.log(JSON.stringify({event:'lease.claimed',runId:lease.runId,fence:lease.fence,expiresInMs:lease.expiresInMs}));
  const started=Date.now();
  const report=await executeReview(lease,jobCredential,{provider},{enabled,workspaceRoot},signal);
  // The codes, not just how many: a review that reports nothing must say why it reported
  // nothing, or a suppressed finding and an absent one look identical to an operator.
  console.log(JSON.stringify({event:'review.executed',runId:lease.runId,durationMs:Date.now()-started,
    inspectedFiles:report.inspectedFiles,extractedNodes:report.extractedNodes,changedNodes:report.changedNodes,
    candidates:report.result.candidates.length,
    diagnostics:Object.fromEntries(report.result.diagnostics.map(d=>[d.code,d.count]))}));
  return report;
},{
  capabilities:{protocolVersion:1,schemaVersion:'humanize-runner-v1',version,models,labels:[],localOnly:true},
  signal:controller.signal,
  // Every outcome is reported. A lease that is lost or fails must not look like idleness.
  onOutcome:outcome=>{console.log(JSON.stringify({event:'lease.outcome',status:outcome.status,
    ...(outcome.status==='failed'?{retryable:outcome.retryable}:{})}));},
  // The control plane validates and publishes; the runner only reports what it found.
  report:async value=>{
    const {duplicate}=await client.uploadResult((value as {result:RunnerResult}).result);
    console.log(JSON.stringify({event:'result.uploaded',duplicate}));
  },
});
