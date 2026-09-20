import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Sha, LIMITS } from '@humanize/domain';
import { safePath, abortIfNeeded } from '@humanize/shared';
import type { Workspace } from './workspace.js';

const flags=['-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','core.fsmonitor=false','-c','protocol.allow=never','-c','protocol.https.allow=always','-c','submodule.recurse=false','-c','diff.external=','-c','core.pager=cat'];
export interface TreeEntry {path:string;mode:string;type:string;sha:string;size:number;}
export interface ChangedFile {oldPath:string|null;newPath:string|null;patch:string;}
export class GitRepository {
  private constructor(readonly gitDir:string,private readonly workspace:Workspace,private readonly token:string|undefined,private readonly signal:AbortSignal|undefined) {}

  static async acquire(workspace:Workspace,args:{owner:string;repository:string;token:string;headSha:string;baseSha:string;pullNumber?:number;signal?:AbortSignal}):Promise<GitRepository> {
    if(!/^[a-zA-Z0-9-]+$/.test(args.owner)||!/^[a-zA-Z0-9_.-]+$/.test(args.repository))throw Error('INVALID_REPOSITORY');
    Sha.parse(args.headSha);Sha.parse(args.baseSha);
    const gitDir=join(workspace.path,'repo.git');
    const repo=new GitRepository(gitDir,workspace,args.token,args.signal);
    await repo.exec(['clone','--bare','--no-local','--no-tags','--filter=blob:none',`https://github.com/${args.owner}/${args.repository}.git`,gitDir],false);
    if(args.pullNumber!==undefined){if(!Number.isSafeInteger(args.pullNumber)||args.pullNumber<=0)throw Error('INVALID_PR');await repo.exec(['fetch','--no-tags','origin',`refs/pull/${args.pullNumber}/head`]);}
    for(const sha of [args.baseSha,args.headSha]) {
      try{await repo.exec(['cat-file','-e',`${sha}^{commit}`]);}catch{await repo.exec(['fetch','--no-tags','origin',sha]);}
      await repo.exec(['cat-file','-e',`${sha}^{commit}`]);
    }
    return repo;
  }

  /** Trusted developer fixtures only: network acquisition never accepts local paths. */
  static forFixture(gitDir:string,workspace:Workspace,signal?:AbortSignal):GitRepository { return new GitRepository(gitDir,workspace,undefined,signal); }

  private async exec(args:string[],useGitDir=true,maxBytes=32*1024*1024):Promise<Buffer> {
    abortIfNeeded(this.signal);
    const allowed=new Set(['clone','fetch','cat-file','ls-tree','diff','merge-base','rev-parse']);
    if(!allowed.has(args[0]??''))throw Error('FORBIDDEN_GIT_COMMAND');
    const env:NodeJS.ProcessEnv={PATH:process.env.PATH??'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_LFS_SKIP_SMUDGE:'1',GIT_ATTR_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1',LC_ALL:'C'};
    if(this.token) {
      const helper=join(this.workspace.path,'askpass.cjs');
      await writeFile(helper,`#!${process.execPath}\nprocess.stdout.write(/username/i.test(process.argv[2]||'')?'x-access-token':process.env.HUMANIZE_GIT_TOKEN||'');\n`,{mode:0o700});
      env.GIT_ASKPASS=helper;env.HUMANIZE_GIT_TOKEN=this.token;
    }
    await mkdir(this.workspace.path,{recursive:true});
    return new Promise<Buffer>((resolve,reject)=>{
      const child=spawn('git',[...flags,...(useGitDir?[`--git-dir=${this.gitDir}`]:[]),...args],{cwd:this.workspace.path,env,stdio:['ignore','pipe','pipe'],shell:false});
      const chunks:Buffer[]=[];let size=0;let failure:Error|undefined;
      const kill=(error:Error)=>{failure??=error;child.kill('SIGKILL');};
      const abort=()=>kill(new Error('CANCELLED'));
      this.signal?.addEventListener('abort',abort,{once:true});
      const timeout=setTimeout(()=>kill(new Error('GIT_TIMEOUT')),120000);
      let checking=false;
      // Only a real quota breach may kill the process. Any other failure of the measurement
      // is a fault in the check, not in the job it polices, and must never SIGKILL Git
      // mid-write: that leaves a commit graph referencing objects absent from the object
      // database, and every later command fails as repository corruption.
      const monitor=setInterval(()=>{if(checking)return;checking=true;void this.workspace.assertQuota().catch((error:unknown)=>{if(error instanceof Error&&error.message==='WORKSPACE_LIMIT')kill(error);}).finally(()=>{checking=false;});},500);
      child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes)kill(new Error('GIT_OUTPUT_LIMIT'));else chunks.push(chunk);});
      // Never expose stderr: Git may echo a malicious path or a credential-bearing diagnostic.
      child.stderr.on('data',()=>{});
      child.on('error',()=>{failure=new Error('GIT_PROCESS_FAILED');});
      child.on('close',code=>{clearTimeout(timeout);clearInterval(monitor);this.signal?.removeEventListener('abort',abort);if(failure||code!==0)reject(failure??new Error('GIT_COMMAND_FAILED'));else resolve(Buffer.concat(chunks));});
    });
  }

  async tree(sha:string):Promise<TreeEntry[]> {
    Sha.parse(sha);
    const raw=(await this.exec(['ls-tree','-r','-l','-z',sha])).toString('utf8');
    return raw.split('\0').filter(Boolean).map(record=>{
      const tab=record.indexOf('\t');const meta=record.slice(0,tab).trim().split(/\s+/);const path=record.slice(tab+1);
      if(tab<0||meta.length!==4)throw Error('INVALID_TREE');
      return {mode:meta[0]!,type:meta[1]!,sha:meta[2]!,size:meta[3]==='-'?0:Number(meta[3]),path};
    });
  }
  async blob(sha:string,maxBytes:number=LIMITS.fileBytes):Promise<Buffer> {
    Sha.parse(sha);
    const size=Number((await this.exec(['cat-file','-s',sha])).toString());
    if(!Number.isSafeInteger(size)||size>maxBytes)throw Error('FILE_TOO_LARGE');
    return this.exec(['cat-file','blob',sha],true,maxBytes);
  }
  async mergeBase(base:string,head:string):Promise<string> {Sha.parse(base);Sha.parse(head);return Sha.parse((await this.exec(['merge-base',base,head])).toString().trim());}
  async changes(base:string,head:string):Promise<ChangedFile[]> {
    Sha.parse(base);Sha.parse(head);
    const tokens=(await this.exec(['diff','--no-ext-diff','--no-textconv','--name-status','-z','--find-renames',base,head])).toString().split('\0');
    const changes:ChangedFile[]=[];
    for(let i=0;i<tokens.length-1;){
      const status=tokens[i++]!;const first=tokens[i++]!;const renamed=status.startsWith('R')||status.startsWith('C');const second=renamed?tokens[i++]!:first;
      if(!safePath(first)||!safePath(second))continue;
      const patch=(await this.exec(['diff','--no-ext-diff','--no-textconv','--no-color','--unified=3',base,head,'--',...(renamed?[first,second]:[first])])).toString();
      changes.push({oldPath:status==='A'?null:first,newPath:status==='D'?null:second,patch});
    }
    return changes;
  }
}
