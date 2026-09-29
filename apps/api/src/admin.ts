import { randomBytes } from 'node:crypto';
import { ProviderId, z } from '@humanize/domain';
import { OrganizationPolicySchema } from '@humanize/config';
import { SessionSigner, constantEqual, requireOrganization } from '@humanize/security';
import type { SessionClaims } from '@humanize/security';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** Exchanges an OAuth code for an identity. Injected so sign-in is testable without GitHub. */
export interface IdentityProvider {
  authorizeUrl(state: string): string;
  exchange(code: string): Promise<{ userId: string; organizationIds: string[] } | null>;
}
/**
 * Credential storage. A saved secret is never read back out through this port. Saving and
 * revoking are organization-wide writes, so the binding authorises `actor` against ADR-028
 * inside the write and throws FORBIDDEN or NO_ENABLED_REPOSITORY when it may not.
 */
export interface CredentialAdmin {
  save(organizationId: string, provider: string, secret: string, actor: string): Promise<{ id: string }>;
  list(organizationId: string): Promise<{ id: string; provider: string; createdAt: string; revokedAt: string | null }[]>;
  revoke(organizationId: string, id: string, actor: string): Promise<void>;
}
/**
 * Repository and policy administration. The admin check runs inside the write (S16-T02):
 * enablement asks which named repositories `actor` administers, and a policy write requires
 * `actor` to administer every enabled repository (ADR-028).
 */
export interface RepositoryAdmin {
  repositories(organizationId: string): Promise<{ id: string; owner: string; name: string; enabled: boolean }[]>;
  setEnabled(organizationId: string, repositoryIds: readonly string[], enabled: boolean, actor: string): Promise<string[]>;
  policy(organizationId: string): Promise<unknown | null>;
  setPolicy(organizationId: string, policy: unknown, actor: string): Promise<void>;
}
/**
 * Runner administration. Creating an enrollment mints a credential, so the store performs the
 * administrator check inside the write; a session alone never decides what a runner may reach.
 */
export interface RunnerAdmin {
  createEnrollment(organizationId:string,repositoryIds:string[],createdBy:string):Promise<{token:string;id:string;expiresAt:string}>;
  enrollments(organizationId:string):Promise<{id:string;repositoryIds:string[];createdBy:string|null;createdAt:string;expiresAt:string;state:string}[]>;
  revokeEnrollment(organizationId:string,id:string,actor:string):Promise<boolean>;
  runners(organizationId:string):Promise<{id:string;online:boolean;revoked:boolean}[]>;
  revokeRunner(organizationId:string,runnerId:string,actor:string):Promise<void>;
}
export interface AdminOptions {
  sessions: SessionSigner; identity: IdentityProvider; credentials: CredentialAdmin;
  repositories?: RepositoryAdmin; runnerAdmin?: RunnerAdmin; secureCookies?: boolean;
}

interface Refusal { code: 401 | 403; error: 'NOT_SIGNED_IN' | 'FORBIDDEN' }
const SESSION_COOKIE = 'humanize_session';
const STATE_COOKIE = 'humanize_oauth_state';
const CreateEnrollment = z.object({ organizationId: z.string().min(1).max(200), repositoryIds: z.array(z.string().uuid()).min(1).max(100) }).strict();
const SetEnabled = z.object({ organizationId: z.string().min(1).max(200), repositoryIds: z.array(z.string().uuid()).min(1).max(500), enabled: z.boolean() }).strict();
const SaveCredential = z.object({ organizationId: z.string().min(1).max(200), provider: ProviderId, secret: z.string().min(8).max(65536) }).strict();

/**
 * Maps an authority refusal from a store to a response. Anything else is a fault and is
 * rethrown, so the shared error handler answers it without echoing its text.
 */
function authorityRefusal(reply: FastifyReply, error: unknown): FastifyReply {
  const message = error instanceof Error ? error.message : '';
  if (message === 'FORBIDDEN') return reply.code(403).send({ error: 'NOT_AN_ADMINISTRATOR' });
  // Organization-wide authority is derived from enabled repositories, so with none enabled
  // there is nobody who may govern the organization yet: enabling one comes first.
  if (message === 'NO_ENABLED_REPOSITORY') return reply.code(409).send({ error: 'NO_ENABLED_REPOSITORY' });
  throw error;
}

function cookies(request: FastifyRequest): Record<string, string> {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return {};
  return Object.fromEntries(header.split(';').map(part => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }));
}
const setCookie = (reply: FastifyReply, name: string, value: string, options: { maxAge: number; secure: boolean }): void => {
  // HttpOnly keeps a session out of page scripts; SameSite=Lax stops a third-party site
  // from driving an authenticated request on the user's behalf.
  reply.header('set-cookie', `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${options.maxAge}${options.secure ? '; Secure' : ''}`);
};

export function sessionOf(request: FastifyRequest, sessions: SessionSigner): SessionClaims | null {
  return sessions.verify(cookies(request)[SESSION_COOKIE]);
}

