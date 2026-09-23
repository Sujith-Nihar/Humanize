import { constantEqual } from '@humanize/security';
import type { ModelProvider } from '@humanize/domain';
import type { ExtensionAuthenticator, ExtensionRateLimiter, ExtensionReviewPorts } from './extension.js';

/**
 * Development-only authenticator: a single, fixed shared secret supplied by configuration,
 * never embedded in source. Comparison is constant-time (`constantEqual`, the same primitive
 * `SessionSigner` already uses) so a wrong guess cannot be distinguished by timing. There is
 * nothing "at rest" to hash here — the secret lives only in process memory for the lifetime of
 * this server, exactly like `GITHUB_WEBHOOK_SECRET` already does in this same file's caller.
 * This is explicitly not a production credential mechanism (ADR-040 leaves that unresolved).
 */
export function createDevExtensionAuthenticator(expectedCredential: string): ExtensionAuthenticator {
  return {
    async authenticate(credential) {
      if (!credential || !constantEqual(credential, expectedCredential)) return null;
      return { actorId: 'dev-actor' };
    },
  };
}

/**
 * A conservative, single-process, in-memory fixed-window limiter. Explicitly a development/test
 * abstraction, not a distributed production rate limiter — state is lost on restart and shared
 * by nothing beyond this one process, which is acceptable only because this port is never wired
 * into a production configuration (see `resolveExtensionPorts`).
 */
export function createInMemoryRateLimiter(options: { maxRequests: number; windowMs: number }): ExtensionRateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    async check(actorId: string) {
      const now = Date.now();
      const existing = windows.get(actorId);
      if (!existing || now >= existing.resetAt) { windows.set(actorId, { count: 1, resetAt: now + options.windowMs }); return true; }
      if (existing.count >= options.maxRequests) return false;
      existing.count++;
      return true;
    },
  };
}

export interface ExtensionDevConfig {
  /** From `HUMANIZE_EXTENSION_DEV_CREDENTIAL`. Absent means the route stays unwired — fail closed. */
  devCredential?: string | undefined;
  /** From `HUMANIZE_EXTENSION_MODEL`. Required whenever a dev credential is configured. */
  model?: string | undefined;
  /** From `NODE_ENV`. A production environment must never carry a dev credential at all. */
  nodeEnv?: string | undefined;
}

/**
 * Decides whether `/extension/reviews` should exist in this process at all, and if so, with
 * which development-only ports. Returns `undefined` (route stays unregistered, matching the
 * existing opt-in pattern `admin` already uses) when no development credential is configured —
 * the only way this route becomes reachable today, since production credential issuance is
 * unresolved (ADR-040). A production environment that somehow carries a dev credential fails the
 * whole startup rather than silently using it.
 */
export function resolveExtensionPorts(config: ExtensionDevConfig, provider: ModelProvider): ExtensionReviewPorts | undefined {
  if (!config.devCredential) return undefined;
  if (config.nodeEnv === 'production') throw Error('HUMANIZE_EXTENSION_DEV_CREDENTIAL must not be set when NODE_ENV=production');
  if (!config.model) throw Error('HUMANIZE_EXTENSION_MODEL is required when HUMANIZE_EXTENSION_DEV_CREDENTIAL is set');
  return {
    reviewer: provider, reviewerModel: config.model, verifier: provider, verifierModel: config.model,
    authenticator: createDevExtensionAuthenticator(config.devCredential),
    // Conservative default: comfortably below MAX_CONCURRENT_REVIEWS's own protection, for one
    // development actor manually testing from a loaded extension, not a production policy.
    rateLimiter: createInMemoryRateLimiter({ maxRequests: 20, windowMs: 60_000 }),
  };
}
