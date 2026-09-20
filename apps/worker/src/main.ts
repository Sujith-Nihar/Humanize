import { Database,PublicationStore,RunStore,migrate } from '@humanize/db';
import { JobQueue } from '@humanize/queue';
import { GitHubEventSchema } from '@humanize/domain';
import { handleGitHubEvent } from './handlers.js';
import { publishReview } from './publish-worker.js';

const url=process.env.DATABASE_URL;
if(!url)throw Error('DATABASE_URL is required');

const db=new Database(url);
await migrate(db);
const queue=new JobQueue(url);
await queue.start();
const publications=new PublicationStore(db);
const runs=new RunStore(db);

// Anything a previous process left behind is removed before new work is taken, so content
// never outlives a crash by longer than one restart (ADR-038).
const swept=await publications.sweep();
if(swept)console.log(JSON.stringify({event:'publication.swept',count:swept}));

await queue.work('github.event',async payload=>{
  // The delivery holds the event; the job carries only identifiers, never content.
  const delivery=await db.pool.query<{metadata:unknown}>('SELECT metadata FROM webhook_deliveries WHERE delivery_id=$1',[payload.traceId]);
  const metadata=delivery.rows[0]?.metadata;
  if(metadata===undefined||metadata===null)return;
  const outcome=await handleGitHubEvent(GitHubEventSchema.parse(metadata),{
    db,runs,
    scheduler:{enqueue:async next=>{await queue.send('pull_request.review',next);}},
    // Bound once GitHub App credentials exist; without them no review run is created.
    ...(process.env.GITHUB_APP_ID?{}:{}),
  });
  console.log(JSON.stringify({event:'github.event.handled',action:outcome.action,traceId:payload.traceId}));
});

await queue.work('review.publish',async payload=>{
  const outcome=await publishReview(payload,{
    publications,
    publish:async()=>{throw Error('PUBLISH_TRANSPORT_UNBOUND');},
  });
  // A retry is signalled by throwing, so pg-boss reschedules rather than marking it done.
  if(outcome.status==='retry')throw Error(outcome.errorClass);
  console.log(JSON.stringify({event:'review.publish.handled',status:outcome.status,runId:payload.runId}));
});

let closing=false;
const close=async()=>{if(closing)return;closing=true;await queue.stop();await db.close();};
process.once('SIGTERM',()=>{void close();});process.once('SIGINT',()=>{void close();});
console.log(JSON.stringify({event:'worker.started',queues:['github.event','review.publish']}));
