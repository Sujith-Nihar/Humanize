import Fastify from 'fastify';
import { verifyWebhook,normalizeWebhook } from '@humanize/github';
import { registerAdminRoutes } from './admin.js';
import { registerRunnerRoutes } from './runner.js';
import type { PublicationScheduler,RunnerService,TokenIssuer } from './runner.js';
import type { AdminOptions } from './admin.js';
import type { GitHubEvent } from '@humanize/domain';

export interface WebhookSink { ingest(deliveryId:string,event:GitHubEvent):Promise<boolean>; }
export function createApi(options:{webhookSecret:string;sink:WebhookSink;runners:RunnerService;tokens:TokenIssuer;publication?:PublicationScheduler;admin?:AdminOptions}) {
  const app=Fastify({logger:false,bodyLimit:1024*1024,requestTimeout:30000});
  // Client errors keep their status so a caller does not retry a permanently invalid
  // request, but no error message is ever echoed back.
  app.setErrorHandler((error:unknown,_request,reply)=>{
    const code=(error as {statusCode?:unknown}).statusCode;
    const status=typeof code==='number'&&code>=400&&code<500?code:500;
    void reply.code(status).send({error:status===413?'REQUEST_TOO_LARGE':status===500?'INTERNAL_ERROR':'INVALID_REQUEST'});
  });
  app.get('/health',async()=>({status:'ok'}));
  registerRunnerRoutes(app,options.runners,options.tokens,options.publication);
  if(options.admin)registerAdminRoutes(app,options.admin);
  void app.register(async hooks=>{
    hooks.removeContentTypeParser('application/json');
    hooks.addContentTypeParser('application/json',{parseAs:'buffer',bodyLimit:25*1024*1024},(_req,body,done)=>done(null,body));
    hooks.post('/webhooks/github',{bodyLimit:25*1024*1024},async(request,reply)=>{
      const raw=request.body;const signature=request.headers['x-hub-signature-256'];
      if(!Buffer.isBuffer(raw)||typeof signature!=='string'||!verifyWebhook(raw,signature,options.webhookSecret))return reply.code(401).send({error:'INVALID_SIGNATURE'});
      const event=request.headers['x-github-event'];const delivery=request.headers['x-github-delivery'];
      if(typeof delivery!=='string'||!/^[a-zA-Z0-9-]{1,128}$/.test(delivery)||typeof event!=='string')return reply.code(400).send({error:'INVALID_HEADERS'});
      if(event==='ping')return reply.code(200).send({accepted:true});
      if(!['installation','installation_repositories','pull_request','push','check_run'].includes(event))return reply.code(202).send({accepted:false});
      let normalized:GitHubEvent;try{normalized=normalizeWebhook(event,raw);}catch{return reply.code(400).send({error:'INVALID_EVENT'});}
      try{const accepted=await options.sink.ingest(delivery,normalized);return reply.code(202).send({accepted,duplicate:!accepted});}
      catch{return reply.code(503).send({error:'DURABLE_INGEST_FAILED'});}
    });
  });
  return app;
}
