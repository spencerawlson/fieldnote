import OpenAI from 'openai';
import type {
  AIProvider,
  CompletionRequest,
  CompletionResult,
  JsonCompletionRequest,
  WorkloadClass,
} from '../provider.ts';
import { costCents, extractJson } from '../provider.ts';
import { config } from '../../config.ts';
import { upstreamFailure, withRetry } from '../../lib/core.ts';

/**
 * OpenAI provider. Uses the Responses API, which handles both the reasoning
 * models and multimodal input through one code path.
 */
export class OpenAiProvider implements AIProvider {
  readonly name = 'openai';
  readonly supportsVision = true;
  private client: OpenAI;

  constructor(apiKey = config.ai.openaiKey, baseURL = config.ai.openaiBaseUrl) {
    this.client = new OpenAI({
      apiKey,
      baseURL,
      timeout: config.ai.timeoutMs,
      maxRetries: 0, // retries are handled here so they are logged and bounded
    });
  }

  modelFor(workload: WorkloadClass): string {
    return config.ai.models[workload] ?? config.ai.models.fast;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult<string>> {
    const model = this.modelFor(request.workload ?? 'fast');
    const started = Date.now();
    const response = await this.call(model, request);
    const text = response.output_text?.trim() ?? '';
    if (!text) throw upstreamFailure('The model returned an empty response');
    return {
      value: text,
      usage: this.usage(model, response, started),
      raw: text,
    };
  }

  async completeJson<T>(request: JsonCompletionRequest<T>): Promise<CompletionResult<T>> {
    const model = this.modelFor(request.workload ?? 'fast');
    const started = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.call(model, request, {
        schema: request.schema,
        schemaName: request.schemaName,
        repair: attempt > 0 ? lastError?.message : undefined,
      });
      const raw = response.output_text ?? '';
      try {
        const parsed = extractJson(raw);
        const value = request.validate ? request.validate(parsed) : (parsed as T);
        return { value, usage: this.usage(model, response, started), raw };
      } catch (error) {
        lastError = error as Error;
      }
    }
    throw upstreamFailure(`Model output failed validation: ${lastError?.message ?? 'unknown'}`);
  }

  private async call(
    model: string,
    request: CompletionRequest,
    json?: { schema: Record<string, unknown>; schemaName: string; repair?: string },
  ) {
    const content: OpenAI.Responses.ResponseInputContent[] = [
      { type: 'input_text', text: json?.repair ? `${request.prompt}\n\nYour previous response was rejected: ${json.repair}\nReturn only valid JSON matching the schema.` : request.prompt },
    ];
    for (const image of request.images ?? []) {
      if (image.label) content.push({ type: 'input_text', text: `Image: ${image.label}` });
      content.push({
        type: 'input_image',
        image_url: `data:${image.mimeType};base64,${image.base64}`,
        detail: 'auto',
      });
    }

    return withRetry(
      () =>
        this.client.responses.create({
          model,
          instructions: request.system,
          input: [{ role: 'user', content }],
          max_output_tokens: request.maxOutputTokens ?? config.ai.maxOutputTokens,
          ...(json
            ? {
                text: {
                  format: {
                    type: 'json_schema' as const,
                    name: json.schemaName,
                    schema: json.schema,
                    strict: false,
                  },
                },
              }
            : {}),
        }),
      {
        retries: config.ai.maxRetries,
        shouldRetry: (error) => isRetryable(error),
      },
    ).catch((error: unknown) => {
      throw toAppError(error);
    });
  }

  private usage(model: string, response: { usage?: { input_tokens?: number; output_tokens?: number } | null }, started: number) {
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    return {
      inputTokens,
      outputTokens,
      costCents: costCents(model, inputTokens, outputTokens),
      model,
      provider: this.name,
      durationMs: Date.now() - started,
    };
  }
}

function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  if (status === undefined) return true; // network/timeout
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function toAppError(error: unknown) {
  const status = (error as { status?: number }).status;
  const message = (error as { message?: string }).message ?? 'AI request failed';
  if (status === 401) return upstreamFailure('The AI provider rejected the API key. Check OPENAI_API_KEY.');
  if (status === 429) return upstreamFailure('The AI provider is rate limiting requests. Try again shortly.');
  return upstreamFailure(`AI request failed: ${message}`);
}
