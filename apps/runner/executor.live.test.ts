import { afterAll,beforeAll,expect,it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp,rm,writeFile,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Category } from '@humanize/domain';
import type { ReviewSnapshot } from '@humanize/domain';
import { OllamaProvider } from '@humanize/providers';
import { GitRepository } from '@humanize/scanner';
import { executeReview } from './src/executor.js';
import type { Lease,LeaseCredential } from './src/client.js';
import type { CategoryName } from '@humanize/review';

const baseUrl=process.env.HUMANIZE_OLLAMA_BASE_URL;
const model=process.env.HUMANIZE_OLLAMA_MODEL;
if(!baseUrl||!model)throw Error('Set HUMANIZE_OLLAMA_BASE_URL and HUMANIZE_OLLAMA_MODEL; a live test is never silently skipped.');

const run=promisify(execFile);
const enabled=Object.fromEntries(Category.options.map(c=>[c,true])) as Record<CategoryName,boolean>;
let origin='',baseSha='',headSha='',workspaceRoot='';

beforeAll(async()=>{
  origin=await mkdtemp(join(tmpdir(),'humanize-live-origin-'));
  workspaceRoot=await mkdtemp(join(tmpdir(),'humanize-live-ws-'));
  const git=(...args:string[])=>run('git',['-C',origin,...args]);
  await run('git',['init','-q','-b','main',origin]);
  await git('config','user.email','fixture@example.com');await git('config','user.name','Fixture');
  await writeFile(join(origin,'landing.tsx'),'export const Hero=()=><h1>Review the content your users read</h1>;\n');
  await git('add','.');await git('commit','-qm','base');
  baseSha=(await git('rev-parse','HEAD')).stdout.trim();
  await writeFile(join(origin,'landing.tsx'),'export const Hero=()=><h1>Unlock unprecedented potential with our cutting-edge platform</h1>;\n');
  await git('add','.');await git('commit','-qm','head');
  headSha=(await git('rev-parse','HEAD')).stdout.trim();
},60000);
afterAll(async()=>{await rm(origin,{recursive:true,force:true});await rm(workspaceRoot,{recursive:true,force:true});});

it('reviews a private repository end to end with a local model only', async () => {
  const profile={provider:'ollama' as const,model,credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']};
  const snapshot:ReviewSnapshot={version:1,organizationId:'org',repositoryId:'repo',installationId:7,owner:'acme',repository:'site',pullNumber:1,
    baseSha,headSha,configSha:'c'.repeat(40),configHash:'config',executionMode:'runner',retentionMode:'ephemeral',reviewer:profile,verifier:profile,language:'en',allowUnevaluatedLanguage:false};
  const lease:Lease={leaseId:'11111111-1111-4111-8111-111111111111',fence:1,runId:'22222222-2222-4222-8222-222222222222',expiresAt:new Date(Date.now()+120000).toISOString(),expiresInMs:120000,snapshot};
  const credential:LeaseCredential={token:'ghs_fixture',expiresAt:new Date(Date.now()+3600000).toISOString(),repository:{owner:'acme',name:'site'},headSha,runId:lease.runId};

  const original=GitRepository.acquire;
  Object.defineProperty(GitRepository,'acquire',{configurable:true,value:async(workspace:{path:string})=>{
    const gitDir=join(workspace.path,'repo.git');
    await run('git',['clone','--bare','--no-local','--no-tags','-q',origin,gitDir]);
    return GitRepository.forFixture(gitDir,workspace as never);
  }});
  try{
    const report=await executeReview(lease,credential,{provider:new OllamaProvider(baseUrl,true)},{enabled,workspaceRoot});
    console.log('LIVE REVIEW =>',JSON.stringify({
      inspectedFiles:report.inspectedFiles,extractedNodes:report.extractedNodes,changedNodes:report.changedNodes,
      findings:report.result.candidates.map(c=>({category:c.category,quoted:c.exactText,explanation:c.explanation})),
      diagnostics:report.result.diagnostics,
    },null,2));
    expect(report.changedNodes).toBe(1);
    // Whatever the model said, every published quotation exists in the reviewed content.
    for(const candidate of report.result.candidates){
      const node=report.result.nodes.find(entry=>entry.id===candidate.nodeId);
      expect(node?.text).toContain(candidate.exactText);
    }
    // No source file survives the job.
    expect(await readdir(workspaceRoot)).toEqual([]);
  }finally{Object.defineProperty(GitRepository,'acquire',{configurable:true,value:original});}
},300000);
