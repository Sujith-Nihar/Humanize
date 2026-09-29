import { z } from '@humanize/domain';
import type { GitHubTransport } from './transport.js';

export interface OAuthApp { clientId:string; clientSecret:string; redirectUrl?:string|undefined; }
/** Maps GitHub account ids to the Humanize organizations that installed the App on them. */
export type OrganizationDirectory=(githubAccountIds:readonly number[])=>Promise<string[]>;
/** Builds a transport authenticated as the signing-in user, for the duration of the sign-in only. */
export type UserTransport=(userToken:string)=>GitHubTransport;

const TokenResponse=z.object({access_token:z.string().min(1)}).passthrough();
const User=z.object({id:z.number().int().positive()}).passthrough();
const Installations=z.object({installations:z.array(z.object({account:z.object({id:z.number().int().positive()}).passthrough().nullable()}).passthrough())}).passthrough();
const MAX_INSTALLATION_PAGES=10;

/**
 * Signs a user in with the GitHub App's own OAuth credentials.
 *
 * The user's access token is used only inside `exchange` and then dropped: a session carries
 * identity, never secrets, so nothing that could act as the user outlives the sign-in. What the
 * session grants is visibility of the organizations whose installations the user can see.
 * Seeing an organization is not administering it. Every write is authorised separately, and
 * freshly, by asking GitHub whether this user is an administrator right now (ADR-028).
 */
export class GitHubIdentity {
  constructor(private readonly app:OAuthApp,private readonly organizations:OrganizationDirectory,
    private readonly transport:UserTransport,private readonly fetcher:typeof fetch=fetch){}

  authorizeUrl(state:string):string {
    const url=new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id',this.app.clientId);
    url.searchParams.set('state',state);
    if(this.app.redirectUrl)url.searchParams.set('redirect_uri',this.app.redirectUrl);
    return url.toString();
  }

  /** Null for any failure: a sign-in that cannot be completed must not yield a partial identity. */
  async exchange(code:string):Promise<{userId:string;organizationIds:string[]}|null> {
    let token:string;
    try{
      const response=await this.fetcher('https://github.com/login/oauth/access_token',{
        method:'POST',headers:{accept:'application/json','content-type':'application/json'},
        body:JSON.stringify({client_id:this.app.clientId,client_secret:this.app.clientSecret,code,
          ...(this.app.redirectUrl?{redirect_uri:this.app.redirectUrl}:{})}),
        signal:AbortSignal.timeout(15000),
      });
      // GitHub reports a bad or reused code as a 200 carrying an error field, so the shape
      // is what decides, not the status alone.
      const parsed=TokenResponse.safeParse(response.ok?await response.json():null);
      if(!parsed.success)return null;
      token=parsed.data.access_token;
    }catch{return null;}

    try{
      const client=this.transport(token);
      const user=User.parse((await client.request('GET /user',{})).data);
      const accounts=new Set<number>();
      for(let page=1;page<=MAX_INSTALLATION_PAGES;page++){
        const {installations}=Installations.parse((await client.request('GET /user/installations',{per_page:100,page})).data);
        for(const installation of installations)if(installation.account)accounts.add(installation.account.id);
        if(installations.length<100)break;
      }
      return {userId:String(user.id),organizationIds:await this.organizations([...accounts])};
    }catch{return null;}
  }
}

/** Where a repository lives on GitHub, resolved from Humanize's own records. */
export interface RepositoryCoordinates { id:string; installationId:number; githubRepositoryId:number; owner:string; name:string; }
export type CoordinateLookup=(repositoryIds:readonly string[])=>Promise<RepositoryCoordinates[]>;
/** A transport holding a metadata-only token for one repository. */
export type MetadataTransport=(installationId:number,githubRepositoryId:number)=>Promise<GitHubTransport>;

const Account=z.object({login:z.string().min(1)}).passthrough();
const Permission=z.object({permission:z.string(),user:z.object({id:z.number().int().positive()}).passthrough().nullable()}).passthrough();

/**
 * Returns an administrator check for one user: given repository ids, which of them this user
 * administers on GitHub at this moment.
 *
 * It is asked as the App, with a metadata-only token per repository, because the session holds
 * no user token to ask with. The login is looked up from the stable user id each time rather
 * than remembered, and the answer must name that same id: a renamed account whose old login
 * someone else has since taken would otherwise be checked as the wrong person.
 *
 * Every failure counts as "not an administrator". A check that cannot reach GitHub must refuse,
 * never assume.
 */
export function githubAdminCheck(userId:string,lookup:CoordinateLookup,transport:MetadataTransport):(repositoryIds:readonly string[])=>Promise<string[]> {
  const id=Number(userId);
  return async repositoryIds=>{
    if(!Number.isSafeInteger(id)||id<=0||!repositoryIds.length)return [];
    const coordinates=await lookup(repositoryIds).catch(()=>[] as RepositoryCoordinates[]);
    const permitted:string[]=[];
    for(const repository of coordinates){
      try{
        const client=await transport(repository.installationId,repository.githubRepositoryId);
        const {login}=Account.parse((await client.request('GET /user/{account_id}',{account_id:id})).data);
        const answer=Permission.parse((await client.request('GET /repos/{owner}/{repo}/collaborators/{username}/permission',
          {owner:repository.owner,repo:repository.name,username:login})).data);
        if(answer.permission==='admin'&&answer.user?.id===id)permitted.push(repository.id);
      }catch{/* unreachable, unknown or renamed: not an administrator */}
    }
    return permitted;
  };
}
