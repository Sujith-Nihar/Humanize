import type { Database } from '@humanize/db';
import type { JobQueue } from '@humanize/queue';
import { GitHubEventSchema } from '@humanize/domain';
import type { GitHubEvent } from '@humanize/domain';
import type { WebhookSink } from './app.js';

export class DurableWebhookSink implements WebhookSink {
  constructor(private readonly db:Database,private readonly queue:JobQueue){}
  async ingest(deliveryId:string,event:GitHubEvent):Promise<boolean> {
    const value=GitHubEventSchema.parse(event);
    return this.db.transaction(async tx=>{
      const organization=await tx.query<{id:string}>('INSERT INTO organizations(github_account_id) VALUES($1) ON CONFLICT(github_account_id) DO UPDATE SET github_account_id=EXCLUDED.github_account_id RETURNING id',[value.accountId]);
      const organizationId=organization.rows[0]!.id;
      const delivery=await tx.query('INSERT INTO webhook_deliveries(delivery_id,organization_id,event_type,action,metadata) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING delivery_id',[deliveryId,organizationId,value.event,value.action,JSON.stringify(value)]);
      if(!delivery.rowCount)return false;
      await this.queue.send('github.event',{version:1,organizationId,repositoryId:value.repository?`github:${value.repository.githubId}`:`installation:${value.installationId}`,traceId:deliveryId,idempotencyKey:deliveryId},tx);
      return true;
    });
  }
}
