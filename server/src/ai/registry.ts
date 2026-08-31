import type { AIProvider, CompletionRequest, JsonCompletionRequest } from './provider.ts';
import { OpenAiProvider } from './providers/openai.ts';
import { AnthropicProvider } from './providers/anthropic.ts';
import { MockProvider } from './providers/mock.ts';
import { config } from '../config.ts';
import { getDb, type Database } from '../db/index.ts';
import { monthlySpendCents, readCache, recordAiRun, writeCache } from '../db/repositories/system.ts';
import { AppError, stableHash } from '../lib/core.ts';
import { logger } from '../lib/logger.ts';

let provider: AIProvider | null = null;

export function getProvider(): AIProvider {
  if (provider) return provider;
  switch (config.ai.provider) {
    case 'openai':
      provider = new OpenAiProvider();
      break;
    case 'anthropic':
      provider = new AnthropicProvider();
      break;
    default:
      provider = new MockProvider();
      break;
  }
  if (config.ai.provider === 'mock' && config.ai.configuredProvider !== 'mock') {
    logger.warn(
      { configured: config.ai.configuredProvider },
      'No API key configured for the selected AI provider — running in deterministic offline mode',
    );
  }
  return provider;
}

/** Test seam: swap in a provider without touching configuration. */
export function setProvider(next: AIProvider | null): void {
  provider = next;
}

export interface CallContext {
  db?: Database;
  projectId?: string | null;
  userId?: string | null;
  /** When set, an identical request within the same project reuses the result. */
  cacheKeyParts?: unknown;
  /** Skip the cache even when a key is supplied (explicit "regenerate"). */
  bypassCache?: boolean;
}

function budgetGuard(db: Database, ctx: CallContext): void {
  if (config.ai.userMonthlyCents > 0 && ctx.userId) {
    const spent = monthlySpendCents(db, 'user', ctx.userId);
    if (spent >= config.ai.userMonthlyCents) {
      throw new AppError(429, 'ai_budget_exceeded', 'Your monthly AI usage limit has been reached.');
    }
  }
  if (config.ai.projectMonthlyCents > 0 && ctx.projectId) {
    const spent = monthlySpendCents(db, 'project', ctx.projectId);
    if (spent >= config.ai.projectMonthlyCents) {
      throw new AppError(429, 'ai_budget_exceeded', "This project's monthly AI usage limit has been reached.");
    }
  }
}

function cacheKeyFor(service: string, model: string, parts: unknown): string {
  return stableHash({ service, model, parts });
}

/**
 * Runs a structured AI call with usage accounting, caching and error recording.
 * Every AI request in the product goes through here — nothing calls a provider
 * SDK directly.
 */
export async function callJson<T>(
  request: Omit<JsonCompletionRequest<T>, 'system'> & { system: string },
  ctx: CallContext = {},
): Promise<T> {
  const db = ctx.db ?? getDb();
  const impl = getProvider();
  const model = impl.modelFor(request.workload ?? 'fast');

  const cacheKey = ctx.cacheKeyParts !== undefined ? cacheKeyFor(request.service, model, ctx.cacheKeyParts) : null;
  if (cacheKey && !ctx.bypassCache) {
    const cached = readCache<T>(db, cacheKey);
    if (cached !== undefined) {
      recordAiRun(db, {
        projectId: ctx.projectId,
        userId: ctx.userId,
        service: request.service,
        provider: impl.name,
        model,
        status: 'cached',
        cacheKey,
      });
      return cached;
    }
  }

  budgetGuard(db, ctx);

  try {
    const result = await impl.completeJson<T>(request);
    recordAiRun(db, {
      projectId: ctx.projectId,
      userId: ctx.userId,
      service: request.service,
      provider: impl.name,
      model: result.usage.model,
      status: 'ok',
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costCents: result.usage.costCents,
      durationMs: result.usage.durationMs,
      cacheKey,
    });
    if (cacheKey) writeCache(db, cacheKey, request.service, model, result.value);
    return result.value;
  } catch (error) {
    recordAiRun(db, {
      projectId: ctx.projectId,
      userId: ctx.userId,
      service: request.service,
      provider: impl.name,
      model,
      status: 'error',
      error: (error as Error).message,
    });
    throw error;
  }
}

export async function callText(request: CompletionRequest, ctx: CallContext = {}): Promise<string> {
  const db = ctx.db ?? getDb();
  const impl = getProvider();
  const model = impl.modelFor(request.workload ?? 'fast');
  budgetGuard(db, ctx);
  try {
    const result = await impl.complete(request);
    recordAiRun(db, {
      projectId: ctx.projectId,
      userId: ctx.userId,
      service: request.service,
      provider: impl.name,
      model: result.usage.model,
      status: 'ok',
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costCents: result.usage.costCents,
      durationMs: result.usage.durationMs,
    });
    return result.value;
  } catch (error) {
    recordAiRun(db, {
      projectId: ctx.projectId,
      userId: ctx.userId,
      service: request.service,
      provider: impl.name,
      model,
      status: 'error',
      error: (error as Error).message,
    });
    throw error;
  }
}

export function providerInfo() {
  const impl = getProvider();
  return {
    name: impl.name,
    configured: config.ai.configuredProvider,
    offline: impl.name === 'mock',
    supportsVision: impl.supportsVision,
    models: {
      reasoning: impl.modelFor('reasoning'),
      fast: impl.modelFor('fast'),
      vision: impl.modelFor('vision'),
    },
  };
}
