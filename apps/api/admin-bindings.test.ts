import { expect,it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SecretCipher } from '@humanize/security';
import { resolveAdmin } from './src/admin-bindings.js';

const cipher=new SecretCipher(new Map([['v1',randomBytes(32)]]),'v1');
const complete={
  HUMANIZE_SESSION_KEY:randomBytes(32).toString('base64'),
  GITHUB_OAUTH_CLIENT_ID:'Iv1.client',GITHUB_OAUTH_CLIENT_SECRET:'secret',
};
// Nothing is queried while binding, so these are never touched by these cases.
const unused={} as never;

it('names every missing variable instead of registering a partial surface', () => {
  const resolved=resolveAdmin({},unused,unused,unused,undefined);
  expect(resolved.options).toBeUndefined();
  expect('missing' in resolved&&resolved.missing).toEqual(
    ['HUMANIZE_SESSION_KEY','GITHUB_OAUTH_CLIENT_ID','GITHUB_OAUTH_CLIENT_SECRET','HUMANIZE_ENCRYPTION_KEYS']);
});

it('refuses to store credentials without keys to encrypt them', () => {
  // Storing a provider secret unencrypted is not an available fallback.
  const resolved=resolveAdmin(complete,unused,unused,unused,undefined);
  expect('missing' in resolved&&resolved.missing).toEqual(['HUMANIZE_ENCRYPTION_KEYS']);
});

it('binds every administration port once fully configured', () => {
  const resolved=resolveAdmin(complete,unused,unused,unused,cipher);
  expect(resolved.options?.repositories).toBeDefined();
  expect(resolved.options?.runnerAdmin).toBeDefined();
  expect(resolved.options?.identity.authorizeUrl('s')).toContain('client_id=Iv1.client');
});

it('refuses a session key too short to sign with', () => {
  expect(()=>resolveAdmin({...complete,HUMANIZE_SESSION_KEY:randomBytes(16).toString('base64')},unused,unused,unused,cipher)).toThrow('WEAK_SESSION_KEY');
});
