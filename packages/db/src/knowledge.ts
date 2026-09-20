import { and, desc, eq } from 'drizzle-orm';
import picomatch from 'picomatch';
import type { Database } from './database.js';
import { explicitLearnings, feedback, repositories } from './schema.js';

export interface Learning { id: string; scopeGlobs: string[]; rule: string; enabled: boolean; createdBy: string }
export type FeedbackOutcome = 'accepted_suggestion' | 'dismissed' | 'manual_fix' | 'false_positive' | 'intentional_wording' | 'resolved_by_new_commit' | 'outdated';

/**
 * Explicit project knowledge, scoped to paths. This is the only automatic memory the product
 * has: an administrator writes a rule down deliberately, and nothing the reviewer observes
 * ever becomes one on its own (spec 25).
 */
export class LearningStore {
  constructor(private readonly db: Database) {}

  async create(scope: { organizationId: string; repositoryId: string }, input: { scopeGlobs: string[]; rule: string; createdBy: string }): Promise<string> {
    if (!input.scopeGlobs.length || !input.rule.trim()) throw Error('INVALID_LEARNING');
    const [row] = await this.db.orm.insert(explicitLearnings)
      .values({ ...scope, scopeGlobs: input.scopeGlobs, rule: input.rule.trim(), createdBy: input.createdBy })
      .returning({ id: explicitLearnings.id });
    return row!.id;
  }

  async list(scope: { organizationId: string; repositoryId: string }): Promise<Learning[]> {
    const rows = await this.db.orm.select().from(explicitLearnings)
      .where(and(eq(explicitLearnings.organizationId, scope.organizationId), eq(explicitLearnings.repositoryId, scope.repositoryId)))
      .orderBy(desc(explicitLearnings.createdAt));
    return rows.map(row => ({ id: row.id, scopeGlobs: row.scopeGlobs, rule: row.rule, enabled: row.enabled, createdBy: row.createdBy }));
  }

  /** A disabled learning is kept, so an administrator can see what was once decided. */
  async setEnabled(scope: { organizationId: string; repositoryId: string }, id: string, enabled: boolean): Promise<boolean> {
    const rows = await this.db.orm.update(explicitLearnings).set({ enabled, updatedAt: new Date() })
      .where(and(eq(explicitLearnings.organizationId, scope.organizationId), eq(explicitLearnings.repositoryId, scope.repositoryId), eq(explicitLearnings.id, id)))
      .returning({ id: explicitLearnings.id });
    return rows.length === 1;
  }

  async remove(scope: { organizationId: string; repositoryId: string }, id: string): Promise<boolean> {
    const rows = await this.db.orm.delete(explicitLearnings)
      .where(and(eq(explicitLearnings.organizationId, scope.organizationId), eq(explicitLearnings.repositoryId, scope.repositoryId), eq(explicitLearnings.id, id)))
      .returning({ id: explicitLearnings.id });
    return rows.length === 1;
  }

  /** The learnings that apply to one file, for the configuration precedence chain. */
  async forPath(scope: { organizationId: string; repositoryId: string }, filePath: string): Promise<Learning[]> {
    const all = await this.list(scope);
    return all.filter(learning => learning.enabled && learning.scopeGlobs.some(glob => picomatch.isMatch(filePath, glob, { dot: true })));
  }
}

/**
 * Records what happened to a published finding. Feedback informs evaluation and later
 * ranking, but a dismissal is never promoted to a rule here: the specification is explicit
 * that a single dismissal must not become permanent, so turning one into a learning stays a
 * deliberate administrator action through LearningStore.
 */
export class FeedbackStore {
  constructor(private readonly db: Database) {}

  async record(scope: { organizationId: string; repositoryId: string; runId: string }, input: { fingerprint: string; outcome: FeedbackOutcome; source: 'explicit' | 'inferred'; actor?: string }): Promise<void> {
    await this.db.orm.insert(feedback)
      .values({ ...scope, fingerprint: input.fingerprint, outcome: input.outcome, source: input.source, actor: input.actor ?? null })
      .onConflictDoNothing();
  }

