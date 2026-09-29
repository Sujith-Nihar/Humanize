import { afterAll,beforeAll,expect,it,vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp,rm,writeFile,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Category,validateRunnerResult } from '@humanize/domain';
import type { ModelProvider,ReviewSnapshot } from '@humanize/domain';
import { executeReview } from './src/executor.js';
import type { Lease,LeaseCredential } from './src/client.js';
import type { CategoryName } from '@humanize/review';

const run=promisify(execFile);
const enabled=Object.fromEntries(Category.options.map(c=>[c,true])) as Record<CategoryName,boolean>;
let origin='',baseSha='',headSha='',workspaceRoot='';

// A real local repository: the executor is only meaningful against actual Git objects.
beforeAll(async()=>{
  origin=await mkdtemp(join(tmpdir(),'humanize-origin-'));
  workspaceRoot=await mkdtemp(join(tmpdir(),'humanize-ws-'));
  const git=(...args:string[])=>run('git',['-C',origin,...args]);
  await run('git',['init','-q','-b','main',origin]);
  await git('config','user.email','fixture@example.com');
  await git('config','user.name','Fixture');
  await writeFile(join(origin,'page.tsx'),'export const Hero=()=><h1>Manage your applications</h1>;\n');
  await writeFile(join(origin,'secret.bin'),Buffer.from([0,1,2,3]));
  await git('add','.');await git('commit','-qm','base');
  baseSha=(await git('rev-parse','HEAD')).stdout.trim();
  await writeFile(join(origin,'page.tsx'),'export const Hero=()=><h1>Unlock unprecedented potential with our cutting-edge platform</h1>;\n');
  await git('add','.');await git('commit','-qm','head');
  headSha=(await git('rev-parse','HEAD')).stdout.trim();
},60000);
afterAll(async()=>{await rm(origin,{recursive:true,force:true});await rm(workspaceRoot,{recursive:true,force:true});});

