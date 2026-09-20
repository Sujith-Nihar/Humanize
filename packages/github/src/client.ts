import { App,Octokit } from 'octokit';
import { z } from '@humanize/domain';

const Token=z.object({token:z.string(),expires_at:z.string()});
export class GitHubTokenBroker {
  private readonly app:App;
  private readonly cache=new Map<string,{token:string;expiresAt:number}>();
  constructor(appId:string,privateKey:string){this.app=new App({appId,privateKey});}
  async token(installationId:number,repositoryId:number,role:'read'|'publish'):Promise<string>{
    return (await this.scopedToken(installationId,repositoryId,role)).token;
  }
  /** Mints a token limited to one repository and the minimum permissions for the role. */
  async scopedToken(installationId:number,repositoryId:number,role:'read'|'publish'):Promise<{token:string;expiresAt:string}>{
    const key=`${installationId}:${repositoryId}:${role}`;const cached=this.cache.get(key);
    if(cached&&cached.expiresAt>Date.now()+120000)return {token:cached.token,expiresAt:new Date(cached.expiresAt).toISOString()};
    const response=await this.app.octokit.request('POST /app/installations/{installation_id}/access_tokens',{installation_id:installationId,repository_ids:[repositoryId],permissions:role==='read'?{contents:'read'}:{pull_requests:'write',checks:'write'},request:{retries:0}});
    const result=Token.parse(response.data);this.cache.set(key,{token:result.token,expiresAt:Date.parse(result.expires_at)});
    return {token:result.token,expiresAt:new Date(result.expires_at).toISOString()};
  }
  revokeCached(installationId:number):void{for(const key of this.cache.keys())if(key.startsWith(`${installationId}:`))this.cache.delete(key);}
  async installation(installationId:number){return (await this.app.octokit.request('GET /app/installations/{installation_id}',{installation_id:installationId})).data;}
  async redeliver(deliveryId:number):Promise<void>{await this.app.octokit.request('POST /app/hook/deliveries/{delivery_id}/attempts',{delivery_id:deliveryId});}
  async deliveries(){return this.app.octokit.paginate('GET /app/hook/deliveries',{per_page:100});}
}
export function githubClient(token:string):Octokit {return new Octokit({auth:token,retry:{enabled:false},throttle:{onRateLimit:()=>false,onSecondaryRateLimit:()=>false},request:{timeout:30000}});}
