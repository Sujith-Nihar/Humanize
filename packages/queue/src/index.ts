import { PgBoss } from 'pg-boss';
import { JobType,JobPayloadSchema } from '@humanize/domain';
import type { JobPayload } from '@humanize/domain';

export interface TransactionConnection {query(text:string,values:unknown[]):Promise<{rows:unknown[]}>;}
export class JobQueue {
  readonly boss:PgBoss;
  constructor(connectionString:string){this.boss=new PgBoss({connectionString,schema:'pgboss',application_name:'humanize-queue'});}
  async start():Promise<void> {
    await this.boss.start();
    for(const name of JobType.options){
      await this.boss.createQueue(`${name}.dead`,{retryLimit:0});
      await this.boss.createQueue(name,{retryLimit:2,retryDelay:5,retryBackoff:true,expireInSeconds:1800,deleteAfterSeconds:86400,deadLetter:`${name}.dead`});
    }
  }
  async send(name:string,payload:JobPayload,tx?:TransactionConnection):Promise<string|null> {
    JobType.parse(name);const data=JobPayloadSchema.parse(payload);
    return this.boss.send(name,data,{singletonKey:data.idempotencyKey,...(tx?{db:{executeSql:(sql:string,values:unknown[])=>tx.query(sql,values)}}:{})});
  }
  async work(name:string,handler:(payload:JobPayload,jobId:string)=>Promise<void>):Promise<void> {
    JobType.parse(name);
    await this.boss.work<JobPayload>(name,{batchSize:1},async jobs=>{for(const job of jobs)await handler(JobPayloadSchema.parse(job.data),job.id);});
  }
  async stop():Promise<void>{await this.boss.stop({graceful:true,timeout:10000});}
}
