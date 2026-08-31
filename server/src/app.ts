import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { config } from './config.ts';
import { AppError } from './lib/core.ts';
import { countEvent, logger, observeDuration } from './lib/logger.ts';
import { csrfGuard, loadSession } from './security/auth.ts';
import { registerRoutes } from './routes/index.ts';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // structured logging is handled by lib/logger with redaction
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    disableRequestLogging: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // The SPA is bundled and served from this origin; images may be data:
        // URIs for inline previews. No external origins are permitted.
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
  });

  await app.register(cookie, { secret: config.security.sessionSecret });

  await app.register(multipart, {
    limits: {
      fileSize: config.storage.maxUploadBytes,
      files: 20,
      fields: 20,
      fieldSize: 64 * 1024,
    },
  });

  await app.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (request) => `${request.ip}:${request.user?.id ?? 'anon'}`,
  });

  // --- CORS for the Vite dev server only -----------------------------------
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && config.security.allowedOrigins.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Headers', 'content-type,x-fieldnote-csrf');
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    }
    if (request.method === 'OPTIONS') {
      reply.code(204).send();
    }
  });

  app.addHook('onRequest', async (request) => {
    await loadSession(request);
  });

  app.addHook('preHandler', async (request) => {
    await csrfGuard(request);
  });

  // --- request metrics -----------------------------------------------------
  app.addHook('onResponse', async (request, reply) => {
    const route = (request.routeOptions?.url ?? request.url).split('?')[0]!;
    observeDuration(`http ${request.method} ${route}`, reply.elapsedTime);
    countEvent(`http.${reply.statusCode}`);
  });

  // --- unified error shape -------------------------------------------------
  app.setErrorHandler((rawError: unknown, request, reply) => {
    const error = rawError as Error & { statusCode?: number };
    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        logger.error({ err: error.message, code: error.code, url: request.url }, 'Request failed');
      }
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details ?? undefined },
      });
    }

    const statusCode = error.statusCode;
    if (statusCode === 413) {
      return reply.code(413).send({
        error: { code: 'payload_too_large', message: 'The upload exceeds the configured size limit.' },
      });
    }
    if (statusCode && statusCode < 500) {
      return reply.code(statusCode).send({ error: { code: 'bad_request', message: error.message } });
    }

    // Unexpected: log with detail, return without it.
    logger.error({ err: error.message, stack: error.stack, url: request.url }, 'Unhandled error');
    return reply.code(500).send({
      error: { code: 'internal_error', message: 'Something went wrong. The failure has been logged.' },
    });
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such endpoint' } });
    }
    // SPA fallback: serve index.html for client-side routes.
    if (existsSync(config.web.distPath)) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.code(404).send({
      error: {
        code: 'ui_not_built',
        message: 'The web interface has not been built. Run `npm run build` first, or use the Vite dev server.',
      },
    });
  });

  await registerRoutes(app);

  if (existsSync(config.web.distPath)) {
    await app.register(fastifyStatic, {
      root: config.web.distPath,
      prefix: '/',
      // Hashed asset filenames are safe to cache hard; index.html must not be.
      setHeaders: (res, path) => {
        if (path.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
        else if (/\.[0-9a-f]{8,}\./.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
  } else {
    logger.warn({ path: config.web.distPath }, 'Web build not found — API only');
  }

  return app;
}
