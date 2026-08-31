import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.ts';
import { countUsers, createUser, getUserByEmail, touchLogin, audit } from '../db/repositories/system.ts';
import { hashPassword, verifyPassword, conflict, unauthorized } from '../lib/core.ts';
import { clearSession, issueSession, requireUser } from '../security/auth.ts';
import { parse, text, z } from '../lib/validate.ts';

const credentialsSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(10, 'Use at least 10 characters').max(200),
});

const registerSchema = credentialsSchema.extend({
  name: text(120, 1),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/register', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const body = parse(registerSchema, request.body);
    const db = getDb();

    if (getUserByEmail(db, body.email)) {
      throw conflict('An account with that email already exists');
    }

    // The first account to register owns the instance.
    const role = countUsers(db) === 0 ? 'admin' : 'user';
    const user = createUser(db, {
      email: body.email,
      name: body.name,
      passwordHash: hashPassword(body.password),
      role,
    });

    const { csrfToken } = issueSession(request, reply, user.id);
    audit(db, { userId: user.id, action: 'auth.register', ip: request.ip });

    return reply.code(201).send({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      csrfToken,
    });
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const body = parse(credentialsSchema, request.body);
    const db = getDb();
    const user = getUserByEmail(db, body.email);

    // Same failure for unknown email and wrong password, and the password is
    // still hashed when the user does not exist so timing does not leak.
    const placeholder = '$scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA';
    const valid = user ? verifyPassword(body.password, user.passwordHash) : verifyPassword(body.password, placeholder);
    if (!user || !valid) {
      audit(db, { userId: user?.id ?? null, action: 'auth.login.failed', ip: request.ip, detail: { email: body.email } });
      throw unauthorized('Email or password is incorrect');
    }

    touchLogin(db, user.id);
    const { csrfToken } = issueSession(request, reply, user.id);
    audit(db, { userId: user.id, action: 'auth.login', ip: request.ip });

    return { user: { id: user.id, email: user.email, name: user.name, role: user.role }, csrfToken };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const user = request.user;
    clearSession(request, reply);
    if (user) audit(getDb(), { userId: user.id, action: 'auth.logout', ip: request.ip });
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => {
    const user = requireUser(request);
    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      csrfToken: request.csrfToken,
    };
  });
}
