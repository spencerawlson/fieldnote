import { createHmac } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { getDb } from '../db/index.ts';
import {
  createSession,
  deleteSession,
  getSession,
  getUser,
  type UserRecord,
} from '../db/repositories/system.ts';
import { getMemberRole, getProject, type MemberRole } from '../db/repositories/projects.ts';
import { forbidden, notFound, randomToken, safeEqual, unauthorized } from '../lib/core.ts';

/**
 * Session authentication.
 *
 * The cookie carries `sessionId.hmac`. The HMAC means a stolen or guessed id is
 * useless without the server secret, and it lets us reject forged cookies
 * without a database round-trip. Sessions are server-side rows, so logout and
 * revocation are immediate — which a self-contained JWT could not give us.
 */

export const SESSION_COOKIE = 'fieldnote_session';
export const CSRF_HEADER = 'x-fieldnote-csrf';

function sign(value: string): string {
  return createHmac('sha256', config.security.sessionSecret).update(value).digest('base64url');
}

export function encodeCookie(sessionId: string): string {
  return `${sessionId}.${sign(sessionId)}`;
}

export function decodeCookie(raw: string | undefined): string | null {
  if (!raw) return null;
  const index = raw.lastIndexOf('.');
  if (index <= 0) return null;
  const id = raw.slice(0, index);
  const mac = raw.slice(index + 1);
  return safeEqual(mac, sign(id)) ? id : null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserRecord;
    sessionId?: string;
    csrfToken?: string;
  }
}

export function issueSession(request: FastifyRequest, reply: FastifyReply, userId: string): { csrfToken: string } {
  const db = getDb();
  const csrfToken = randomToken(24);
  const session = createSession(db, {
    userId,
    csrfToken,
    userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
    ip: request.ip,
    ttlSeconds: config.security.sessionTtlSeconds,
  });
  reply.setCookie(SESSION_COOKIE, encodeCookie(session.id), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    path: '/',
    maxAge: config.security.sessionTtlSeconds,
  });
  return { csrfToken };
}

export function clearSession(request: FastifyRequest, reply: FastifyReply): void {
  const id = decodeCookie(request.cookies[SESSION_COOKIE]);
  if (id) deleteSession(getDb(), id);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Populates request.user when a valid session cookie is present. */
export async function loadSession(request: FastifyRequest): Promise<void> {
  const id = decodeCookie(request.cookies[SESSION_COOKIE]);
  if (!id) return;
  const db = getDb();
  const session = getSession(db, id);
  if (!session) return;
  const user = getUser(db, session.userId);
  if (!user) return;
  request.user = user;
  request.sessionId = session.id;
  request.csrfToken = session.csrfToken;
}

export function requireUser(request: FastifyRequest): UserRecord {
  if (!request.user) throw unauthorized();
  return request.user;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF: double-submit against the server-side session token, plus an Origin
 * check. Cookies are SameSite=Lax, so this is defence in depth rather than the
 * only barrier.
 */
export async function csrfGuard(request: FastifyRequest): Promise<void> {
  if (SAFE_METHODS.has(request.method)) return;
  if (!request.user) return; // unauthenticated mutations are rejected by the route itself

  const origin = request.headers.origin;
  if (origin && !config.security.allowedOrigins.includes(origin)) {
    throw forbidden('Request origin is not allowed');
  }

  const supplied = request.headers[CSRF_HEADER] as string | undefined;
  if (!supplied || !request.csrfToken || !safeEqual(supplied, request.csrfToken)) {
    throw forbidden('Missing or invalid CSRF token');
  }
}

// --- project authorization ------------------------------------------------

const RANK: Record<MemberRole, number> = { viewer: 1, editor: 2, owner: 3 };

/**
 * Resolves a project the user may access, at the required permission level.
 * Returns 404 rather than 403 for projects the user is not a member of, so the
 * API does not confirm the existence of other people's projects.
 */
export function authorizeProject(
  request: FastifyRequest,
  projectId: string,
  required: MemberRole = 'viewer',
) {
  const user = requireUser(request);
  const db = getDb();
  const project = getProject(db, projectId);
  if (!project) throw notFound('Project');
  const role = getMemberRole(db, projectId, user.id);
  if (!role) throw notFound('Project');
  if (RANK[role] < RANK[required]) {
    throw forbidden(`This action requires ${required} access; you have ${role} access.`);
  }
  return { project, role, user, db };
}
