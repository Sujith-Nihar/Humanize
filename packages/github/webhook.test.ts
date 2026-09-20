import { createHmac } from 'node:crypto';
import { expect,it } from 'vitest';
import { verifyWebhook,normalizeWebhook,eventIntent } from './src/index.js';
const body=Buffer.from(JSON.stringify({action:'synchronize',installation:{id:1},repository:{id:2,name:'repo',owner:{id:3,login:'owner'},default_branch:'main'},pull_request:{number:4,head:{sha:'a'.repeat(40)},base:{sha:'b'.repeat(40),ref:'main'},draft:false,state:'open',body:'UNTRUSTED_SOURCE'}}));
it('verifies raw bytes before parsing and rejects tampering',()=>{
  const sig='sha256='+createHmac('sha256','secret').update(body).digest('hex');
  expect(verifyWebhook(body,sig,'secret')).toBe(true);expect(verifyWebhook(Buffer.concat([body,Buffer.from(' ')]),sig,'secret')).toBe(false);expect(verifyWebhook(body,'sha256=bad','secret')).toBe(false);
});
it('minimizes persisted metadata and ignores reordered old heads',()=>{
  const event=normalizeWebhook('pull_request',body);expect(JSON.stringify(event)).not.toContain('UNTRUSTED_SOURCE');
  expect(eventIntent(event,{headSha:'a'.repeat(40),state:'open',draft:false})).toBe('review');
  expect(eventIntent(event,{headSha:'c'.repeat(40),state:'open',draft:false})).toBe('ignore');
  expect(eventIntent(event,{headSha:'a'.repeat(40),state:'closed'})).toBe('cancel');
});
