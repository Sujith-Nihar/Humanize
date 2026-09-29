import { expect,it } from 'vitest';
import { cipherFromEnvironment } from './src/index.js';
import { randomBytes } from 'node:crypto';

const key=(): string=>randomBytes(32).toString('base64');

it('reports no cipher when no keys are configured', () => {
  // A deployment without keys must start and say which capability is unavailable.
  expect(cipherFromEnvironment({})).toBeUndefined();
  expect(cipherFromEnvironment({HUMANIZE_ENCRYPTION_KEYS:'  '})).toBeUndefined();
});

it('reads one key and uses it without being told which is active', () => {
  const cipher=cipherFromEnvironment({HUMANIZE_ENCRYPTION_KEYS:`v1:${key()}`})!;
  expect(cipher.activeVersion).toBe('v1');
  expect(cipher.decrypt('org','ref',cipher.encrypt('org','ref','sk-secret'))).toBe('sk-secret');
});

it('keeps an old key readable while a new one encrypts', () => {
  // This is what makes rotation possible: writes move to the new key, and everything the
  // old key wrote stays decryptable because each secret records the version that wrote it.
  const first=key(),second=key();
  const before=cipherFromEnvironment({HUMANIZE_ENCRYPTION_KEYS:`v1:${first}`})!;
  const stored=before.encrypt('org','ref','sk-secret');
  const after=cipherFromEnvironment({HUMANIZE_ENCRYPTION_KEYS:`v1:${first},v2:${second}`,HUMANIZE_ENCRYPTION_ACTIVE_KEY:'v2'})!;
  expect(after.activeVersion).toBe('v2');
  expect(after.decrypt('org','ref',stored)).toBe('sk-secret');
  expect(after.encrypt('org','ref','sk-secret').keyVersion).toBe('v2');
});

it('refuses malformed key material rather than starting with a weak secret', () => {
  expect(()=>cipherFromEnvironment({HUMANIZE_ENCRYPTION_KEYS:`v1:${randomBytes(16).toString('base64')}`})).toThrow('INVALID_ENCRYPTION_KEYS');
  expect(()=>cipherFromEnvironment({HUMANIZE_ENCRYPTION_KEYS:key()})).toThrow('INVALID_ENCRYPTION_KEYS');
  expect(()=>cipherFromEnvironment({HUMANIZE_ENCRYPTION_KEYS:`:${key()}`})).toThrow('INVALID_ENCRYPTION_KEYS');
  // Several keys with none named active is ambiguous, not a default.
  expect(()=>cipherFromEnvironment({HUMANIZE_ENCRYPTION_KEYS:`v1:${key()},v2:${key()}`})).toThrow('INVALID_ENCRYPTION_KEYS');
  // An active version that was not supplied is refused by SecretCipher itself.
  expect(()=>cipherFromEnvironment({HUMANIZE_ENCRYPTION_KEYS:`v1:${key()}`,HUMANIZE_ENCRYPTION_ACTIVE_KEY:'v9'})).toThrow('INVALID_ENCRYPTION_KEYS');
});
