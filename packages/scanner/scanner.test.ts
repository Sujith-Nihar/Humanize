import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect,it } from 'vitest';
import { withWorkspace, GitRepository, classify } from './src/index.js';
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
