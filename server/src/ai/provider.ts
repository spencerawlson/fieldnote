/**
 * AI provider abstraction.
 *
 * Providers implement three transport primitives — text, structured JSON and
 * multimodal image analysis. The product-level operations named in the product
 * spec (elaborate, structureProject, generateReport, …) live one layer up in
 * `ai/services` and are exposed through the `aiServices` facade, so adding a
 * provider means implementing three methods rather than thirteen.
 */

export type WorkloadClass = 'reasoning' | 'fast' | 'vision';

export interface AiMessageImage {
  /** base64-encoded bytes; providers convert to their own wire format */
  base64: string;
  mimeType: string;
  /** short label shown to the model so it can refer to the image */
  label?: string;
}

export interface CompletionRequest {
  /** Trusted application instructions. Never contains project content. */
  system: string;
  /** The task. May embed untrusted content, but only inside fenced blocks. */
  prompt: string;
  images?: AiMessageImage[];
  workload?: WorkloadClass;
  maxOutputTokens?: number;
  temperature?: number;
  /** Identifies the calling service for usage accounting and mock routing. */
  service: string;
  /**
   * Structured view of the same information the prompt describes. Real
   * providers ignore this; the deterministic mock provider uses it so the
   * product works end-to-end offline and in tests without an API key.
   */
  mockContext?: Record<string, unknown>;
}

export interface JsonCompletionRequest<T> extends CompletionRequest {
  /** JSON schema the response must satisfy. */
  schema: Record<string, unknown>;
  schemaName: string;
  /** Runtime validation; a provider retries once when this throws. */
  validate?: (value: unknown) => T;
}

export interface CompletionUsage {
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  model: string;
  provider: string;
  durationMs: number;
}

export interface CompletionResult<T = string> {
  value: T;
  usage: CompletionUsage;
  raw?: string;
}

export interface AIProvider {
  readonly name: string;
  modelFor(workload: WorkloadClass): string;
  complete(request: CompletionRequest): Promise<CompletionResult<string>>;
  completeJson<T>(request: JsonCompletionRequest<T>): Promise<CompletionResult<T>>;
  /** True when the provider can accept image inputs. */
  readonly supportsVision: boolean;
}

// --- pricing --------------------------------------------------------------

/**
 * USD cents per 1M tokens. Used for the usage meter only — it is advisory, not
 * billing. Unknown models fall back to a mid-range estimate and are flagged in
 * the usage view rather than silently reported as free.
 */
export interface ModelPrice {
  inputCentsPerMTok: number;
  outputCentsPerMTok: number;
  estimated?: boolean;
}

const PRICES: Record<string, ModelPrice> = {
  'gpt-5': { inputCentsPerMTok: 125, outputCentsPerMTok: 1000 },
  'gpt-5-mini': { inputCentsPerMTok: 25, outputCentsPerMTok: 200 },
  'gpt-5-nano': { inputCentsPerMTok: 5, outputCentsPerMTok: 40 },
  'gpt-4.1': { inputCentsPerMTok: 200, outputCentsPerMTok: 800 },
  'gpt-4.1-mini': { inputCentsPerMTok: 40, outputCentsPerMTok: 160 },
  'gpt-4o': { inputCentsPerMTok: 250, outputCentsPerMTok: 1000 },
  'gpt-4o-mini': { inputCentsPerMTok: 15, outputCentsPerMTok: 60 },
  'claude-opus-5': { inputCentsPerMTok: 500, outputCentsPerMTok: 2500 },
  'claude-sonnet-5': { inputCentsPerMTok: 300, outputCentsPerMTok: 1500 },
  'claude-haiku-4-5-20251001': { inputCentsPerMTok: 100, outputCentsPerMTok: 500 },
  mock: { inputCentsPerMTok: 0, outputCentsPerMTok: 0 },
};

const DEFAULT_PRICE: ModelPrice = { inputCentsPerMTok: 100, outputCentsPerMTok: 500, estimated: true };

export function priceFor(model: string): ModelPrice {
  if (PRICES[model]) return PRICES[model]!;
  // Match on family prefix so a dated snapshot inherits its family's price.
  const family = Object.keys(PRICES).find((key) => model.startsWith(key));
  return family ? PRICES[family]! : DEFAULT_PRICE;
}

export function costCents(model: string, inputTokens: number, outputTokens: number): number {
  const price = priceFor(model);
  return (inputTokens / 1e6) * price.inputCentsPerMTok + (outputTokens / 1e6) * price.outputCentsPerMTok;
}

// --- JSON extraction helpers ---------------------------------------------

/**
 * Models occasionally wrap JSON in prose or fences even under a schema
 * constraint. Recover the outermost JSON value rather than failing the job.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to recovery */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* keep trying */
    }
  }
  const start = trimmed.search(/[[{]/);
  if (start !== -1) {
    const opener = trimmed[start];
    const closer = opener === '{' ? '}' : ']';
    const end = trimmed.lastIndexOf(closer);
    if (end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* give up below */
      }
    }
  }
  throw new Error('Model response was not valid JSON');
}