const profile={provider:'ollama' as const,model:'fixture',credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']};
const snapshot=():ReviewSnapshot=>({version:1,organizationId:'org',repositoryId:'repo',installationId:7,owner:'acme',repository:'site',pullNumber:1,
  baseSha,headSha,configSha:'c'.repeat(40),configHash:'config',executionMode:'runner',retentionMode:'ephemeral',reviewer:profile,verifier:profile,language:'en',allowUnevaluatedLanguage:false});
const lease=():Lease=>({leaseId:'11111111-1111-4111-8111-111111111111',fence:1,runId:'22222222-2222-4222-8222-222222222222',expiresAt:new Date(Date.now()+120000).toISOString(),expiresInMs:120000,snapshot:snapshot()});
const credential=():LeaseCredential=>({token:'ghs_fixture',expiresAt:new Date(Date.now()+3600000).toISOString(),repository:{owner:'acme',name:'site'},headSha,runId:'22222222-2222-4222-8222-222222222222'});
const hosts:string[]=[];
const provider=(candidates:unknown[]):ModelProvider=>({
  id:'ollama',testConnection:vi.fn(),
  generateStructured:vi.fn(async(args:{system:string})=>{
    hosts.push('127.0.0.1:11434');
    const data=args.system.startsWith('You review')?{candidates,searches:[]}
      :{results:(candidates as {nodeId:string}[]).map(()=>({candidateId:'unused',publish:false,confidence:0.99,correctedExplanation:null,correctedReplacement:null,reasonIfSuppressed:'fixture'}))};
    return {data,provider:'ollama',model:'fixture',durationMs:1};
  }),
} as unknown as ModelProvider);

// Acquisition normally clones from GitHub; the fixture origin stands in for that remote.
const fromLocalOrigin=async(fn:()=>Promise<unknown>,source=origin)=>{
  const scanner=await import('@humanize/scanner');
  const original=scanner.GitRepository.acquire;
  const patched=async(workspace:{path:string})=>{
    const gitDir=join(workspace.path,'repo.git');
    await run('git',['clone','--bare','--no-local','--no-tags','-q',source,gitDir]);
    return scanner.GitRepository.forFixture(gitDir,workspace as never);
  };
  Object.defineProperty(scanner.GitRepository,'acquire',{value:patched,configurable:true});
  try{return await fn();}finally{Object.defineProperty(scanner.GitRepository,'acquire',{value:original,configurable:true});}
};

it('reviews only what the pull request changed, and leaves no workspace behind', async () => {
  const report=await fromLocalOrigin(async()=>executeReview(lease(),credential(),{provider:provider([])},{enabled,workspaceRoot})) as Awaited<ReturnType<typeof executeReview>>;
  expect(report.inspectedFiles).toBeGreaterThan(0);
  expect(report.changedNodes).toBe(1);
  expect(report.result.nodes[0]!.text).toContain('Unlock unprecedented potential');
  // The binary file was classified out and never parsed.
  expect(report.result.nodes.every(node=>node.filePath==='page.tsx')).toBe(true);
  expect(report.result.snapshotHash).toHaveLength(64);
  expect(await readdir(workspaceRoot)).toEqual([]);
}, 120000);

it('never contacts a host other than the configured local model', async () => {
  hosts.length=0;
  await fromLocalOrigin(async()=>executeReview(lease(),credential(),{provider:provider([])},{enabled,workspaceRoot}));
  expect(hosts.every(host=>host.startsWith('127.0.0.1'))).toBe(true);
  for(const host of ['api.openai.com','generativelanguage.googleapis.com','openrouter.ai'])expect(hosts).not.toContain(host);
}, 120000);

it('refuses a job configured to use a cloud model', async () => {
  const cloud=lease();
  const job={...cloud,snapshot:{...cloud.snapshot,reviewer:{...profile,provider:'openai' as const}}};
  await expect(executeReview(job as Lease,credential(),{provider:provider([])},{enabled,workspaceRoot})).rejects.toThrow('CLOUD_MODEL_IN_PRIVATE_JOB');
  expect(await readdir(workspaceRoot)).toEqual([]);
}, 120000);

it('records a model failure as a diagnostic instead of losing the whole review', async () => {
  const failing={id:'ollama',testConnection:vi.fn(),generateStructured:vi.fn(async()=>{throw Error('model exploded');})} as unknown as ModelProvider;
  const report=await fromLocalOrigin(async()=>executeReview(lease(),credential(),{provider:failing},{enabled,workspaceRoot})) as Awaited<ReturnType<typeof executeReview>>;
  expect(report.result.diagnostics.some(d=>d.code.startsWith('REVIEW_FAILED'))).toBe(true);
  // Deterministic findings need no model, so a total model failure still reports what is
  // objectively countable in the content rather than reviewing nothing at all (ADR-037).
  expect(report.result.candidates.map(c=>c.category)).toContain('ai_like_generic');
  expect(await readdir(workspaceRoot)).toEqual([]);
}, 120000);

it('destroys the workspace when acquisition itself fails', async () => {
  const scanner=await import('@humanize/scanner');
  const original=scanner.GitRepository.acquire;
  Object.defineProperty(scanner.GitRepository,'acquire',{configurable:true,value:async()=>{throw Error('clone refused');}});
  try{
    await expect(executeReview(lease(),credential(),{provider:provider([])},{enabled,workspaceRoot})).rejects.toThrow('clone refused');
    expect(await readdir(workspaceRoot)).toEqual([]);
  }finally{Object.defineProperty(scanner.GitRepository,'acquire',{configurable:true,value:original});}
}, 120000);

it('sends the unchanged content its evidence cites, so a context-backed finding survives validation', async () => {
  // The defect this guards against: the result carried only changed nodes, so any finding citing
  // retrieved context failed validation with EVIDENCE_NODE_UNKNOWN and the whole review was lost.
  const repo=await mkdtemp(join(tmpdir(),'humanize-context-'));
  const git=(...args:string[])=>run('git',['-C',repo,...args]);
  try{
    await run('git',['init','-q','-b','main',repo]);
    await git('config','user.email','fixture@example.com');await git('config','user.name','Fixture');
    await writeFile(join(repo,'README.md'),'# Guide\n\nOur platform delivers seamless synergy for every team.\n\nSetup takes five minutes.\n');
    await git('add','.');await git('commit','-qm','base');
    const base=(await git('rev-parse','HEAD')).stdout.trim();
    await writeFile(join(repo,'README.md'),'# Guide\n\nOur platform delivers seamless synergy for every team.\n\nOur platform delivers seamless synergy for everyone.\n');
    await git('add','.');await git('commit','-qm','head');
    const head=(await git('rev-parse','HEAD')).stdout.trim();

    // A model that does what the prompt asks: cite the evidence it was given, here the
    // unchanged paragraph on line 3 that the changed one repeats.
    const citing={id:'ollama',testConnection:vi.fn(),generateStructured:vi.fn(async(args:{system:string;input:string})=>{
      if(args.system.startsWith('You review')){
        const nodeId=/nodeId "([^"]+)"/.exec(args.input)![1]!;
        const neighbour=/id: ([a-f0-9]{64}) \(README\.md:3\)/.exec(args.input)![1]!;
        return {data:{candidates:[{nodeId,category:'clarity',severity:'minor',confidence:0.9,exactText:'seamless synergy',
          explanation:'This repeats the paragraph above almost word for word.',evidence:[{id:neighbour,quote:null}],replacement:null,requiresVerification:true}],searches:[]},provider:'ollama',model:'fixture',durationMs:1};
      }
      const candidateId=/candidateId: (\S+)/.exec(args.input)![1]!;
      return {data:{results:[{candidateId,publish:true,confidence:0.95,correctedExplanation:null,correctedReplacement:null,reasonIfSuppressed:null}]},provider:'ollama',model:'fixture',durationMs:1};
    })} as unknown as ModelProvider;

    const job={...lease(),snapshot:{...snapshot(),baseSha:base,headSha:head}};
    const report=await fromLocalOrigin(async()=>executeReview(job,{...credential(),headSha:head},{provider:citing},{enabled,workspaceRoot}),repo) as Awaited<ReturnType<typeof executeReview>>;

    expect(report.result.candidates).toHaveLength(1);
    expect(report.result.nodes.map(node=>node.startLine)).toEqual([5]);
    // The cited paragraph travels as context, not as reviewed content.
    expect(report.result.contextNodes.map(node=>node.startLine)).toEqual([3]);
    expect(validateRunnerResult(report.result,job.snapshot)).toEqual([]);
    // Without it, exactly the old failure returns.
    expect(validateRunnerResult({...report.result,contextNodes:[]},job.snapshot)).toEqual(['EVIDENCE_NODE_UNKNOWN']);
  }finally{await rm(repo,{recursive:true,force:true});}
}, 120000);
