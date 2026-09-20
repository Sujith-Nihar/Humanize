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
  async enrollment(organizationId:string,repositoryIds:string[]):Promise<string>{
    if(!repositoryIds.length||new Set(repositoryIds).size!==repositoryIds.length)throw Error('INVALID_SCOPE');
    return this.db.transaction(async tx=>{
      const repos=await tx.query('SELECT id FROM repositories WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND enabled=true FOR SHARE',[organizationId,repositoryIds]);
      if(repos.rowCount!==repositoryIds.length)throw Error('INVALID_SCOPE');
      const token=opaqueToken();await tx.query("INSERT INTO runner_enrollments(organization_id,token_hash,repository_ids,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",[organizationId,tokenHash(token),repositoryIds]);return token;
    });
  }
  async register(token:string,capabilities:RunnerCapabilities):Promise<{runnerId:string;credential:string}>{
    const caps=RunnerCapabilitiesSchema.parse(capabilities);
    return this.db.transaction(async tx=>{
      const enrollment=await tx.query<{organization_id:string;repository_ids:string[]}>('UPDATE runner_enrollments SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING organization_id,repository_ids',[tokenHash(token)]);
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
  async accept(credential:string,input:RunnerResult):Promise<{duplicate:boolean;snapshot:ReviewSnapshot}>{
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
      return {duplicate:false,snapshot:ReviewSnapshotSchema.parse(row.snapshot)};
    });
  }
  async revoke(organizationId:string,runnerId:string):Promise<void>{
    await this.db.transaction(async tx=>{await tx.query('UPDATE runners SET revoked_at=now() WHERE organization_id=$1 AND id=$2',[organizationId,runnerId]);await tx.query("UPDATE runner_leases SET state='CANCELLED',fence=fence+1 WHERE organization_id=$1 AND runner_id=$2 AND state='LEASED'",[organizationId,runnerId]);});
  }
  async fail(credential:string,leaseId:string,fence:number,retryable:boolean):Promise<void>{
    await this.db.transaction(async tx=>{const runner=await this.authenticated(tx,credential);const r=await tx.query("UPDATE runner_leases SET state=CASE WHEN $5 AND attempts<3 THEN 'QUEUED' ELSE 'FAILED_FINAL' END,runner_id=NULL,expires_at=NULL WHERE id=$1 AND organization_id=$2 AND runner_id=$3 AND fence=$4 AND state='LEASED' AND expires_at>now() RETURNING id",[leaseId,runner.organization_id,runner.id,fence,retryable]);if(!r.rowCount)throw Error('LEASE_LOST');});
  }
}
