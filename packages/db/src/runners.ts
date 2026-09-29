import { randomUUID } from 'node:crypto';
import { opaqueToken,tokenHash } from '@humanize/security';
import { RunnerCapabilitiesSchema,ReviewSnapshotSchema,RunnerResultSchema,snapshotDigest,runnerResultDigest } from '@humanize/domain';
import type { RunnerCapabilities,RunnerResult,ReviewSnapshot } from '@humanize/domain';
import type pg from 'pg';
import { Database } from './database.js';

interface RunnerRow {id:string;organization_id:string;repository_ids:string[];capabilities:RunnerCapabilities;}
export interface Lease {leaseId:string;fence:number;runId:string;expiresAt:string;expiresInMs:number;snapshot:ReviewSnapshot;}
export interface LeaseScope {organizationId:string;repositoryId:string;runId:string;installationId:number;githubRepositoryId:number;owner:string;name:string;headSha:string;snapshot:ReviewSnapshot;}
export class RunnerStore {
  constructor(private readonly db:Database){}
  private async authenticated(tx:pg.PoolClient,credential:string):Promise<RunnerRow>{
    const result=await tx.query<RunnerRow>('SELECT id,organization_id,repository_ids,capabilities FROM runners WHERE credential_hash=$1 AND revoked_at IS NULL FOR UPDATE',[tokenHash(credential)]);
    if(!result.rows[0])throw Error('RUNNER_UNAUTHORIZED');return result.rows[0];
  }
  /**
   * Mints a single-use invitation a runner exchanges for its credential. The administrator check
   * runs inside the transaction with the repository rows held, so rights cannot lapse between the
   * check and the write, and the author is recorded because issuing a runner credential is a
   * privileged act someone must be accountable for. The token is returned once and stored only
   * as a hash, so it can never be read back.
   */
  async enrollment(organizationId:string,repositoryIds:string[],options:{createdBy?:string;check?:(ids:readonly string[])=>Promise<readonly string[]>}={}):Promise<{token:string;id:string;expiresAt:string}>{
    if(!repositoryIds.length||new Set(repositoryIds).size!==repositoryIds.length)throw Error('INVALID_SCOPE');
    return this.db.transaction(async tx=>{
      const repos=await tx.query<{id:string}>('SELECT id FROM repositories WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND enabled=true FOR SHARE',[organizationId,repositoryIds]);
      if(repos.rowCount!==repositoryIds.length)throw Error('INVALID_SCOPE');
      if(options.check){
        const permitted=new Set(await options.check(repos.rows.map(row=>row.id)));
        // Every named repository must be administrable: a partial grant would quietly widen
        // the runner's scope beyond what the caller was entitled to authorise.
        if(repositoryIds.some(id=>!permitted.has(id)))throw Error('FORBIDDEN');
      }
      const token=opaqueToken();
      const inserted=await tx.query<{id:string;expires_at:Date}>("INSERT INTO runner_enrollments(organization_id,token_hash,repository_ids,created_by,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes') RETURNING id,expires_at",[organizationId,tokenHash(token),repositoryIds,options.createdBy??null]);
      const row=inserted.rows[0]!;
      return {token,id:row.id,expiresAt:row.expires_at.toISOString()};
    });
  }

  /** Outstanding and past invitations. No token or hash is ever returned. */
  async enrollments(organizationId:string):Promise<{id:string;repositoryIds:string[];createdBy:string|null;createdAt:string;expiresAt:string;state:'pending'|'consumed'|'expired'|'revoked'}[]>{
    const rows=await this.db.pool.query<{id:string;repository_ids:string[];created_by:string|null;created_at:Date;expires_at:Date;consumed_at:Date|null;revoked_at:Date|null;expired:boolean}>(
      'SELECT id,repository_ids,created_by,created_at,expires_at,consumed_at,revoked_at,expires_at<=now() AS expired FROM runner_enrollments WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 200',[organizationId]);
    return rows.rows.map(row=>({
      id:row.id,repositoryIds:row.repository_ids,createdBy:row.created_by,
      createdAt:row.created_at.toISOString(),expiresAt:row.expires_at.toISOString(),
      // Consumption is reported ahead of revocation: an invitation that was used stays used,
      // and cancelling afterwards must never make it look as though it never was.
      state:row.consumed_at?'consumed':row.revoked_at?'revoked':row.expired?'expired':'pending',
    }));
  }