  async forRun(scope: { organizationId: string; runId: string }): Promise<{ fingerprint: string; outcome: string; source: string; actor: string | null }[]> {
    const rows = await this.db.orm.select().from(feedback)
      .where(and(eq(feedback.organizationId, scope.organizationId), eq(feedback.runId, scope.runId)));
    // Provenance travels with the record: who said it, and whether anyone said it at all.
    return rows.map(row => ({ fingerprint: row.fingerprint, outcome: row.outcome, source: row.source, actor: row.actor }));
  }
}

export interface PurgeSummary { findings: number; evidence: number; payloads: number }

/**
 * Retention transitions and purge. Downgrading to ephemeral must remove the content indexed
 * mode was allowed to keep, and a job queued before the purge must not be able to write it
 * back: the repository's retention mode is changed first, in the same transaction, so any
 * later write is rejected by the column constraints that enforce ephemeral storage.
 */
export class RetentionStore {
  constructor(private readonly db: Database) {}

  async setMode(organizationId: string, repositoryId: string, mode: 'ephemeral' | 'indexed'): Promise<PurgeSummary> {
    return this.db.transaction(async tx => {
      await tx.query('UPDATE repositories SET retention_mode=$3 WHERE organization_id=$1 AND id=$2', [organizationId, repositoryId, mode]);
      if (mode !== 'ephemeral') return { findings: 0, evidence: 0, payloads: 0 };
      // Content first, then the rows that point at it, so nothing is orphaned mid-purge.
      const evidence = await tx.query(
        `UPDATE finding_evidence SET quote=NULL, retention_mode='ephemeral'
         WHERE organization_id=$1 AND repository_id=$2 AND (quote IS NOT NULL OR retention_mode<>'ephemeral')`, [organizationId, repositoryId]);
      const purged = await tx.query(
        `UPDATE findings SET explanation=NULL, replacement=NULL, retention_mode='ephemeral'
         WHERE organization_id=$1 AND repository_id=$2 AND (explanation IS NOT NULL OR replacement IS NOT NULL OR retention_mode<>'ephemeral')`, [organizationId, repositoryId]);
      const payloads = await tx.query('DELETE FROM publication_payloads WHERE organization_id=$1 AND repository_id=$2', [organizationId, repositoryId]);
      await tx.query("UPDATE review_runs SET retention_mode='ephemeral' WHERE organization_id=$1 AND repository_id=$2", [organizationId, repositoryId]);
      return { findings: purged.rowCount ?? 0, evidence: evidence.rowCount ?? 0, payloads: payloads.rowCount ?? 0 };
    });
  }

  async mode(organizationId: string, repositoryId: string): Promise<string | null> {
    const [row] = await this.db.orm.select({ mode: repositories.retentionMode }).from(repositories)
      .where(and(eq(repositories.organizationId, organizationId), eq(repositories.id, repositoryId)));
    return row?.mode ?? null;
  }

  /** Removes runs and everything hanging off them once they are older than the window. */
  async purgeOlderThan(organizationId: string, cutoff: Date): Promise<number> {
    return this.db.transaction(async tx => {
      const runs = await tx.query<{ id: string }>(
        'SELECT id FROM review_runs WHERE organization_id=$1 AND created_at < $2', [organizationId, cutoff]);
      const ids = runs.rows.map(row => row.id);
      if (!ids.length) return 0;
      for (const table of ['publication_payloads', 'feedback', 'published_comments', 'publication_attempts']) {
        await tx.query(`DELETE FROM ${table} WHERE organization_id=$1 AND run_id=ANY($2::uuid[])`, [organizationId, ids]);
      }
      await tx.query('DELETE FROM finding_evidence WHERE organization_id=$1 AND finding_id IN (SELECT id FROM findings WHERE run_id=ANY($2::uuid[]))', [organizationId, ids]);
      await tx.query('DELETE FROM findings WHERE organization_id=$1 AND run_id=ANY($2::uuid[])', [organizationId, ids]);
      await tx.query('DELETE FROM runner_leases WHERE organization_id=$1 AND run_id=ANY($2::uuid[])', [organizationId, ids]);
      await tx.query('DELETE FROM review_runs WHERE organization_id=$1 AND id=ANY($2::uuid[])', [organizationId, ids]);
      return ids.length;
    });
  }
}
