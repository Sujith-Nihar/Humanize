import { randomBytes } from 'node:crypto';
import { expect,it } from 'vitest';
import { SecretCipher,SessionSigner,requireOrganization,requireRepositoryAdmin } from './src/index.js';

it('binds ciphertext to tenant and reference and supports key rotation',()=>{
  const keys=new Map([['v1',randomBytes(32)],['v2',randomBytes(32)]]);
  const old=new SecretCipher(keys,'v1'),next=new SecretCipher(keys,'v2');const secret=old.encrypt('a','id','SECRET_SENTINEL');
  expect(JSON.stringify(secret)).not.toContain('SECRET_SENTINEL');expect(next.decrypt('a','id',secret)).toBe('SECRET_SENTINEL');
  expect(()=>old.decrypt('b','id',secret)).toThrow('SECRET_UNAVAILABLE');expect(()=>old.decrypt('a','other',secret)).toThrow();
  const rotated=next.encrypt('a','id',next.decrypt('a','id',secret));expect(rotated.keyVersion).toBe('v2');
});
it('requires admin on a nonempty enabled set for organization writes',()=>{
  expect(()=>requireRepositoryAdmin([],new Set())).toThrow();
  expect(()=>requireRepositoryAdmin(['a','b'],new Set(['a']))).toThrow();
  expect(()=>requireRepositoryAdmin(['a','b'],new Set(['a','b']))).not.toThrow();
});

it('issues a session that cannot be forged, altered or outlived', () => {
  const signer=new SessionSigner(randomBytes(32));
  const token=signer.issue('user-1',['org-a','org-b']);
  expect(signer.verify(token)).toMatchObject({userId:'user-1',organizationIds:['org-a','org-b']});

  // Altering the claims invalidates the signature, so privileges cannot be self-granted.
  const [body,signature]=token.split('.');
  const forged=Buffer.from(JSON.stringify({userId:'user-1',organizationIds:['org-victim'],expiresAt:Date.now()+1000}),'utf8').toString('base64url');
  expect(signer.verify(`${forged}.${signature!}`)).toBeNull();
  expect(signer.verify(`${body!}.${'a'.repeat(43)}`)).toBeNull();
  expect(signer.verify(undefined)).toBeNull();
  expect(signer.verify('not-a-token')).toBeNull();

  // A session from another deployment key is not a session here.
  expect(new SessionSigner(randomBytes(32)).verify(token)).toBeNull();
  // Expiry is enforced on read, not merely recorded.
  expect(signer.verify(token,Date.now()+13*60*60*1000)).toBeNull();
  expect(()=>new SessionSigner(randomBytes(16))).toThrow('WEAK_SESSION_KEY');
});

it('refuses to act on an organization the session does not belong to', () => {
  const signer=new SessionSigner(randomBytes(32));
  const claims=signer.verify(signer.issue('user-1',['org-a']));
  expect(requireOrganization(claims,'org-a')).toMatchObject({userId:'user-1'});
  expect(()=>requireOrganization(claims,'org-b')).toThrow('FORBIDDEN');
  expect(()=>requireOrganization(null,'org-a')).toThrow('FORBIDDEN');
});
