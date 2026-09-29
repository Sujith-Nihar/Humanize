import { beforeAll,afterAll,expect,it } from 'vitest';
import { randomBytes,randomUUID,randomInt } from 'node:crypto';
import { SecretCipher } from '@humanize/security';
import { AdministrationStore,Database,EncryptedSecretStore,migrate } from './src/index.js';

const url=process.env.HUMANIZE_TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('/humanize_test'))throw Error('Disposable test database required');
const db=new Database(url),store=new AdministrationStore(db);
const secrets=new EncryptedSecretStore(db,new SecretCipher(new Map([['v1',randomBytes(32)]]),'v1'),'bedrock');
const org=randomUUID(),empty=randomUUID(),installation=randomInt(1,1000000000);
const repoA=randomUUID(),repoB=randomUUID();
const everything=async(ids:readonly string[])=>ids;

beforeAll(async()=>{
  await migrate(db);
  for(const id of [org,empty])await db.pool.query('INSERT INTO organizations(id,github_account_id) VALUES($1,$2)',[id,randomInt(1,1000000000)]);
  await db.pool.query('INSERT INTO github_installations(id,organization_id) VALUES($1,$2)',[installation,org]);
  for(const [id,name,on] of [[repoA,'site',true],[repoB,'docs',true]] as const){
    await db.pool.query('INSERT INTO repositories(id,organization_id,installation_id,github_repository_id,owner,name,enabled) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,org,installation,randomInt(1,1000000000),'acme',name,on]);
  }
},30000);
afterAll(async()=>db.close());
const policyOf=async(id:string)=>(await db.pool.query<{policy:unknown}>('SELECT policy FROM organization_policies WHERE organization_id=$1',[id])).rows[0]?.policy;

it('lets someone who administers every enabled repository govern the organization', async () => {
  await store.asOrganizationAdmin(org,everything,client=>store.setPolicy(org,{executionMode:'cloud'},client));
  expect(await policyOf(org)).toEqual({executionMode:'cloud'});
  const id=await store.asOrganizationAdmin(org,everything,client=>secrets.put(org,'bedrock-api-key',client));
  // Written inside the authority transaction, and still only ciphertext at rest.
  expect(await secrets.resolve(org,id)).toBe('bedrock-api-key');
  const raw=(await db.pool.query<{encrypted:unknown}>('SELECT encrypted FROM provider_credentials WHERE id=$1',[id])).rows[0]!.encrypted;
  expect(JSON.stringify(raw)).not.toContain('bedrock-api-key');
  expect((await secrets.list(org)).map(c=>c.id)).toContain(id);
});

it('refuses someone who administers only some of the enabled repositories', async () => {
  // Administering one repository is not authority over policy that governs all of them.
  const partial=async(ids:readonly string[])=>ids.filter(id=>id===repoA);
  await expect(store.asOrganizationAdmin(org,partial,client=>store.setPolicy(org,{executionMode:'runner'},client))).rejects.toThrow('FORBIDDEN');
  expect(await policyOf(org)).toEqual({executionMode:'cloud'});
  await expect(store.asOrganizationAdmin(org,async()=>[],client=>secrets.put(org,'nope',client))).rejects.toThrow('FORBIDDEN');
});

it('refuses every organization-wide write while nothing is enabled', async () => {
  // Nobody has yet shown rights over anything in this organization, so nobody may govern it.
  await expect(store.asOrganizationAdmin(empty,everything,client=>store.setPolicy(empty,{},client))).rejects.toThrow('NO_ENABLED_REPOSITORY');
  expect(await policyOf(empty)).toBeUndefined();
});

it('checks exactly the enabled set, and a write that fails leaves nothing behind', async () => {
  let asked:readonly string[]=[];
  await expect(store.asOrganizationAdmin(org,async ids=>{asked=ids;return ids;},async client=>{
    await secrets.put(org,'half-written',client);
    throw Error('WRITE_FAILED');
  })).rejects.toThrow('WRITE_FAILED');
  expect([...asked]).toEqual([repoA,repoB].sort());
  // The credential was inserted in the same transaction, so it rolled back with it.
  const listed=await db.pool.query('SELECT 1 FROM provider_credentials WHERE organization_id=$1 AND encrypted::text LIKE $2',[org,'%half-written%']);
  expect(listed.rowCount).toBe(0);
});

it('serializes an organization-wide write against a change to the enabled set', async () => {
  // Without the authority lock, enabling a new repository mid-check would let a policy be set
  // by someone who never administered that repository. With it, the enablement waits.
  const repoC=randomUUID();
  await db.pool.query('INSERT INTO repositories(id,organization_id,installation_id,github_repository_id,owner,name,enabled) VALUES($1,$2,$3,$4,$5,$6,false)',[repoC,org,installation,randomInt(1,1000000000),'acme','blog']);
  const order:string[]=[];
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  let entered!:()=>void;const inside=new Promise<void>(resolve=>{entered=resolve;});
  const write=store.asOrganizationAdmin(org,async ids=>{order.push(`check:${ids.length}`);entered();await held;return ids;},
    async client=>{order.push('policy');await store.setPolicy(org,{executionMode:'cloud',n:2},client);});
  await inside;
  const enable=store.setEnabled(org,[repoC],true,async ids=>{order.push('enable');return ids;});
  // Give the enablement every chance to overtake; it must still be waiting on the lock.
  await new Promise(resolve=>setTimeout(resolve,200));
  expect(order).toEqual(['check:2']);
  release();
  await write;await enable;
  expect(order).toEqual(['check:2','policy','enable']);
  // And the next organization-wide write now has to answer for the third repository too.
  const twoOnly=async(ids:readonly string[])=>ids.filter(id=>id!==repoC);
  await expect(store.asOrganizationAdmin(org,twoOnly,client=>store.setPolicy(org,{},client))).rejects.toThrow('FORBIDDEN');
});
