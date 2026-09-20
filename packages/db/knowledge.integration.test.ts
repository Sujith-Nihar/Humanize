import { beforeAll,afterAll,expect,it } from 'vitest';
import { randomUUID,randomInt } from 'node:crypto';
import { Database,FeedbackStore,LearningStore,RetentionStore,RunStore,migrate } from './src/index.js';
import type { ReviewSnapshot } from '@humanize/domain';

const url=process.env.HUMANIZE_TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('/humanize_test'))throw Error('Disposable test database required');
const db=new Database(url);
const learnings=new LearningStore(db),feedback=new FeedbackStore(db),retention=new RetentionStore(db);
const org=randomUUID(),otherOrg=randomUUID(),repo=randomUUID(),installation=randomInt(1,1000000000);
const scope={organizationId:org,repositoryId:repo};
let runId='';

beforeAll(async()=>{
  await migrate(db);
  for(const id of [org,otherOrg])await db.pool.query('INSERT INTO organizations(id,github_account_id) VALUES($1,$2)',[id,randomInt(1,1000000000)]);
  await db.pool.query('INSERT INTO github_installations(id,organization_id) VALUES($1,$2)',[installation,org]);
  await db.pool.query("INSERT INTO repositories(id,organization_id,installation_id,github_repository_id,owner,name,enabled,retention_mode) VALUES($1,$2,$3,$4,'acme','site',true,'indexed')",[repo,org,installation,randomInt(1,1000000000)]);
  const profile={provider:'ollama' as const,model:'fixture',credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']};
  const snapshot:ReviewSnapshot={version:1,organizationId:org,repositoryId:repo,installationId:installation,owner:'acme',repository:'site',pullNumber:1,baseSha:'a'.repeat(40),headSha:'b'.repeat(40),configSha:'c'.repeat(40),configHash:'config',executionMode:'runner',retentionMode:'indexed',reviewer:profile,verifier:profile,language:'en',allowUnevaluatedLanguage:false};
  runId=await new RunStore(db).create(snapshot,1);
},30000);
afterAll(async()=>db.close());

it('scopes an explicit learning to the paths it names', async () => {
  const id=await learnings.create(scope,{scopeGlobs:['docs/developer/**'],rule:'"AI tool" is approved terminology in developer documentation.',createdBy:'user-1'});
  expect((await learnings.forPath(scope,'docs/developer/setup.md')).map(l=>l.id)).toEqual([id]);
  expect(await learnings.forPath(scope,'app/page.tsx')).toEqual([]);
  await expect(learnings.create(scope,{scopeGlobs:[],rule:'x',createdBy:'u'})).rejects.toThrow('INVALID_LEARNING');
  await expect(learnings.create(scope,{scopeGlobs:['**'],rule:'   ',createdBy:'u'})).rejects.toThrow('INVALID_LEARNING');
});

it('keeps a disabled learning visible but out of effect', async () => {
  const id=await learnings.create(scope,{scopeGlobs:['**/*.md'],rule:'Prefer "pull request" over "PR".',createdBy:'user-1'});
  expect(await learnings.setEnabled(scope,id,false)).toBe(true);
  expect((await learnings.forPath(scope,'README.md')).map(l=>l.id)).not.toContain(id);
  // An administrator can still see what was once decided.
  expect((await learnings.list(scope)).find(l=>l.id===id)).toMatchObject({enabled:false});
  expect(await learnings.remove(scope,id)).toBe(true);
  expect(await learnings.remove(scope,id)).toBe(false);
});

it('refuses to reach a learning through another tenant', async () => {
  const id=await learnings.create(scope,{scopeGlobs:['**'],rule:'Scoped rule.',createdBy:'user-1'});
  const foreign={organizationId:otherOrg,repositoryId:repo};
  expect(await learnings.list(foreign)).toEqual([]);
  expect(await learnings.setEnabled(foreign,id,false)).toBe(false);
  expect(await learnings.remove(foreign,id)).toBe(false);
  await learnings.remove(scope,id);
});

it('records feedback with its provenance, and never turns a dismissal into a rule', async () => {
  const before=(await learnings.list(scope)).length;
  await feedback.record({...scope,runId},{fingerprint:'finding-1',outcome:'dismissed',source:'explicit',actor:'user-1'});
  await feedback.record({...scope,runId},{fingerprint:'finding-2',outcome:'resolved_by_new_commit',source:'inferred'});
  const recorded=await feedback.forRun({organizationId:org,runId});
  expect(recorded).toContainEqual({fingerprint:'finding-1',outcome:'dismissed',source:'explicit',actor:'user-1'});
  // Inferred feedback is marked as such, so nobody mistakes it for a person's judgement.
  expect(recorded.find(r=>r.fingerprint==='finding-2')).toMatchObject({source:'inferred',actor:null});
  // A dismissal creates no permanent rule (spec 25.2).
  expect(await learnings.list(scope)).toHaveLength(before);
  // Repeating the same feedback does not multiply it.
  await feedback.record({...scope,runId},{fingerprint:'finding-1',outcome:'dismissed',source:'explicit',actor:'user-1'});
  expect(await feedback.forRun({organizationId:org,runId})).toHaveLength(2);
});

it('purges retained content when a repository is downgraded to ephemeral', async () => {
  await db.pool.query("INSERT INTO findings(organization_id,repository_id,run_id,fingerprint,category,severity,file_path,start_line,end_line,retention_mode,explanation,replacement) VALUES($1,$2,$3,'fp-1','clarity','minor','a.md',1,1,'indexed','SOURCE_SENTINEL','REPLACEMENT_SENTINEL')",[org,repo,runId]);
  const finding=(await db.pool.query<{id:string}>('SELECT id FROM findings WHERE run_id=$1 LIMIT 1',[runId])).rows[0]!;
  await db.pool.query("INSERT INTO finding_evidence(organization_id,repository_id,finding_id,evidence_id,content_hash,retention_mode,quote) VALUES($1,$2,$3,'ev-1','hash','indexed','QUOTE_SENTINEL')",[org,repo,finding.id]);

  const summary=await retention.setMode(org,repo,'ephemeral');
  expect(summary.findings).toBe(1);
  expect(summary.evidence).toBe(1);
  expect(await retention.mode(org,repo)).toBe('ephemeral');
  const remaining=await db.pool.query('SELECT explanation,replacement FROM findings WHERE run_id=$1',[runId]);
  expect(JSON.stringify(remaining.rows)).not.toContain('SENTINEL');
  const quotes=await db.pool.query('SELECT quote FROM finding_evidence WHERE finding_id=$1',[finding.id]);
  expect(JSON.stringify(quotes.rows)).not.toContain('SENTINEL');
});

it('stops a job queued before the purge from writing the content back', async () => {
  // The repository is ephemeral now, so the constraint refuses content-bearing rows even
  // though the job that attempts this was created while indexed mode was in effect.
  await expect(db.pool.query("INSERT INTO findings(organization_id,repository_id,run_id,fingerprint,category,severity,file_path,start_line,end_line,retention_mode,explanation) VALUES($1,$2,$3,'fp-late','clarity','minor','a.md',1,1,'ephemeral','LATE_SENTINEL')",[org,repo,runId])).rejects.toThrow();
  const rows=await db.pool.query('SELECT explanation FROM findings WHERE run_id=$1',[runId]);
  expect(JSON.stringify(rows.rows)).not.toContain('SENTINEL');
});

it('purges runs older than the retention window, with everything hanging off them', async () => {
  await db.pool.query("UPDATE review_runs SET created_at=now()-interval '400 days' WHERE id=$1",[runId]);
  expect(await retention.purgeOlderThan(org,new Date(Date.now()-365*24*60*60*1000))).toBe(1);
  for(const table of ['review_runs','findings','feedback'] as const){
    const remaining=await db.pool.query(`SELECT 1 FROM ${table} WHERE ${table==='review_runs'?'id':'run_id'}=$1`,[runId]);
    expect(remaining.rowCount).toBe(0);
  }
});
