import { config } from '../config.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<string, number> = { silent: 100, error: 40, warn: 30, info: 20, debug: 10 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info!;

/**
 * Field-level redaction. Observability must never become an exfiltration path
 * for the very content this product is careful about.
 */
const SENSITIVE_KEYS = /^(password|token|secret|apiKey|api_key|authorization|cookie|sessionSecret|ocrText|userDescription|notes|prompt)$/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 400 ? `${value.slice(0, 400)}…[truncated]` : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.test(key) ? '[redacted]' : scrub(val, depth + 1);
  }
  return out;
}

function emit(level: Level, context: unknown, message: string): void {
  if (LEVELS[level]! < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(context && typeof context === 'object' ? (scrub(context) as Record<string, unknown>) : {}),
  };
  const text = JSON.stringify(line);
  if (level === 'error') process.stderr.write(`${text}\n`);
  else process.stdout.write(`${text}\n`);
}

function make(level: Level) {
  return (contextOrMessage: unknown, maybeMessage?: string): void => {
    if (typeof contextOrMessage === 'string') emit(level, undefined, contextOrMessage);
    else emit(level, contextOrMessage, maybeMessage ?? '');
  };
}

export const logger = {
  debug: make('debug'),
  info: make('info'),
  warn: make('warn'),
  error: make('error'),
};

// --- lightweight metrics --------------------------------------------------

const counters = new Map<string, number>();
const durations = new Map<string, number[]>();

export function countEvent(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function observeDuration(name: string, ms: number): void {
  const list = durations.get(name) ?? [];
  list.push(ms);
  if (list.length > 500) list.shift();
  durations.set(name, list);
}

export function metricsSnapshot() {
  const latency: Record<string, { count: number; p50: number; p95: number; max: number }> = {};
  for (const [name, values] of durations) {
    const sorted = [...values].sort((a, b) => a - b);
    latency[name] = {
      count: sorted.length,
      p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
      p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
    };
  }
  return { counters: Object.fromEntries(counters), latency, uptimeSeconds: Math.round(process.uptime()) };
}
