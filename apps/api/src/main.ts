import { Database,PublicationStore,RunnerStore,migrate } from '@humanize/db';
import { JobQueue } from '@humanize/queue';
import { GitHubTokenBroker } from '@humanize/github';
import { OllamaProvider } from '@humanize/providers';
import { createApi } from './app.js';
import { resolveExtensionPorts } from './extension-dev.js';
import { DurableWebhookSink } from './webhook-store.js';

const url=process.env.DATABASE_URL,secret=process.env.GITHUB_WEBHOOK_SECRET;
const appId=process.env.GITHUB_APP_ID,privateKey=process.env.GITHUB_APP_PRIVATE_KEY;
if(!url||!secret)throw Error('DATABASE_URL and GITHUB_WEBHOOK_SECRET are required');
if(!appId||!privateKey)throw Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required');
const db=new Database(url);await migrate(db);const queue=new JobQueue(url);await queue.start();
const publications=new PublicationStore(db);
// /extension/reviews exists in this process only when a development credential is explicitly
// configured (ADR-040: production credential issuance is unresolved). Absent, this resolves to
// undefined and the route is never registered at all, exactly like `admin` remains unwired today.
const extension=resolveExtensionPorts(
  {devCredential:process.env.HUMANIZE_EXTENSION_DEV_CREDENTIAL,model:process.env.HUMANIZE_EXTENSION_MODEL,nodeEnv:process.env.NODE_ENV},
  new OllamaProvider(process.env.OLLAMA_BASE_URL??'http://127.0.0.1:11434',true),
);
const app=createApi({
  webhookSecret:secret,sink:new DurableWebhookSink(db,queue),runners:new RunnerStore(db),
  tokens:new GitHubTokenBroker(appId,privateKey),
  // An accepted result is held only until publication completes or is abandoned (ADR-038),
  // and the job carries identifiers alone. A runner never waits on GitHub.
  publication:{schedule:async(result,scope)=>{
    await publications.put({runId:scope.runId,organizationId:scope.snapshot.organizationId,
      repositoryId:scope.snapshot.repositoryId,retentionMode:scope.snapshot.retentionMode,
      payload:{snapshot:scope.snapshot,result}});
    await queue.send('review.publish',{version:1,organizationId:scope.snapshot.organizationId,
      repositoryId:scope.snapshot.repositoryId,runId:scope.runId,headSha:scope.snapshot.headSha,
      traceId:scope.runId,idempotencyKey:`publish:${scope.runId}:${scope.snapshot.headSha}`});
  }},
  ...(extension?{extension}:{}),
});
await app.listen({host:'127.0.0.1',port:Number(process.env.HUMANIZE_PORT??3001)});
let closing=false;
const close=async()=>{if(closing)return;closing=true;await app.close();await queue.stop();await db.close();};
process.once('SIGTERM',()=>{void close();});process.once('SIGINT',()=>{void close();});
