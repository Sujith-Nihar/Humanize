import { beforeAll,afterAll,expect,it,vi } from 'vitest';
import { randomUUID,randomInt } from 'node:crypto';
import { AdministrationStore,Database,migrate } from './src/index.js';

const url=process.env.HUMANIZE_TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('/humanize_test'))throw Error('Disposable test database required');
const db=new Database(url),store=new AdministrationStore(db);
const org=randomUUID(),otherOrg=randomUUID(),installation=randomInt(1,1000000000);
const repoA=randomUUID(),repoB=randomUUID(),foreign=randomUUID();

beforeAll(async()=>{
  await migrate(db);
  for(const [id,install] of [[org,installation],[otherOrg,randomInt(1,1000000000)]] as const){
    await db.pool.query('INSERT INTO organizations(id,github_account_id) VALUES($1,$2)',[id,randomInt(1,1000000000)]);
    await db.pool.query('INSERT INTO github_installations(id,organization_id) VALUES($1,$2)',[install,id]);
  }
  const otherInstall=(await db.pool.query<{id:string}>('SELECT id FROM github_installations WHERE organization_id=$1',[otherOrg])).rows[0]!.id;
  for(const [id,owner,name] of [[repoA,'acme','site'],[repoB,'acme','docs']] as const){
    await db.pool.query('INSERT INTO repositories(id,organization_id,installation_id,github_repository_id,owner,name) VALUES($1,$2,$3,$4,$5,$6)',[id,org,installation,randomInt(1,1000000000),owner,name]);
  }
  await db.pool.query('INSERT INTO repositories(id,organization_id,installation_id,github_repository_id,owner,name) VALUES($1,$2,$3,$4,$5,$6)',[foreign,otherOrg,Number(otherInstall),randomInt(1,1000000000),'other','repo']);
},30000);
afterAll(async()=>db.close());
const enabled=async(id:string)=>(await db.pool.query<{enabled:boolean}>('SELECT enabled FROM repositories WHERE id=$1',[id])).rows[0]!.enabled;

it('lists only the repositories of the organization asked about', async () => {
  const listed=await store.repositories(org);
  expect(listed.map(r=>r.name).sort()).toEqual(['docs','site']);
  expect(listed.every(r=>r.enabled===false)).toBe(true);
  expect(await store.repositories(otherOrg)).toHaveLength(1);
});

it('enables only what the caller administers, checked while the rows are held', async () => {
  const check=vi.fn(async(ids:readonly string[])=>ids.filter(id=>id===repoA));
  expect(await store.setEnabled(org,[repoA,repoB],true,check)).toEqual([repoA]);
  // The check runs inside the transaction, against the rows actually locked.
  expect(check).toHaveBeenCalledWith([repoA,repoB].sort());
  expect(await enabled(repoA)).toBe(true);
  expect(await enabled(repoB)).toBe(false);
});

it('never enables a repository when rights were revoked before the write', async () => {
  // A check taken beforehand describes rights the caller had a moment ago; this one answers
  // at write time, so a revocation that lands first wins.
  expect(await store.setEnabled(org,[repoB],true,async()=>[])).toEqual([]);
  expect(await enabled(repoB)).toBe(false);
});

it('serializes concurrent enablement rather than interleaving it', async () => {
  let active=0,overlapped=false;
  const check=async(ids:readonly string[])=>{
    active++;
    if(active>1)overlapped=true;
    await new Promise(resolve=>setTimeout(resolve,30));
    active--;
    return ids;
  };
  await Promise.all([store.setEnabled(org,[repoB],true,check),store.setEnabled(org,[repoB],false,check)]);
  // Row locks keep the two checks apart, so neither decides against a state the other changed.
  expect(overlapped).toBe(false);
});

it('cannot reach a repository belonging to another organization', async () => {
  const check=vi.fn(async(ids:readonly string[])=>ids);
  expect(await store.setEnabled(org,[foreign],true,check)).toEqual([]);
  // The foreign row is never even offered to the check.
  expect(check).not.toHaveBeenCalled();
  expect(await enabled(foreign)).toBe(false);
});

it('stores administrator policy separately from repository configuration', async () => {
  expect(await store.policy(org)).toBeNull();
  await store.setPolicy(org,{executionMode:'runner',retentionMode:'ephemeral'});
  expect(await store.policy(org)).toMatchObject({executionMode:'runner'});
  await store.setPolicy(org,{executionMode:'cloud',retentionMode:'indexed'});
  expect(await store.policy(org)).toMatchObject({executionMode:'cloud'});
  const version=await db.pool.query<{version:number}>('SELECT version FROM organization_policies WHERE organization_id=$1',[org]);
  expect(version.rows[0]!.version).toBe(2);
  expect(await store.policy(otherOrg)).toBeNull();
});
