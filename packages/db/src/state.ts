import { and,eq } from 'drizzle-orm';
import { canTransition,RunStateSchema,ReviewSnapshotSchema } from '@humanize/domain';
import type { RunState,ReviewSnapshot,ValidatedFinding,SecretStore } from '@humanize/domain';
import { SecretCipher } from '@humanize/security';
import { randomUUID } from 'node:crypto';
import { Database } from './database.js';
import { reviewRuns,findings,providerCredentials } from './schema.js';

export class RunStore {
  constructor(private readonly db:Database){}
  async create(snapshot:ReviewSnapshot,generation:number):Promise<string> {
    const s=ReviewSnapshotSchema.parse(snapshot);
    const values={organizationId:s.organizationId,repositoryId:s.repositoryId,pullNumber:s.pullNumber,headSha:s.headSha,configHash:s.configHash,generation,state:'RECEIVED',retentionMode:s.retentionMode,snapshot:s};
    const inserted=await this.db.orm.insert(reviewRuns).values(values).onConflictDoNothing().returning({id:reviewRuns.id});
    if(inserted[0])return inserted[0].id;
    const [existing]=await this.db.orm.select({id:reviewRuns.id}).from(reviewRuns).where(and(eq(reviewRuns.organizationId,s.organizationId),eq(reviewRuns.repositoryId,s.repositoryId),eq(reviewRuns.pullNumber,s.pullNumber),eq(reviewRuns.headSha,s.headSha),eq(reviewRuns.configHash,s.configHash),eq(reviewRuns.generation,generation)));
    if(!existing)throw Error('RUN_CONFLICT');return existing.id;
  }
  async transition(scope:{organizationId:string;repositoryId:string;runId:string},from:RunState,to:RunState,attempt:number):Promise<void> {
    RunStateSchema.parse(from);RunStateSchema.parse(to);if(!canTransition(from,to))throw Error('INVALID_TRANSITION');
    const rows=await this.db.orm.update(reviewRuns).set({state:to,updatedAt:new Date(),...(from==='FAILED_RETRYABLE'?{attempt:attempt+1}:{})}).where(and(eq(reviewRuns.organizationId,scope.organizationId),eq(reviewRuns.repositoryId,scope.repositoryId),eq(reviewRuns.id,scope.runId),eq(reviewRuns.state,from),eq(reviewRuns.attempt,attempt))).returning({id:reviewRuns.id});
    if(rows.length!==1)throw Error('STALE_TRANSITION');
  }
  async storeFindings(scope:{organizationId:string;repositoryId:string;runId:string},items:ValidatedFinding[]):Promise<void> {
    await this.db.orm.transaction(async tx=>{
      const [run]=await tx.select().from(reviewRuns).where(and(eq(reviewRuns.id,scope.runId),eq(reviewRuns.organizationId,scope.organizationId),eq(reviewRuns.repositoryId,scope.repositoryId))).for('update');
      if(!run||!['VERIFYING','READY_TO_PUBLISH'].includes(run.state))throw Error('RUN_NOT_WRITABLE');
      for(const item of items)await tx.insert(findings).values({...scope,fingerprint:item.fingerprint,category:item.category,severity:item.severity,filePath:item.node.filePath,startLine:item.node.startLine,endLine:item.node.endLine,retentionMode:run.retentionMode,explanation:run.retentionMode==='indexed'?item.explanation:null,replacement:run.retentionMode==='indexed'?item.replacement:null}).onConflictDoNothing();
    });
  }
}

export class EncryptedSecretStore implements SecretStore {
  constructor(private readonly db:Database,private readonly cipher:SecretCipher,private readonly provider:string){}
  async put(organizationId:string,plaintext:string):Promise<string> {
    const id=randomUUID();await this.db.orm.insert(providerCredentials).values({id,organizationId,provider:this.provider,encrypted:this.cipher.encrypt(organizationId,id,plaintext)});return id;
  }
  async resolve(organizationId:string,reference:string):Promise<string> {
    const [row]=await this.db.orm.select().from(providerCredentials).where(and(eq(providerCredentials.organizationId,organizationId),eq(providerCredentials.id,reference)));
    if(!row||row.revokedAt||row.provider!==this.provider)throw Error('SECRET_UNAVAILABLE');return this.cipher.decrypt(organizationId,reference,row.encrypted);
  }
  async revoke(organizationId:string,reference:string):Promise<void> {await this.db.orm.update(providerCredentials).set({revokedAt:new Date()}).where(and(eq(providerCredentials.organizationId,organizationId),eq(providerCredentials.id,reference)));}
}