export function registerAdminRoutes(app: FastifyInstance, options: AdminOptions): void {
  const secure = options.secureCookies !== false;

  app.get('/auth/github/start', async (_request, reply) => {
    // The state is held in a cookie and echoed back by GitHub; a callback that cannot
    // present the same value did not originate from a sign-in this browser began.
    const state = randomBytes(32).toString('base64url');
    setCookie(reply, STATE_COOKIE, state, { maxAge: 600, secure });
    return reply.code(200).send({ authorizeUrl: options.identity.authorizeUrl(state) });
  });

  app.get('/auth/github/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string };
    const expected = cookies(request)[STATE_COOKIE];
    if (!query.code || !query.state || !expected || !constantEqual(query.state, expected)) {
      return reply.code(400).send({ error: 'INVALID_OAUTH_STATE' });
    }
    const identity = await options.identity.exchange(query.code);
    if (!identity) return reply.code(401).send({ error: 'SIGN_IN_FAILED' });
    setCookie(reply, SESSION_COOKIE, options.sessions.issue(identity.userId, identity.organizationIds), { maxAge: 12 * 60 * 60, secure });
    return reply.code(200).send({ userId: identity.userId, organizationIds: identity.organizationIds });
  });

  app.get('/api/session', async (request, reply) => {
    const claims = sessionOf(request, options.sessions);
    return claims ? reply.code(200).send({ userId: claims.userId, organizationIds: claims.organizationIds })
      : reply.code(401).send({ error: 'NOT_SIGNED_IN' });
  });

  app.post('/api/credentials', async (request, reply) => {
    const claims = sessionOf(request, options.sessions);
    const parsed = SaveCredential.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_REQUEST' });
    let session: SessionClaims;
    try { session = requireOrganization(claims, parsed.data.organizationId); }
    catch { return reply.code(claims ? 403 : 401).send({ error: claims ? 'FORBIDDEN' : 'NOT_SIGNED_IN' }); }
    try {
      const saved = await options.credentials.save(parsed.data.organizationId, parsed.data.provider, parsed.data.secret, session.userId);
      // One-way ingress: the response confirms the save and never echoes the secret (ADR-035).
      return reply.code(201).send({ id: saved.id, provider: parsed.data.provider });
    } catch (error) { return authorityRefusal(reply, error); }
  });

  app.get('/api/credentials', async (request, reply) => {
    const claims = sessionOf(request, options.sessions);
    const organizationId = (request.query as { organizationId?: string }).organizationId ?? '';
    try { requireOrganization(claims, organizationId); }
    catch { return reply.code(claims ? 403 : 401).send({ error: claims ? 'FORBIDDEN' : 'NOT_SIGNED_IN' }); }
    // Metadata only: provider, identifier and timestamps, never the stored value.
    return reply.code(200).send({ credentials: await options.credentials.list(organizationId) });
  });

  app.delete('/api/credentials/:id', async (request, reply) => {
    const claims = sessionOf(request, options.sessions);
    const organizationId = (request.query as { organizationId?: string }).organizationId ?? '';
    const { id } = request.params as { id: string };
    let session: SessionClaims;
    try { session = requireOrganization(claims, organizationId); }
    catch { return reply.code(claims ? 403 : 401).send({ error: claims ? 'FORBIDDEN' : 'NOT_SIGNED_IN' }); }
    try {
      await options.credentials.revoke(organizationId, id, session.userId);
      return reply.code(204).send();
    } catch (error) { return authorityRefusal(reply, error); }
  });

  if (options.repositories) {
    const admin = options.repositories;
    /** Null when the session may act on this organization, otherwise the refusal to send. */
    const refuse = (request: FastifyRequest, organizationId: string): Refusal | null => {
      const claims = sessionOf(request, options.sessions);
      if (claims && claims.organizationIds.includes(organizationId)) return null;
      return claims ? { code: 403, error: 'FORBIDDEN' } : { code: 401, error: 'NOT_SIGNED_IN' };
    };

    app.get('/api/repositories', async (request, reply) => {
      const organizationId = (request.query as { organizationId?: string }).organizationId ?? '';
      const refused = refuse(request, organizationId);
      if (refused) return reply.code(refused.code).send({ error: refused.error });
      return reply.code(200).send({ repositories: await admin.repositories(organizationId) });
    });

    app.post('/api/repositories/enabled', async (request, reply) => {
      const parsed = SetEnabled.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'INVALID_REQUEST' });
      const refused = refuse(request, parsed.data.organizationId);
      if (refused) return reply.code(refused.code).send({ error: refused.error });
      // The store re-checks administrator rights inside the write, so session membership
      // alone never decides which repositories are switched on.
      const actor = sessionOf(request, options.sessions)!.userId;
      const changed = await admin.setEnabled(parsed.data.organizationId, parsed.data.repositoryIds, parsed.data.enabled, actor);
      return reply.code(200).send({ changed, requested: parsed.data.repositoryIds.length });
    });

    app.get('/api/policy', async (request, reply) => {
      const organizationId = (request.query as { organizationId?: string }).organizationId ?? '';
      const refused = refuse(request, organizationId);
      if (refused) return reply.code(refused.code).send({ error: refused.error });
      return reply.code(200).send({ policy: await admin.policy(organizationId) });
    });

    app.put('/api/policy', async (request, reply) => {
      const body = (request.body ?? {}) as { organizationId?: string; policy?: unknown };
      if (typeof body.organizationId !== 'string' || body.policy === undefined) return reply.code(400).send({ error: 'INVALID_REQUEST' });
      const refused = refuse(request, body.organizationId);
      if (refused) return reply.code(refused.code).send({ error: refused.error });
      // Validated on the way in. A stored policy that fails its schema is treated as absent and
      // skips every review, so accepting one here would switch reviewing off without saying so.
      const policy = OrganizationPolicySchema.safeParse(body.policy);
      if (!policy.success) return reply.code(400).send({ error: 'INVALID_POLICY' });
      try {
        await admin.setPolicy(body.organizationId, policy.data, sessionOf(request, options.sessions)!.userId);
        return reply.code(204).send();
      } catch (error) { return authorityRefusal(reply, error); }
    });
  }

  if (options.runnerAdmin) {
    const runnerAdmin = options.runnerAdmin;
    const refuseRunner = (request: FastifyRequest, organizationId: string): Refusal | null => {
      const claims = sessionOf(request, options.sessions);
      if (claims && claims.organizationIds.includes(organizationId)) return null;
      return claims ? { code: 403, error: 'FORBIDDEN' } : { code: 401, error: 'NOT_SIGNED_IN' };
    };

    app.post('/api/runner/enrollments', async (request, reply) => {
      const parsed = CreateEnrollment.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'INVALID_REQUEST' });
      const refused = refuseRunner(request, parsed.data.organizationId);
      if (refused) return reply.code(refused.code).send({ error: refused.error });
      const claims = sessionOf(request, options.sessions)!;
      try {
        const created = await runnerAdmin.createEnrollment(parsed.data.organizationId, parsed.data.repositoryIds, claims.userId);
        // Returned exactly once. Only a hash is stored, so this value can never be read back,
        // and an administrator who loses it creates another rather than recovering this one.
        return reply.code(201).send({ id: created.id, token: created.token, expiresAt: created.expiresAt });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message === 'FORBIDDEN') return reply.code(403).send({ error: 'NOT_A_REPOSITORY_ADMIN' });
        if (message === 'INVALID_SCOPE') return reply.code(400).send({ error: 'INVALID_SCOPE' });
        return reply.code(503).send({ error: 'RUNNER_SERVICE_UNAVAILABLE' });
      }
    });

    app.get('/api/runner/enrollments', async (request, reply) => {
      const organizationId = (request.query as { organizationId?: string }).organizationId ?? '';
      const refused = refuseRunner(request, organizationId);
      if (refused) return reply.code(refused.code).send({ error: refused.error });
      // Metadata only: who minted each invitation, its scope and its state, never the token.
      return reply.code(200).send({ enrollments: await runnerAdmin.enrollments(organizationId) });
    });

    app.delete('/api/runner/enrollments/:id', async (request, reply) => {
      const organizationId = (request.query as { organizationId?: string }).organizationId ?? '';
      const refused = refuseRunner(request, organizationId);
      if (refused) return reply.code(refused.code).send({ error: refused.error });
      const { id } = request.params as { id: string };
      try {
        const cancelled = await runnerAdmin.revokeEnrollment(organizationId, id, sessionOf(request, options.sessions)!.userId);
        // An invitation already used cannot be cancelled: revoke the runner it created instead.
        return cancelled ? reply.code(204).send() : reply.code(409).send({ error: 'ENROLLMENT_NOT_PENDING' });
      } catch (error) { return authorityRefusal(reply, error); }
    });

    app.get('/api/runners', async (request, reply) => {
      const organizationId = (request.query as { organizationId?: string }).organizationId ?? '';
      const refused = refuseRunner(request, organizationId);
      if (refused) return reply.code(refused.code).send({ error: refused.error });
      return reply.code(200).send({ runners: await runnerAdmin.runners(organizationId) });
    });

    app.delete('/api/runners/:id', async (request, reply) => {
      const organizationId = (request.query as { organizationId?: string }).organizationId ?? '';
      const refused = refuseRunner(request, organizationId);
      if (refused) return reply.code(refused.code).send({ error: refused.error });
      const { id } = request.params as { id: string };
      try {
        // Revocation cancels live leases as well as the credential, so work stops immediately.
        await runnerAdmin.revokeRunner(organizationId, id, sessionOf(request, options.sessions)!.userId);
        return reply.code(204).send();
      } catch (error) { return authorityRefusal(reply, error); }
    });
  }
}