  /** Cancels an invitation that has not been used. A consumed one is history, not a live grant. */
  async revokeEnrollment(organizationId:string,id:string,client?:Pick<pg.PoolClient,'query'>):Promise<boolean>{
    const result=await (client??this.db.pool).query(
      'UPDATE runner_enrollments SET revoked_at=now() WHERE organization_id=$1 AND id=$2 AND consumed_at IS NULL AND revoked_at IS NULL',[organizationId,id]);
    return result.rowCount===1;
  }

  /** Registered runners with their liveness, so an administrator can see and revoke them. */
  async runners(organizationId:string,offlineAfterMs=90000):Promise<{id:string;repositoryIds:string[];version:string;models:number;online:boolean;lastHeartbeat:string;revoked:boolean}[]>{
    const rows=await this.db.pool.query<{id:string;repository_ids:string[];capabilities:RunnerCapabilities;last_heartbeat:Date;revoked_at:Date|null;age_ms:string}>(
      'SELECT id,repository_ids,capabilities,last_heartbeat,revoked_at,extract(epoch from (now()-last_heartbeat))*1000 AS age_ms FROM runners WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 200',[organizationId]);
    return rows.rows.map(row=>({
      id:row.id,repositoryIds:row.repository_ids,version:row.capabilities.version,models:row.capabilities.models.length,
      // Liveness is measured by the database clock, never this process's (ADR recorded earlier).
      online:row.revoked_at===null&&Number(row.age_ms)<offlineAfterMs,
      lastHeartbeat:row.last_heartbeat.toISOString(),revoked:row.revoked_at!==null,
    }));
  }
  async register(token:string,capabilities:RunnerCapabilities):Promise<{runnerId:string;credential:string}>{
    const caps=RunnerCapabilitiesSchema.parse(capabilities);
    return this.db.transaction(async tx=>{
      const enrollment=await tx.query<{organization_id:string;repository_ids:string[]}>('UPDATE runner_enrollments SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now() RETURNING organization_id,repository_ids',[tokenHash(token)]);
      if(!enrollment.rows[0])throw Error('INVALID_ENROLLMENT');const row=enrollment.rows[0];const credential=opaqueToken(),runnerId=randomUUID();
      await tx.query('INSERT INTO runners(id,organization_id,credential_hash,repository_ids,capabilities) VALUES($1,$2,$3,$4,$5)',[runnerId,row.organization_id,tokenHash(credential),row.repository_ids,JSON.stringify(caps)]);return {runnerId,credential};
    });
  }
  async heartbeat(credential:string,capabilities:RunnerCapabilities):Promise<void>{
    const caps=RunnerCapabilitiesSchema.parse(capabilities);
    await this.db.transaction(async tx=>{const runner=await this.authenticated(tx,credential);await tx.query('UPDATE runners SET last_heartbeat=now(),capabilities=$1 WHERE id=$2 AND organization_id=$3',[JSON.stringify(caps),runner.id,runner.organization_id]);});
  }
  async enqueue(organizationId:string,repositoryId:string,runId:string):Promise<void>{
    await this.db.pool.query("INSERT INTO runner_leases(organization_id,repository_id,run_id) SELECT organization_id,repository_id,id FROM review_runs WHERE organization_id=$1 AND repository_id=$2 AND id=$3 AND snapshot->>'executionMode'='runner' ON CONFLICT(run_id) DO NOTHING",[organizationId,repositoryId,runId]);
  }
  async claim(credential:string):Promise<Lease|null>{
    return this.db.transaction(async tx=>{
      const runner=await this.authenticated(tx,credential);const caps=RunnerCapabilitiesSchema.parse(runner.capabilities);
      await tx.query("UPDATE runner_leases SET state=CASE WHEN attempts>=3 THEN 'FAILED_FINAL' ELSE 'QUEUED' END,runner_id=NULL WHERE organization_id=$1 AND state='LEASED' AND expires_at<=now()",[runner.organization_id]);
      const selected=await tx.query<{id:string;snapshot:ReviewSnapshot}>(`SELECT l.id,r.snapshot FROM runner_leases l JOIN review_runs r ON r.id=l.run_id JOIN repositories p ON p.id=l.repository_id JOIN github_installations i ON i.id=p.installation_id WHERE l.organization_id=$1 AND l.repository_id=ANY($2::uuid[]) AND l.state='QUEUED' AND l.attempts<3 AND p.enabled AND NOT i.suspended AND NOT i.deleted AND r.state NOT IN ('STALE','CANCELLED','COMPLETE','FAILED_FINAL') AND r.snapshot->'reviewer'->>'model'=ANY($3::text[]) AND r.snapshot->'verifier'->>'model'=ANY($3::text[]) ORDER BY l.created_at FOR UPDATE OF l SKIP LOCKED LIMIT 1`,[runner.organization_id,runner.repository_ids,caps.models]);
      const row=selected.rows[0];if(!row)return null;
      const changed=await tx.query<{id:string;fence:number;run_id:string;expires_at:Date;remaining_ms:string}>("UPDATE runner_leases SET runner_id=$1,state='LEASED',fence=fence+1,attempts=attempts+1,expires_at=now()+interval '120 seconds' WHERE id=$2 RETURNING id,fence,run_id,expires_at,extract(epoch from (expires_at-now()))*1000 AS remaining_ms",[runner.id,row.id]);
      const lease=changed.rows[0]!;return {leaseId:lease.id,fence:lease.fence,runId:lease.run_id,expiresAt:lease.expires_at.toISOString(),expiresInMs:Math.max(0,Math.round(Number(lease.remaining_ms))),snapshot:ReviewSnapshotSchema.parse(row.snapshot)};
    });
  }
  async renew(credential:string,leaseId:string,fence:number):Promise<{expiresAt:string;expiresInMs:number}>{
    return this.db.transaction(async tx=>{
      const runner=await this.authenticated(tx,credential);
      const result=await tx.query<{expires_at:Date;remaining_ms:string}>(`UPDATE runner_leases l SET expires_at=now()+interval '120 seconds' FROM review_runs r,repositories p,github_installations i WHERE l.run_id=r.id AND l.repository_id=p.id AND p.installation_id=i.id AND l.id=$1 AND l.organization_id=$2 AND l.runner_id=$3 AND l.fence=$4 AND l.state='LEASED' AND l.expires_at>now() AND p.enabled AND NOT i.suspended AND NOT i.deleted AND r.state NOT IN ('STALE','CANCELLED','COMPLETE','FAILED_FINAL') RETURNING l.expires_at,extract(epoch from (l.expires_at-now()))*1000 AS remaining_ms`,[leaseId,runner.organization_id,runner.id,fence]);
      const renewed=result.rows[0];if(!renewed)throw Error('LEASE_LOST');
      return {expiresAt:renewed.expires_at.toISOString(),expiresInMs:Math.max(0,Math.round(Number(renewed.remaining_ms)))};
    });
  }
  /**
   * Resolves the repository a live lease is allowed to read. Applies the same liveness
   * conditions as renewal, so a revoked runner, superseded fence, expired or cancelled
   * lease, terminal run, disabled repository or suspended installation resolves nothing
   * and therefore cannot be issued a GitHub credential.
   */
  async leaseScope(credential:string,leaseId:string,fence:number,options:{forResult?:boolean}={}):Promise<LeaseScope>{
    return this.db.transaction(async tx=>{
      const runner=await this.authenticated(tx,credential);
      const result=await tx.query<{organization_id:string;repository_id:string;run_id:string;installation_id:string;github_repository_id:string;owner:string;name:string;head_sha:string;snapshot:ReviewSnapshot}>(`SELECT l.organization_id,l.repository_id,l.run_id,p.installation_id,p.github_repository_id,p.owner,p.name,r.head_sha,r.snapshot FROM runner_leases l JOIN review_runs r ON r.id=l.run_id JOIN repositories p ON p.id=l.repository_id JOIN github_installations i ON i.id=p.installation_id WHERE l.id=$1 AND l.organization_id=$2 AND l.runner_id=$3 AND l.fence=$4 AND ((l.state='LEASED' AND l.expires_at>now()) OR ($5 AND l.state='RESULT_RECEIVED')) AND p.enabled AND NOT i.suspended AND NOT i.deleted AND r.state NOT IN ('STALE','CANCELLED','COMPLETE','FAILED_FINAL')`,[leaseId,runner.organization_id,runner.id,fence,options.forResult===true]);
      const row=result.rows[0];if(!row)throw Error('LEASE_LOST');
      return {organizationId:row.organization_id,repositoryId:row.repository_id,runId:row.run_id,installationId:Number(row.installation_id),githubRepositoryId:Number(row.github_repository_id),owner:row.owner,name:row.name,headSha:row.head_sha,snapshot:ReviewSnapshotSchema.parse(row.snapshot)};
    });
  }
  /**
   * Accepts a result for its lease. `onAccepted` runs inside the same transaction, after the lease
   * is marked but before anything commits, so whatever it schedules commits with the acceptance or
   * not at all. Scheduling afterwards, in a separate step, could fail once the acceptance had
   * already committed: the runner's retry would then be a duplicate that schedules nothing, and
   * the review was lost. A duplicate never calls it, because the first acceptance already did.
   */
  async accept(credential:string,input:RunnerResult,onAccepted?:(client:pg.PoolClient,snapshot:ReviewSnapshot)=>Promise<void>):Promise<{duplicate:boolean;snapshot:ReviewSnapshot}>{
    const result=RunnerResultSchema.parse(input);const digest=runnerResultDigest(result);
    return this.db.transaction(async tx=>{
      const runner=await this.authenticated(tx,credential);
      const rows=await tx.query<{state:string;result_hash:string|null;live:boolean;snapshot:ReviewSnapshot}>(`SELECT l.state,l.result_hash,l.expires_at>now() AS live,r.snapshot FROM runner_leases l JOIN review_runs r ON r.id=l.run_id JOIN repositories p ON p.id=l.repository_id JOIN github_installations i ON i.id=p.installation_id WHERE l.id=$1 AND l.run_id=$2 AND l.organization_id=$3 AND l.runner_id=$4 AND l.fence=$5 AND p.enabled AND NOT i.suspended AND NOT i.deleted AND r.state NOT IN ('STALE','CANCELLED','FAILED_FINAL') FOR UPDATE OF l`,[result.leaseId,result.runId,runner.organization_id,runner.id,result.fence]);
      const row=rows.rows[0];if(!row||snapshotDigest(row.snapshot)!==result.snapshotHash)throw Error('LEASE_MISMATCH');
      if(row.state==='RESULT_RECEIVED'){if(row.result_hash!==digest)throw Error('CONFLICTING_RESULT');return {duplicate:true,snapshot:ReviewSnapshotSchema.parse(row.snapshot)};}
      // Liveness is decided by the database clock. Comparing a database timestamp against
      // this process's clock would let a lease the database already expired, and may have
      // reassigned, still be accepted here whenever the two machines disagree.
      if(row.state!=='LEASED'||!row.live)throw Error('LEASE_LOST');
      await tx.query("UPDATE runner_leases SET state='RESULT_RECEIVED',result_hash=$1 WHERE id=$2",[digest,result.leaseId]);
      const snapshot=ReviewSnapshotSchema.parse(row.snapshot);
      if(onAccepted)await onAccepted(tx,snapshot);
      return {duplicate:false,snapshot};
    });
  }
  async revoke(organizationId:string,runnerId:string,client?:Pick<pg.PoolClient,'query'>):Promise<void>{
    const run=async(tx:Pick<pg.PoolClient,'query'>)=>{await tx.query('UPDATE runners SET revoked_at=now() WHERE organization_id=$1 AND id=$2',[organizationId,runnerId]);await tx.query("UPDATE runner_leases SET state='CANCELLED',fence=fence+1 WHERE organization_id=$1 AND runner_id=$2 AND state='LEASED'",[organizationId,runnerId]);};
    // Inside a caller's transaction both statements already commit together.
    if(client)await run(client);else await this.db.transaction(run);
  }
  async fail(credential:string,leaseId:string,fence:number,retryable:boolean):Promise<void>{
    await this.db.transaction(async tx=>{const runner=await this.authenticated(tx,credential);const r=await tx.query("UPDATE runner_leases SET state=CASE WHEN $5 AND attempts<3 THEN 'QUEUED' ELSE 'FAILED_FINAL' END,runner_id=NULL,expires_at=NULL WHERE id=$1 AND organization_id=$2 AND runner_id=$3 AND fence=$4 AND state='LEASED' AND expires_at>now() RETURNING id",[leaseId,runner.organization_id,runner.id,fence,retryable]);if(!r.rowCount)throw Error('LEASE_LOST');});
  }
}
