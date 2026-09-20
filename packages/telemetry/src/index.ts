import pino from 'pino';
import { trace, metrics, SpanStatusCode } from '@opentelemetry/api';

// Allowlisted operational fields prevent unknown nested provider errors or source payloads leaking.
const allowed = new Set(['event','traceId','runId','organizationId','repositoryId','runnerId','provider','model','role','durationMs','count','errorClass','state','attempt','coverage','status']);
/**
 * Values that look like credentials, wherever they appear. The field allowlist below stops a
 * caller adding an unexpected field, but it cannot stop one putting a secret into an expected
 * one: an error message logged as `event`, or a connection string passed as `traceId`, is
 * allowlisted by name and would otherwise be written verbatim.
 */
const CREDENTIAL_SHAPES:RegExp[]=[
  /[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i,   // any URL carrying a password
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,  // authorization header values
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/,  // GitHub tokens
  /\bsk-[A-Za-z0-9_-]{16,}/,                       // provider API keys
  /\b[A-Za-z0-9_-]{40,}\b/,                        // long opaque tokens
];
export const REDACTED='[redacted]';
export function scrub(value:string):string {
  return CREDENTIAL_SHAPES.reduce((text,shape)=>text.replace(new RegExp(shape.source,shape.flags.includes('g')?shape.flags:`${shape.flags}g`),REDACTED),value);
}

/**
 * The operational measurements the specification asks for. Naming them once means a stage
 * cannot invent its own label, and a dashboard does not depend on spelling.
 */
export type Measurement=
  |'webhook.ingest'|'queue.wait'|'repository.checkout'|'extraction'|'context.retrieval'
  |'model.call'|'publication'|'job.retry'|'job.failure'|'review.stale'|'runner.state'
  |'findings.published'|'findings.suppressed'|'suggestions.offered'|'suggestions.accepted'
  |'verifier.suppressed'|'duplicates.merged'|'files.classified'|'nodes.extracted';

export function createTelemetry(destination?:pino.DestinationStream) {
  const logger=destination ? pino({base:null},destination) : pino({base:null});
  const tracer=trace.getTracer('humanize','0.1.0');
  const meter=metrics.getMeter('humanize','0.1.0');
  const duration=meter.createHistogram('humanize_operation_duration_ms');
  const counters=new Map<Measurement,ReturnType<typeof meter.createCounter>>();
  return {
    log(fields:Record<string,unknown>) {
      const safe=Object.fromEntries(Object.entries(fields)
        .filter(([key,value])=>allowed.has(key) && (typeof value==='number'||typeof value==='boolean'||(typeof value==='string'&&value.length<=200)))
        // An allowlisted name is not a promise about the value, so every string is scrubbed.
        .map(([key,value])=>[key,typeof value==='string'?scrub(value):value]));
      logger.info(safe);
    },
    /** Records a measurement. Dimensions are scrubbed like any other emitted value. */
    measure(name:Measurement,value:number,dimensions:Record<string,string|number|boolean>={}):void {
      const safe=Object.fromEntries(Object.entries(dimensions)
        .filter(([key,item])=>allowed.has(key)&&(typeof item==='number'||typeof item==='boolean'||(typeof item==='string'&&item.length<=200)))
        .map(([key,item])=>[key,typeof item==='string'?scrub(item):item]));
      let counter=counters.get(name);
      if(!counter){counter=meter.createCounter(`humanize_${name.replace(/\./g,'_')}`);counters.set(name,counter);}
      counter.add(value,safe);
      logger.info({event:`metric.${name}`,count:value,...safe});
    },
    async span<T>(operation:string,run:()=>Promise<T>):Promise<T> {
      return tracer.startActiveSpan(operation,async span=>{
        const start=performance.now();
        try{return await run();}catch(error){span.setStatus({code:SpanStatusCode.ERROR});throw error;}finally{duration.record(performance.now()-start,{operation});span.end();}
      });
    },
  };
}
