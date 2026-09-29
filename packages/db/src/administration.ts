import { eq,sql } from 'drizzle-orm';
import type pg from 'pg';
import type { Database } from './database.js';
import { organizationPolicies } from './schema.js';

export interface RepositorySummary { id:string; owner:string; name:string; enabled:boolean; retentionMode:string; githubRepositoryId:number; }
/** Resolves, at the moment of the write, which repositories the caller may administer. */
export type AdminCheck=(repositoryIds:readonly string[])=>Promise<readonly string[]>;
/** Something that can run inside a caller's transaction, or on its own when given none. */
export type Queryable=Pick<pg.PoolClient,'query'>;

/**
 * Every change to who may administer an organization, and every write that depends on it,
 * takes this lock. It is a transaction-scoped advisory lock rather than a row lock because the
 * thing being protected is the enabled SET: enabling a repository that is currently disabled
 * locks no row an organization-wide check would have read, so row locks alone would let the two
 * interleave (ADR-028).
 */
async function lockAuthority(client:Queryable,organizationId:string):Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`humanize:organization-authority:${organizationId}`]);
}

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
      await lockAuthority(tx,organizationId);
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
  async setPolicy(organizationId:string,policy:unknown,client?:Queryable):Promise<void> {
    if(client){
      await client.query(`INSERT INTO organization_policies (organization_id,policy,version,updated_at) VALUES ($1,$2,1,now())
        ON CONFLICT (organization_id) DO UPDATE SET policy=EXCLUDED.policy,updated_at=now(),version=organization_policies.version+1`,[organizationId,JSON.stringify(policy)]);
      return;
    }
    await this.db.orm.insert(organizationPolicies).values({organizationId,policy,version:1,updatedAt:new Date()})
      .onConflictDoUpdate({target:organizationPolicies.organizationId,set:{policy,updatedAt:new Date(),version:sql`${organizationPolicies.version}+1`}});
  }

  /**
   * Runs an organization-wide write only for someone who administers EVERY enabled repository
   * in it, of which there must be at least one (ADR-028).
   *
   * Installing the App does not prove anyone owns the organization, so authority is derived from
   * the repositories themselves: whoever administers all of them may govern what applies to all
   * of them. The check and the write share one transaction under the organization's authority
   * lock, so the enabled set cannot change between the answer and the write, and the write sees
   * exactly the set that was checked.
   */
  async asOrganizationAdmin<T>(organizationId:string,check:AdminCheck,write:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
    return this.db.transaction(async (tx:pg.PoolClient)=>{
      await lockAuthority(tx,organizationId);
      const enabled=await tx.query<{id:string}>('SELECT id FROM repositories WHERE organization_id=$1 AND enabled ORDER BY id',[organizationId]);
      const ids=enabled.rows.map(row=>row.id);
      // No enabled repository means nobody has yet shown administrator rights over anything
      // here, so nobody may govern it yet; enabling one comes first.
      if(!ids.length)throw Error('NO_ENABLED_REPOSITORY');
      const permitted=new Set(await check(ids));
      if(ids.some(id=>!permitted.has(id)))throw Error('FORBIDDEN');
      return write(tx);
    });
  }
}
