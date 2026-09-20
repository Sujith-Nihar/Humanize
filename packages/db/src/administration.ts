import { eq,sql } from 'drizzle-orm';
import type pg from 'pg';
import type { Database } from './database.js';
import { organizationPolicies } from './schema.js';

export interface RepositorySummary { id:string; owner:string; name:string; enabled:boolean; retentionMode:string; githubRepositoryId:number; }
/** Resolves, at the moment of the write, which repositories the caller may administer. */
export type AdminCheck=(repositoryIds:readonly string[])=>Promise<readonly string[]>;

export class AdministrationStore {
  constructor(private readonly db:Database){}

  async repositories(organizationId:string):Promise<RepositorySummary[]> {
    const rows=await this.db.pool.query<{id:string;owner:string;name:string;enabled:boolean;retention_mode:string;github_repository_id:string}>(
      'SELECT id,owner,name,enabled,retention_mode,github_repository_id FROM repositories WHERE organization_id=$1 ORDER BY owner,name',[organizationId]);
    return rows.rows.map(row=>({id:row.id,owner:row.owner,name:row.name,enabled:row.enabled,retentionMode:row.retention_mode,githubRepositoryId:Number(row.github_repository_id)}));
  }

  /**
   * Enables or disables repositories, taking the administrator check inside the transaction
   * and holding the rows while it runs. A check taken beforehand describes rights the caller
   * had a moment ago; locking first and asking second means a repository cannot be enabled by
   * someone who has since lost access, and two concurrent requests cannot interleave.
   */
  async setEnabled(organizationId:string,repositoryIds:readonly string[],enabled:boolean,check:AdminCheck):Promise<string[]> {
    if(!repositoryIds.length)return [];
    return this.db.transaction(async (tx:pg.PoolClient)=>{
      const locked=await tx.query<{id:string}>(
        'SELECT id FROM repositories WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
        [organizationId,[...repositoryIds]]);
      const present=locked.rows.map(row=>row.id);
      if(!present.length)return [];
      // Asked while the rows are held, so the answer cannot go stale before the write.
      const permitted=new Set(await check(present));
      const allowed=present.filter(id=>permitted.has(id));
      if(!allowed.length)return [];
      await tx.query('UPDATE repositories SET enabled=$3 WHERE organization_id=$1 AND id=ANY($2::uuid[])',[organizationId,allowed,enabled]);
      return allowed;
    });
  }

  async policy(organizationId:string):Promise<unknown|null> {
    const [row]=await this.db.orm.select().from(organizationPolicies).where(eq(organizationPolicies.organizationId,organizationId));
    return row?.policy??null;
  }

  /** Administrator-only settings; repository content can never reach these fields (ADR-027). */
  async setPolicy(organizationId:string,policy:unknown):Promise<void> {
    await this.db.orm.insert(organizationPolicies).values({organizationId,policy,version:1,updatedAt:new Date()})
      .onConflictDoUpdate({target:organizationPolicies.organizationId,set:{policy,updatedAt:new Date(),version:sql`${organizationPolicies.version}+1`}});
  }
}
