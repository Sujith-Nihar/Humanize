import { randomUUID,randomInt,randomBytes } from 'node:crypto';
import { beforeAll,afterAll,expect,it } from 'vitest';
import { Database,migrate,EncryptedSecretStore,RunStore } from './src/index.js';
import { organizations,installations,repositories,reviewRuns } from './src/schema.js';
import { SecretCipher } from '@humanize/security';
import { JobQueue } from '../queue/src/index.js';
import type { ReviewSnapshot } from '@humanize/domain';

const url=process.env.HUMANIZE_TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('/humanize_test'))throw Error('Set HUMANIZE_TEST_DATABASE_URL to a disposable humanize_test database; integration tests are not silently skipped.');
const db=new Database(url);const queue=new JobQueue(url);
const org=randomUUID(),otherOrg=randomUUID(),repo=randomUUID(),installation=randomInt(1,1000000000);
beforeAll(async()=>{
  await migrate(db);await migrate(db);await queue.start();
  await db.orm.insert(organizations).values([{id:org,githubAccountId:randomInt(1,1000000000)},{id:otherOrg,githubAccountId:randomInt(1,1000000000)}]);
  await db.orm.insert(installations).values({id:installation,organizationId:org});
  await db.orm.insert(repositories).values({id:repo,organizationId:org,installationId:installation,githubRepositoryId:randomInt(1,1000000000),owner:'fixture',name:'fixture',enabled:true});
},30000);
afterAll(async()=>{await queue.stop();await db.close();});

it('enforces composite tenant relationships at the database boundary',async()=>{
  await expect(db.orm.insert(repositories).values({organizationId:otherOrg,installationId:installation,githubRepositoryId:randomInt(1,1000000000),owner:'fixture',name:'wrong'})).rejects.toThrow();
});
it('rolls back event and enqueue as one transaction',async()=>{
  const delivery=randomUUID();
  await expect(db.transaction(async tx=>{
    await tx.query('INSERT INTO webhook_deliveries(delivery_id,organization_id,event_type,action) VALUES($1,$2,$3,$4)',[delivery,org,'pull_request','opened']);
    await queue.send('pull_request.review',{version:1,organizationId:org,repositoryId:repo,traceId:delivery,idempotencyKey:delivery},tx);
    throw Error('rollback fixture');
  })).rejects.toThrow('rollback fixture');
  expect((await db.pool.query('SELECT 1 FROM webhook_deliveries WHERE delivery_id=$1',[delivery])).rowCount).toBe(0);
  expect((await db.pool.query('SELECT 1 FROM pgboss.job WHERE singleton_key=$1',[delivery])).rowCount).toBe(0);
});
it('stores encrypted secrets with tenant separation and revocation',async()=>{
  const store=new EncryptedSecretStore(db,new SecretCipher(new Map([['v1',randomBytes(32)]]),'v1'),'openai');
  const id=await store.put(org,'SECRET_SENTINEL');expect(await store.resolve(org,id)).toBe('SECRET_SENTINEL');
  await expect(store.resolve(otherOrg,id)).rejects.toThrow('SECRET_UNAVAILABLE');
  const raw=await db.pool.query('SELECT encrypted FROM provider_credentials WHERE id=$1',[id]);expect(JSON.stringify(raw.rows)).not.toContain('SECRET_SENTINEL');
  await store.revoke(org,id);await expect(store.resolve(org,id)).rejects.toThrow();
});
it('deduplicates runs and rejects stale state transitions',async()=>{
  const profile={provider:'ollama' as const,model:'fixture',credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']};
  const snapshot:ReviewSnapshot={version:1,organizationId:org,repositoryId:repo,installationId:installation,owner:'fixture',repository:'fixture',pullNumber:1,baseSha:'a'.repeat(40),headSha:'b'.repeat(40),configSha:'a'.repeat(40),configHash:'config',executionMode:'runner',retentionMode:'ephemeral',reviewer:profile,verifier:profile,language:'en',allowUnevaluatedLanguage:false};
  const store=new RunStore(db);const ids=await Promise.all([store.create(snapshot,1),store.create(snapshot,1)]);expect(ids[0]).toBe(ids[1]);
  const scope={organizationId:org,repositoryId:repo,runId:ids[0]!};
  const outcomes=await Promise.allSettled([store.transition(scope,'RECEIVED','QUEUED',0),store.transition(scope,'RECEIVED','QUEUED',0)]);
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  await expect(store.transition({...scope,organizationId:otherOrg},'QUEUED','ACQUIRING_REPO',0)).rejects.toThrow('STALE_TRANSITION');
  expect((await db.orm.select().from(reviewRuns)).length).toBeGreaterThan(0);
});
it('rejects content-bearing findings in ephemeral mode at the database boundary',async()=>{
  const run=(await db.pool.query<{id:string}>('SELECT id FROM review_runs WHERE organization_id=$1 LIMIT 1',[org])).rows[0]!;
  await expect(db.pool.query('INSERT INTO findings(organization_id,repository_id,run_id,fingerprint,category,severity,file_path,start_line,end_line,retention_mode,explanation) VALUES($1,$2,$3,$4,$5,$6,$7,1,1,$8,$9)',[org,repo,run.id,randomUUID(),'clarity','minor','a.md','ephemeral','SOURCE_SENTINEL'])).rejects.toThrow();
});
