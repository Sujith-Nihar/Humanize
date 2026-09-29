import type { AdminCheck,Database,RunnerStore } from '@humanize/db';
import { AdministrationStore,EncryptedSecretStore } from '@humanize/db';
import { GitHubIdentity,githubAdminCheck,githubClient } from '@humanize/github';
import type { GitHubTokenBroker } from '@humanize/github';
import { SessionSigner } from '@humanize/security';
import type { SecretCipher } from '@humanize/security';
import type { AdminOptions } from './admin.js';

export interface AdminEnvironment {
  HUMANIZE_SESSION_KEY?:string|undefined;
  GITHUB_OAUTH_CLIENT_ID?:string|undefined;
  GITHUB_OAUTH_CLIENT_SECRET?:string|undefined;
  HUMANIZE_OAUTH_REDIRECT_URL?:string|undefined;
}
export type AdminResolution={options:AdminOptions}|{options:undefined;missing:string[]};

/**
 * Binds the administration routes to real stores and to GitHub, or explains why it cannot.
 *
 * Administration is optional in a deployment, and its absence is stated rather than guessed at:
 * every variable it lacks is named, and the routes are simply not registered. What it never does
 * is start with a weaker rule than ADR-028. Every write is authorised by asking GitHub, at the
 * moment of the write, whether the signed-in person administers the repositories involved.
 */
export function resolveAdmin(env:AdminEnvironment,db:Database,broker:GitHubTokenBroker,runners:RunnerStore,cipher:SecretCipher|undefined):AdminResolution {
  const missing=[
    ...(!env.HUMANIZE_SESSION_KEY?['HUMANIZE_SESSION_KEY']:[]),
    ...(!env.GITHUB_OAUTH_CLIENT_ID?['GITHUB_OAUTH_CLIENT_ID']:[]),
    ...(!env.GITHUB_OAUTH_CLIENT_SECRET?['GITHUB_OAUTH_CLIENT_SECRET']:[]),
    // Credentials cannot be stored without keys to encrypt them, and storing them unencrypted
    // is not an available fallback.
    ...(!cipher?['HUMANIZE_ENCRYPTION_KEYS']:[]),
  ];
  if(missing.length)return {options:undefined,missing};

  // A short key is refused by SessionSigner itself; decoding here only chooses the encoding.
  const sessions=new SessionSigner(Buffer.from(env.HUMANIZE_SESSION_KEY!,'base64'));
  const administration=new AdministrationStore(db);

  const identity=new GitHubIdentity(
    {clientId:env.GITHUB_OAUTH_CLIENT_ID!,clientSecret:env.GITHUB_OAUTH_CLIENT_SECRET!,redirectUrl:env.HUMANIZE_OAUTH_REDIRECT_URL},
    async accounts=>(await db.pool.query<{id:string}>(
      'SELECT id FROM organizations WHERE github_account_id=ANY($1::bigint[]) AND enabled ORDER BY id',[[...accounts]])).rows.map(row=>row.id),
    token=>githubClient(token),
  );

  /** The ADR-028 check for one person, answered by GitHub at the moment it is asked. */
  const adminCheck=(actor:string):AdminCheck=>githubAdminCheck(actor,
    async ids=>(await db.pool.query<{id:string;installation_id:string;github_repository_id:string;owner:string;name:string}>(
      'SELECT id,installation_id,github_repository_id,owner,name FROM repositories WHERE id=ANY($1::uuid[])',[[...ids]])).rows
      .map(row=>({id:row.id,installationId:Number(row.installation_id),githubRepositoryId:Number(row.github_repository_id),owner:row.owner,name:row.name})),
    async(installationId,githubRepositoryId)=>githubClient(await broker.token(installationId,githubRepositoryId,'metadata')));

  // One store per provider, because a stored credential is bound to the provider it was saved
  // for and resolving it for any other is refused. Listing is provider-independent.
  const secrets=(provider:string)=>new EncryptedSecretStore(db,cipher!,provider);

  return {options:{
    sessions,identity,
    credentials:{
      save:async(organizationId,provider,secret,actor)=>({id:await administration.asOrganizationAdmin(organizationId,adminCheck(actor),
        client=>secrets(provider).put(organizationId,secret,client))}),
      list:organizationId=>secrets('').list(organizationId),
      revoke:(organizationId,id,actor)=>administration.asOrganizationAdmin(organizationId,adminCheck(actor),
        client=>secrets('').revoke(organizationId,id,client)),
    },
    repositories:{
      repositories:organizationId=>administration.repositories(organizationId),
      setEnabled:(organizationId,ids,enabled,actor)=>administration.setEnabled(organizationId,ids,enabled,adminCheck(actor)),
      policy:organizationId=>administration.policy(organizationId),
      setPolicy:(organizationId,policy,actor)=>administration.asOrganizationAdmin(organizationId,adminCheck(actor),
        client=>administration.setPolicy(organizationId,policy,client)),
    },
    runnerAdmin:{
      createEnrollment:(organizationId,repositoryIds,createdBy)=>runners.enrollment(organizationId,repositoryIds,{createdBy,check:adminCheck(createdBy)}),
      enrollments:organizationId=>runners.enrollments(organizationId),
      revokeEnrollment:(organizationId,id,actor)=>administration.asOrganizationAdmin(organizationId,adminCheck(actor),
        client=>runners.revokeEnrollment(organizationId,id,client)),
      runners:organizationId=>runners.runners(organizationId),
      revokeRunner:(organizationId,runnerId,actor)=>administration.asOrganizationAdmin(organizationId,adminCheck(actor),
        client=>runners.revoke(organizationId,runnerId,client)),
    },
  }};
}
