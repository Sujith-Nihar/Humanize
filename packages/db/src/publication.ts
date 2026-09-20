import { and,eq,lt } from 'drizzle-orm';
import type { Database } from './database.js';
import { publicationPayloads } from './schema.js';

export interface PublicationRecord { runId:string; organizationId:string; repositoryId:string; retentionMode:string; payload:unknown; }

/** How long an unpublished payload may survive a crash before the sweep removes it. */
export const PUBLICATION_TTL_MS=60*60*1000;

/**
 * Holds a validated result only until it is published (ADR-038). Ephemeral retention promises
 * that no content survives the job, not that content never reaches storage, so the guarantee
 * enforced here is a lifetime one: the row is deleted on completion, on abandonment, and by a
 * sweep if a crash left it behind.
 */
export class PublicationStore {
  constructor(private readonly db:Database){}

  async put(record:PublicationRecord,ttlMs=PUBLICATION_TTL_MS):Promise<void> {
    const values={organizationId:record.organizationId,repositoryId:record.repositoryId,runId:record.runId,
      retentionMode:record.retentionMode,payload:record.payload,expiresAt:new Date(Date.now()+ttlMs)};
    await this.db.orm.insert(publicationPayloads).values(values)
      .onConflictDoUpdate({target:publicationPayloads.runId,set:{payload:values.payload,expiresAt:values.expiresAt}});
  }

  async take(organizationId:string,runId:string):Promise<PublicationRecord|null> {
    const [row]=await this.db.orm.select().from(publicationPayloads)
      .where(and(eq(publicationPayloads.organizationId,organizationId),eq(publicationPayloads.runId,runId)));
    return row?{runId:row.runId,organizationId:row.organizationId,repositoryId:row.repositoryId,retentionMode:row.retentionMode,payload:row.payload}:null;
  }

  /** Called on success and on abandonment alike: an unpublishable payload is still content. */
  async discard(organizationId:string,runId:string):Promise<void> {
    await this.db.orm.delete(publicationPayloads)
      .where(and(eq(publicationPayloads.organizationId,organizationId),eq(publicationPayloads.runId,runId)));
  }

  async sweep(now=new Date()):Promise<number> {
    const removed=await this.db.orm.delete(publicationPayloads).where(lt(publicationPayloads.expiresAt,now)).returning({runId:publicationPayloads.runId});
    return removed.length;
  }
}
