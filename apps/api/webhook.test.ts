import { createHmac } from 'node:crypto';
import { expect,it,vi } from 'vitest';
import { createApi } from './src/app.js';

const runners={register:vi.fn(),heartbeat:vi.fn(),leaseScope:vi.fn(),claim:vi.fn(),renew:vi.fn(),fail:vi.fn(),accept:vi.fn()};
const tokens={scopedToken:vi.fn()};

it('does not parse or ingest an unauthenticated request',async()=>{
  const sink={ingest:vi.fn()};const app=createApi({webhookSecret:'secret',sink,runners,tokens});
  try{const response=await app.inject({method:'POST',url:'/webhooks/github',headers:{'content-type':'application/json'},payload:'not json'});expect(response.statusCode).toBe(401);expect(sink.ingest).not.toHaveBeenCalled();}finally{await app.close();}
});
it('acknowledges only after durable ingestion and reports persistence failure',async()=>{
  const sink={ingest:vi.fn(async()=>{throw Error('DB secret diagnostic');})};const app=createApi({webhookSecret:'secret',sink,runners,tokens});
  const raw=JSON.stringify({action:'created',installation:{id:1,account:{id:2,login:'owner'}}});
  try{const response=await app.inject({method:'POST',url:'/webhooks/github',headers:{'content-type':'application/json','x-github-event':'installation','x-github-delivery':'delivery','x-hub-signature-256':'sha256='+createHmac('sha256','secret').update(raw).digest('hex')},payload:raw});expect(response.statusCode).toBe(503);expect(response.body).not.toContain('DB secret');}finally{await app.close();}
});
