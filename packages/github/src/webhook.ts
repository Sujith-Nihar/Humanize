import { createHmac,timingSafeEqual } from 'node:crypto';
import { z,GitHubEventSchema,Sha } from '@humanize/domain';
import type { GitHubEvent } from '@humanize/domain';

export function verifyWebhook(raw:Buffer,signature:string|undefined,secret:string):boolean {
  if(!secret||!signature||!/^sha256=[0-9a-f]{64}$/.test(signature))return false;
  const expected=createHmac('sha256',secret).update(raw).digest();const supplied=Buffer.from(signature.slice(7),'hex');return supplied.length===expected.length&&timingSafeEqual(expected,supplied);
}
const Account=z.object({id:z.number().int().positive(),login:z.string().min(1)});
const RawEvent=z.object({
  action:z.string().max(100).optional(),installation:z.object({id:z.number().int().positive(),account:Account.optional()}),
  repository:z.object({id:z.number().int().positive(),name:z.string(),owner:Account,default_branch:z.string().optional(),updated_at:z.string().optional()}).optional(),
  pull_request:z.object({number:z.number().int().positive(),head:z.object({sha:Sha}),base:z.object({sha:Sha,ref:z.string()}),draft:z.boolean().default(false),state:z.enum(['open','closed']),updated_at:z.string().optional()}).optional(),
  ref:z.string().optional(),after:Sha.optional(),repositories_added:z.array(z.object({id:z.number().int().positive()})).optional(),repositories_removed:z.array(z.object({id:z.number().int().positive()})).optional(),
});
export function normalizeWebhook(event:string,raw:Buffer,receivedAt=new Date()):GitHubEvent {
  const body=RawEvent.parse(JSON.parse(raw.toString('utf8')));const account=body.repository?.owner??body.installation.account;
  if(!account)throw Error('MISSING_ACCOUNT');
  return GitHubEventSchema.parse({event,action:body.action??'',installationId:body.installation.id,accountId:account.id,accountLogin:account.login,
    repository:body.repository?{githubId:body.repository.id,owner:body.repository.owner.login,name:body.repository.name,defaultBranch:body.repository.default_branch??'main'}:null,
    pull:body.pull_request?{number:body.pull_request.number,headSha:body.pull_request.head.sha,baseSha:body.pull_request.base.sha,baseRef:body.pull_request.base.ref,draft:body.pull_request.draft,state:body.pull_request.state}:null,
    // Prefer the moment GitHub recorded the change; fall back to receipt so an event is never
    // unordered, while accepting that a fallback timestamp orders by arrival rather than truth.
    occurredAt:new Date(body.pull_request?.updated_at??body.repository?.updated_at??receivedAt).toISOString(),
    ref:body.ref??null,after:body.after??null,addedRepositoryIds:body.repositories_added?.map(r=>r.id)??[],removedRepositoryIds:body.repositories_removed?.map(r=>r.id)??[],
  });
}
export function eventIntent(event:GitHubEvent,current:{headSha?:string;draft?:boolean;state?:string;defaultBranch?:string},reviewDrafts=false):'reconcile'|'review'|'scan'|'cancel'|'ignore' {
  if(event.event==='installation'||event.event==='installation_repositories')return 'reconcile';
  if(event.event==='pull_request'){
    if(current.state==='closed'||(current.draft&&!reviewDrafts)||['closed','converted_to_draft'].includes(event.action))return 'cancel';
    if(!['opened','synchronize','reopened','ready_for_review','edited'].includes(event.action))return 'ignore';
    if(!event.pull||current.headSha!==event.pull.headSha)return 'ignore';
    return 'review';
  }
  if(event.event==='push'&&event.ref===`refs/heads/${current.defaultBranch}`&&event.after&&!/^0+$/.test(event.after))return 'scan';
  return 'ignore';
}
