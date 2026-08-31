import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Minimal .env loader. Node 24 has --env-file but we also want the file to be
 * optional and to work when the process is started by a test runner.
 */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(join(ROOT, '.env'));

const str = (key: string, fallback = ''): string => process.env[key]?.trim() || fallback;
const num = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const bool = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
};
const abs = (p: string): string => (resolve(p) === p ? p : resolve(ROOT, p));

export type AppConfig = ReturnType<typeof buildConfig>;

function buildConfig() {
  const env = str('NODE_ENV', 'development');
  const isTest = env === 'test';
  const isProd = env === 'production';

  const aiProvider = str('AI_PROVIDER', 'openai');
  const openaiKey = str('OPENAI_API_KEY');
  const anthropicKey = str('ANTHROPIC_API_KEY');
  const keyFor = (provider: string): string =>
    provider === 'openai' ? openaiKey : provider === 'anthropic' ? anthropicKey : 'n/a';

  return {
    env,
    isProd,
    isTest,
    port: num('PORT', 4000),
    // Bind address. The desktop shell sets this to 127.0.0.1 so an installed
    // app never listens on the network; server deployments override it or sit
    // behind a proxy.
    host: str('HOST', '0.0.0.0'),
    appUrl: str('APP_URL', `http://localhost:${num('PORT', 4000)}`),
    logLevel: str('LOG_LEVEL', isTest ? 'silent' : 'info'),

    security: {
      // A missing secret is fatal in production; in dev we derive a stable
      // throwaway so a fresh clone boots without ceremony.
      sessionSecret: str('SESSION_SECRET') || (isProd ? '' : 'dev-only-insecure-session-secret'),
      sessionTtlSeconds: num('SESSION_TTL_SECONDS', 60 * 60 * 24 * 7),
      allowedOrigins: str('ALLOWED_ORIGINS', 'http://localhost:4000,http://localhost:5173')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    },

    db: {
      path: str('DATABASE_PATH', './storage/fieldnote.db') === ':memory:'
        ? ':memory:'
        : abs(str('DATABASE_PATH', './storage/fieldnote.db')),
    },

    storage: {
      driver: str('STORAGE_DRIVER', 'local'),
      path: abs(str('STORAGE_PATH', './storage/uploads')),
      maxUploadBytes: num('MAX_UPLOAD_BYTES', 25 * 1024 * 1024),
      maxUploadsPerProject: num('MAX_UPLOADS_PER_PROJECT', 500),
    },

    ai: {
      // Fall back to the deterministic mock when no key is configured so the
      // product is fully usable (and testable) offline.
      provider: keyFor(aiProvider) ? aiProvider : 'mock',
      configuredProvider: aiProvider,
      openaiKey,
      openaiBaseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      anthropicKey,
      models: {
        reasoning: str('AI_MODEL_REASONING', 'gpt-5'),
        fast: str('AI_MODEL_FAST', 'gpt-5-mini'),
        vision: str('AI_MODEL_VISION', 'gpt-5-mini'),
      },
      maxOutputTokens: num('AI_MAX_OUTPUT_TOKENS', 8000),
      timeoutMs: num('AI_REQUEST_TIMEOUT_MS', 120_000),
      maxRetries: num('AI_MAX_RETRIES', 2),
      userMonthlyCents: num('AI_USER_MONTHLY_CENTS', 0),
      projectMonthlyCents: num('AI_PROJECT_MONTHLY_CENTS', 0),
    },

    ocr: {
      driver: str('OCR_DRIVER', 'vision'),
    },

    jobs: {
      enabled: bool('JOB_WORKER_ENABLED', !isTest),
      concurrency: num('JOB_CONCURRENCY', 2),
      pollIntervalMs: num('JOB_POLL_INTERVAL_MS', 500),
    },

    web: {
      distPath: join(ROOT, 'web', 'dist'),
    },
  };
}

export const config = buildConfig();

export function assertProductionConfig(cfg: AppConfig = config): void {
  if (!cfg.isProd) return;
  const problems: string[] = [];
  if (!cfg.security.sessionSecret || cfg.security.sessionSecret.length < 32) {
    problems.push('SESSION_SECRET must be set to at least 32 characters in production');
  }
  if (cfg.ai.configuredProvider === 'openai' && !cfg.ai.openaiKey) {
    problems.push('OPENAI_API_KEY is required when AI_PROVIDER=openai');
  }
  if (cfg.ai.configuredProvider === 'anthropic' && !cfg.ai.anthropicKey) {
    problems.push('ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic');
  }
  if (cfg.db.path === ':memory:') {
    problems.push('DATABASE_PATH must be a real file in production');
  }
  if (problems.length > 0) {
    throw new Error(`Invalid production configuration:\n - ${problems.join('\n - ')}`);
  }
}
