import { describe, it, expect } from 'vitest';
import { JobPayloadSchema, SourceRangeSchema, canTransition, PathSchema } from './src/index.js';

describe('trust boundary contracts', () => {
  it('rejects unsafe paths and malformed ranges', () => {
    for (const path of ['../secret','/etc/passwd','a/../b','C:\\secret','a\0b']) expect(PathSchema.safeParse(path).success).toBe(false);
    expect(SourceRangeSchema.safeParse({startOffset:10,endOffset:9,startLine:1,endLine:1}).success).toBe(false);
  });
  it('does not allow source or credentials in durable jobs', () => {
    const metadata={version:1,organizationId:'org',repositoryId:'repo',traceId:'trace',idempotencyKey:'key'};
    expect(JobPayloadSchema.safeParse(metadata).success).toBe(true);
    for(const key of ['token','prompt','source','findings']) expect(JobPayloadSchema.safeParse({...metadata,[key]:'secret'}).success).toBe(false);
  });
  it('rejects invalid transitions and terminal revival', () => {
    expect(canTransition('QUEUED','ACQUIRING_REPO')).toBe(true);
    expect(canTransition('QUEUED','PUBLISHING')).toBe(false);
    expect(canTransition('COMPLETE','QUEUED')).toBe(false);
    expect(canTransition('STALE','PUBLISHING')).toBe(false);
    expect(canTransition('FAILED_RETRYABLE','QUEUED')).toBe(true);
  });
});
