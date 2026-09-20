import { Database,migrate,RunnerStore } from '@humanize/db';
import { JobQueue } from '@humanize/queue';
import { GitHubTokenBroker } from '@humanize/github';
import { createApi } from './app.js';
import { DurableWebhookSink } from './webhook-store.js';

const url=process.env.DATABASE_URL,secret=process.env.GITHUB_WEBHOOK_SECRET;
const appId=process.env.GITHUB_APP_ID,privateKey=process.env.GITHUB_APP_PRIVATE_KEY;
if(!url||!secret)throw Error('DATABASE_URL and GITHUB_WEBHOOK_SECRET are required');
if(!appId||!privateKey)throw Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required');
const db=new Database(url);await migrate(db);const queue=new JobQueue(url);await queue.start();
const app=createApi({webhookSecret:secret,sink:new DurableWebhookSink(db,queue),runners:new RunnerStore(db),tokens:new GitHubTokenBroker(appId,privateKey)});
await app.listen({host:'127.0.0.1',port:Number(process.env.HUMANIZE_PORT??3001)});
let closing=false;
const close=async()=>{if(closing)return;closing=true;await app.close();await queue.stop();await db.close();};
process.once('SIGTERM',()=>{void close();});process.once('SIGINT',()=>{void close();});
