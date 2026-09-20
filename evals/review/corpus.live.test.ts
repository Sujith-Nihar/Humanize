import { afterAll,beforeAll,expect,it } from 'vitest';
import { execFile } from 'node:child_process';
import { cp,mkdtemp,readdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Category } from '@humanize/domain';
import type { ReviewSnapshot } from '@humanize/domain';
import { OllamaProvider } from '@humanize/providers';
import { GitRepository } from '@humanize/scanner';
import { executeReview } from '@humanize/runner';
import type { Lease,LeaseCredential } from '@humanize/runner';
import type { CategoryName } from '@humanize/review';

const baseUrl=process.env.HUMANIZE_OLLAMA_BASE_URL;
const model=process.env.HUMANIZE_OLLAMA_MODEL;
if(!baseUrl||!model)throw Error('Set HUMANIZE_OLLAMA_BASE_URL and HUMANIZE_OLLAMA_MODEL; a live test is never silently skipped.');

const run=promisify(execFile);
const fixtures=join(dirname(fileURLToPath(import.meta.url)),'..','fixtures');
let origin='',workspaceRoot='',baseSha='',headSha='';

beforeAll(async()=>{
  origin=await mkdtemp(join(tmpdir(),'humanize-corpus-'));
  workspaceRoot=await mkdtemp(join(tmpdir(),'humanize-corpus-ws-'));
  const git=(...args:string[])=>run('git',['-C',origin,...args]);
  await run('git',['init','-q','-b','main',origin]);
  await git('config','user.email','fixture@example.com');await git('config','user.name','Fixture');
  await cp(join(fixtures,'before'),origin,{recursive:true});
  await git('add','.');await git('commit','-qm','base');
  baseSha=(await git('rev-parse','HEAD')).stdout.trim();
  await cp(join(fixtures,'after'),origin,{recursive:true,force:true});
  await git('add','.');await git('commit','-qm','head');
  headSha=(await git('rev-parse','HEAD')).stdout.trim();
},120000);
afterAll(async()=>{await rm(origin,{recursive:true,force:true});await rm(workspaceRoot,{recursive:true,force:true});});

it('reviews a realistic multi-format pull request and reports format coverage', async () => {
  const profile={provider:'ollama' as const,model,credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']};
  const snapshot:ReviewSnapshot={version:1,organizationId:'org',repositoryId:'repo',installationId:7,owner:'acme',repository:'site',pullNumber:1,
    baseSha,headSha,configSha:'c'.repeat(40),configHash:'config',executionMode:'runner',retentionMode:'ephemeral',reviewer:profile,verifier:profile,language:'en',allowUnevaluatedLanguage:false};
  const lease:Lease={leaseId:'11111111-1111-4111-8111-111111111111',fence:1,runId:'22222222-2222-4222-8222-222222222222',
    expiresAt:new Date(Date.now()+120000).toISOString(),expiresInMs:120000,snapshot};
  const credential:LeaseCredential={token:'fixture',expiresAt:new Date(Date.now()+3600000).toISOString(),repository:{owner:'acme',name:'site'},headSha,runId:lease.runId};

  const original=GitRepository.acquire;
  Object.defineProperty(GitRepository,'acquire',{configurable:true,value:async(workspace:{path:string})=>{
    const gitDir=join(workspace.path,'repo.git');
    await run('git',['clone','--bare','--no-local','--no-tags','-q',origin,gitDir]);
    return GitRepository.forFixture(gitDir,workspace as never);
  }});
  try{
    const report=await executeReview(lease,credential,{provider:new OllamaProvider(baseUrl,true)},
      {enabled:Object.fromEntries(Category.options.map(c=>[c,true])) as Record<CategoryName,boolean>,
       rules:{blockingRules:[{type:'forbidden_phrase',phrase:'100% secure'}]},workspaceRoot});

    const byFile=new Map<string,number>();
    for(const node of report.result.nodes)byFile.set(node.filePath,(byFile.get(node.filePath)??0)+1);
    console.log('\n=== CORPUS REVIEW ===');
    console.log('files inspected:',report.inspectedFiles,' nodes extracted:',report.extractedNodes,' changed nodes reviewed:',report.changedNodes);
    console.log('changed content found per file:',JSON.stringify(Object.fromEntries(byFile)));
    for(const candidate of report.result.candidates){
      const node=report.result.nodes.find(entry=>entry.id===candidate.nodeId)!;
      console.log(`\n  ${node.filePath}:${node.startLine} [${candidate.category}/${candidate.severity}]\n    "${candidate.exactText}"\n    -> ${candidate.explanation}`);
    }
    console.log('\ndiagnostics:',JSON.stringify(report.result.diagnostics));
    // Formats with changed content that produced no node at all are simply not reviewed.
    const silent=['index.html','locales/en.json'].filter(path=>!byFile.has(path));
    console.log('changed files that produced no reviewable content:',JSON.stringify(silent));

    expect(report.changedNodes).toBeGreaterThan(0);
    for(const candidate of report.result.candidates){
      expect(report.result.nodes.find(entry=>entry.id===candidate.nodeId)?.text).toContain(candidate.exactText);
    }
    expect(await readdir(workspaceRoot)).toEqual([]);
  }finally{Object.defineProperty(GitRepository,'acquire',{configurable:true,value:original});}
},600000);
