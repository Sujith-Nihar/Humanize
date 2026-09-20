import { mkdtemp, mkdir, rm, readdir, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LIMITS } from '@humanize/domain';

/** A path that vanished between listing and measuring contributes nothing. */
const vanished=(error:unknown):boolean=>['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??'');

/**
 * Measures a directory while it is being written to. Git creates and renames temporary
 * pack and index files continuously during a fetch, so an entry named by readdir is
 * routinely gone by the time lstat reaches it. Such an entry is skipped rather than
 * thrown, because treating a disappearing temp file as a measurement failure kills the
 * very Git process that is writing it.
 */
export async function directoryBytes(directory:string):Promise<number> {
  let bytes=0;
  let entries;
  try{entries=await readdir(directory,{withFileTypes:true});}
  catch(error){if(vanished(error))return 0;throw error;}
  for(const entry of entries) {
    const path=join(directory,entry.name);
    if(entry.isSymbolicLink()) continue;
    if(entry.isDirectory()) bytes+=await directoryBytes(path);
    else {
      try{bytes+=(await lstat(path)).size;}
      catch(error){if(!vanished(error))throw error;}
    }
  }
  return bytes;
}

export class Workspace {
  private constructor(readonly path:string,readonly quotaBytes:number) {}
  static async create(root=join(tmpdir(),'humanize-workspaces'),quotaBytes=LIMITS.workspaceBytes):Promise<Workspace> {
    await mkdir(root,{recursive:true,mode:0o700});
    const path=await mkdtemp(join(root,'job-'));
    await writeFile(join(path,'.humanize-owner'),JSON.stringify({pid:process.pid,id:randomUUID(),createdAt:Date.now()}),{mode:0o600});
    return new Workspace(path,quotaBytes);
  }
  async assertQuota():Promise<void> { if(await directoryBytes(this.path)>this.quotaBytes) throw new Error('WORKSPACE_LIMIT'); }
  async destroy():Promise<void> { await rm(this.path,{recursive:true,force:true,maxRetries:3}); }
}

export async function withWorkspace<T>(run:(workspace:Workspace)=>Promise<T>,root?:string):Promise<T> {
  const workspace=await Workspace.create(root);
  try{return await run(workspace);}finally{await workspace.destroy();}
}

export async function sweepWorkspaces(root:string,olderThanMs:number,now=Date.now()):Promise<number> {
  // Startup sweeper only removes application-owned, stale workspaces. Never follow links.
  const {readFile}=await import('node:fs/promises');
  let removed=0;
  for(const entry of await readdir(root,{withFileTypes:true}).catch(()=>[])) {
    if(!entry.isDirectory()||entry.isSymbolicLink()||!/^job-[a-zA-Z0-9]+$/.test(entry.name))continue;
    const path=join(root,entry.name);
    try {
      const owner:unknown=JSON.parse(await readFile(join(path,'.humanize-owner'),'utf8'));
      if(!owner||typeof owner!=='object'||!('createdAt'in owner)||typeof owner.createdAt!=='number'||now-owner.createdAt<olderThanMs)continue;
      if('pid'in owner&&typeof owner.pid==='number') {
        try {process.kill(owner.pid,0);continue;}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')continue;}
      }
      await rm(path,{recursive:true,force:true});removed++;
    }catch{ /* Unrecognized directories are not ours to delete. */ }
  }
  return removed;
}
