import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect,it } from 'vitest';
import { withWorkspace, GitRepository, classify, Workspace } from './src/index.js';
import { directoryBytes } from './src/workspace.js';
const exec=promisify(execFile);

it('cleans workspaces on failure',async()=>{
  let path='';await expect(withWorkspace(async w=>{path=w.path;throw Error('fixture');})).rejects.toThrow('fixture');
  await expect(access(path)).rejects.toThrow();
});
it('enumerates trusted fixture without executing a configured diff helper',async()=>{
  const path=await mkdtemp(join(tmpdir(),'humanize-fixture-'));
  try {
    const git=(...args:string[])=>exec('git',args,{cwd:path,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
    await git('init');await git('config','user.email','fixture@example.invalid');await git('config','user.name','Fixture');
    await writeFile(join(path,'copy.md'),'First copy\n');await git('add','.');await git('commit','-m','fixture');
    const base=(await git('rev-parse','HEAD')).stdout.trim();
    await writeFile(join(path,'copy.md'),'Second copy\n');await git('add','.');await git('commit','-m','update');
    const head=(await git('rev-parse','HEAD')).stdout.trim();
    const sentinel=join(path,'executed');await git('config','diff.external',`touch ${sentinel}`);
    await withWorkspace(async w=>{
      const repo=GitRepository.forFixture(join(path,'.git'),w);
      const tree=await repo.tree(head);expect(tree.map(e=>e.path)).toEqual(['copy.md']);
      expect((await repo.blob(tree[0]!.sha)).toString()).toBe('Second copy\n');
      expect(await repo.mergeBase(base,head)).toBe(base);
      expect((await repo.changes(base,head))[0]?.patch).toContain('+Second copy');
    });
    await expect(access(sentinel)).rejects.toThrow();
  }finally{await rm(path,{recursive:true,force:true});}
});
it('classifies all entries including hard security restrictions',()=>{
  const entry={path:'locales/en.json',sha:'a'.repeat(40),mode:'100644',type:'blob',size:10};
  expect(classify(entry,Buffer.from('{}')).classification).toBe('SUPPORTED_CONTENT');
  expect(classify({...entry,mode:'120000'},undefined).classification).toBe('NON_CONTENT_SOURCE');
  expect(classify({...entry,size:2000000},undefined).classification).toBe('TOO_LARGE');
  expect(classify({...entry,path:'node_modules/x.js'},undefined).classification).toBe('DEPENDENCY');
});

it('measures a directory that is being written to without failing',async()=>{
  // Git renames temporary pack and index files away constantly during a fetch, so an
  // entry named by readdir is routinely gone before lstat reaches it. Treating that as a
  // measurement failure previously killed the Git process mid-write, which corrupted the
  // object database and surfaced as a bogus WORKSPACE_LIMIT or a later repo corruption.
  const path=await mkdtemp(join(tmpdir(),'churn-'));
  try{
    const packs=join(path,'objects','pack');
    await mkdir(packs,{recursive:true});
    await writeFile(join(path,'stable.bin'),Buffer.alloc(2048));
    let churning=true;
    const churn=(async()=>{
      for(let i=0;churning&&i<400;i++){
        const temp=join(packs,`tmp_pack_${i}`);
        await writeFile(temp,Buffer.alloc(1024)).catch(()=>{});
        await rm(temp,{force:true}).catch(()=>{});
      }
    })();
    for(let i=0;i<40;i++) expect(await directoryBytes(path)).toBeGreaterThanOrEqual(2048);
    churning=false;await churn;
  }finally{await rm(path,{recursive:true,force:true});}
});

it('reports a genuine quota breach and nothing else',async()=>{
  const path=await mkdtemp(join(tmpdir(),'quota-'));
  try{
    await writeFile(join(path,'big.bin'),Buffer.alloc(4096));
    const under=await Workspace.create(path,1024*1024);
    await expect(under.assertQuota()).resolves.toBeUndefined();
    const over=await Workspace.create(path,10);
    await expect(over.assertQuota()).rejects.toThrow('WORKSPACE_LIMIT');
  }finally{await rm(path,{recursive:true,force:true});}
});
