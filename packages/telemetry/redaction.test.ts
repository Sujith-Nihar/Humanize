import { Writable } from 'node:stream';
import { expect, it } from 'vitest';
import { createTelemetry,REDACTED,scrub } from './src/index.js';

it('drops arbitrary content, secrets and nested provider errors',()=>{
  let output='';
  const stream=new Writable({write(chunk,_encoding,callback){output+=String(chunk);callback();}});
  createTelemetry(stream).log({event:'review.complete',count:2,prompt:'SOURCE_SENTINEL',authorization:'SECRET_SENTINEL',error:{headers:{authorization:'SECRET_SENTINEL'}}});
  expect(output).toContain('review.complete');expect(output).not.toContain('SENTINEL');
});

it('scrubs credential-shaped values even from allowlisted fields', () => {
  for(const [secret,label] of [
    ['postgres://humanize:hunter2@localhost:5432/humanize','database url'],
    ['Bearer ghs_abcdefghijklmnopqrstuvwxyz012345','authorization header'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789','github token'],
    ['sk-abcdefghijklmnopqrstuvwxyz0123','provider key'],
  ] as const){
    // An allowlisted field name is not a promise about what a caller put in it.
    expect(scrub(secret),label).toContain(REDACTED);
    expect(scrub(`prefix ${secret} suffix`),label).not.toContain(secret);
  }
  // Ordinary operational values are left alone.
  expect(scrub('review.publish.handled')).toBe('review.publish.handled');
  expect(scrub('PARSE_FAILURE')).toBe('PARSE_FAILURE');
  expect(scrub('app/page.tsx:12')).toBe('app/page.tsx:12');
});

it('records a measurement without letting a dimension become a leak', () => {
  const lines:string[]=[];
  const telemetry=createTelemetry({write:(line:string)=>{lines.push(line);}} as never);
  telemetry.measure('model.call',1,{provider:'ollama',model:'qwen3.5:4b',role:'reviewer',durationMs:820});
  const recorded=JSON.parse(lines.at(-1)!) as Record<string,unknown>;
  expect(recorded).toMatchObject({event:'metric.model.call',count:1,provider:'ollama',role:'reviewer'});

  // A dimension is emitted output like any other, so it is filtered and scrubbed too.
  telemetry.measure('publication',1,{provider:'github',errorClass:'Bearer ghs_abcdefghijklmnopqrstuvwxyz012345',secretField:'sk-abcdefghijklmnopqrstuvwxyz0123'} as never);
  const guarded=lines.at(-1)!;
  expect(guarded).not.toContain('ghs_abcdefghijklmnopqrstuvwxyz012345');
  expect(guarded).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
  expect(guarded).not.toContain('secretField');
  expect(guarded).toContain(REDACTED);
});

it('never emits repository content, whatever a stage passes', () => {
  const lines:string[]=[];
  const telemetry=createTelemetry({write:(line:string)=>{lines.push(line);}} as never);
  const sentence='Unlock unprecedented potential with our cutting-edge platform.';
  // Every shape a stage might reach for: the node text, an explanation, a quote, a patch.
  telemetry.log({event:'review.finding',text:sentence,explanation:sentence,quote:sentence,replacement:sentence,filePath:'app/page.tsx',count:1} as never);
  telemetry.measure('findings.published',1,{text:sentence,filePath:'app/page.tsx'} as never);
  const written=lines.join('\n');
  expect(written).not.toContain('unprecedented');
  // Even a file path is not on the allowlist, because a path can identify private work.
  expect(written).not.toContain('app/page.tsx');
  expect(written).toContain('review.finding');
});
