import { randomBytes } from 'node:crypto';
import { ProviderId, z } from '@humanize/domain';
import { SessionSigner, constantEqual, requireOrganization } from '@humanize/security';
import type { SessionClaims } from '@humanize/security';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** Exchanges an OAuth code for an identity. Injected so sign-in is testable without GitHub. */
export interface IdentityProvider {
  authorizeUrl(state: string): string;
  exchange(code: string): Promise<{ userId: string; organizationIds: string[] } | null>;
}
/** Credential storage. A saved secret is never read back out through this port. */
export interface CredentialAdmin {
  save(organizationId: string, provider: string, secret: string): Promise<{ id: string }>;
  list(organizationId: string): Promise<{ id: string; provider: string; createdAt: string; revokedAt: string | null }[]>;
  revoke(organizationId: string, id: string): Promise<void>;
}
/** Repository and policy administration. The admin check runs inside the write (S16-T02). */
export interface RepositoryAdmin {
  repositories(organizationId: string): Promise<{ id: string; owner: string; name: string; enabled: boolean }[]>;
  setEnabled(organizationId: string, repositoryIds: readonly string[], enabled: boolean): Promise<string[]>;
  policy(organizationId: string): Promise<unknown | null>;
  setPolicy(organizationId: string, policy: unknown): Promise<void>;
}
export interface AdminOptions {
  sessions: SessionSigner; identity: IdentityProvider; credentials: CredentialAdmin;
  repositories?: RepositoryAdmin; secureCookies?: boolean;
}

interface Refusal { code: 401 | 403; error: 'NOT_SIGNED_IN' | 'FORBIDDEN' }
const SESSION_COOKIE = 'humanize_session';
const STATE_COOKIE = 'humanize_oauth_state';
const SetEnabled = z.object({ organizationId: z.string().min(1).max(200), repositoryIds: z.array(z.string().uuid()).min(1).max(500), enabled: z.boolean() }).strict();
const SaveCredential = z.object({ organizationId: z.string().min(1).max(200), provider: ProviderId, secret: z.string().min(8).max(65536) }).strict();

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
    try { requireOrganization(claims, parsed.data.organizationId); }
    catch { return reply.code(claims ? 403 : 401).send({ error: claims ? 'FORBIDDEN' : 'NOT_SIGNED_IN' }); }
    const saved = await options.credentials.save(parsed.data.organizationId, parsed.data.provider, parsed.data.secret);
    // One-way ingress: the response confirms the save and never echoes the secret (ADR-035).
    return reply.code(201).send({ id: saved.id, provider: parsed.data.provider });
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
    try { requireOrganization(claims, organizationId); }
    catch { return reply.code(claims ? 403 : 401).send({ error: claims ? 'FORBIDDEN' : 'NOT_SIGNED_IN' }); }
    await options.credentials.revoke(organizationId, id);
    return reply.code(204).send();
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
      const changed = await admin.setEnabled(parsed.data.organizationId, parsed.data.repositoryIds, parsed.data.enabled);
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
      await admin.setPolicy(body.organizationId, body.policy);
      return reply.code(204).send();
    });
  }
}
