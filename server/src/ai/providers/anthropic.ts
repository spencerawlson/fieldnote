import Anthropic from '@anthropic-ai/sdk';
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
 * Anthropic provider — the second implementation, kept in the tree to prove the
 * abstraction holds and to give operators a switch if one vendor is degraded.
 */
export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  readonly supportsVision = true;
  private client: Anthropic;

  constructor(apiKey = config.ai.anthropicKey) {
    this.client = new Anthropic({ apiKey, timeout: config.ai.timeoutMs, maxRetries: 0 });
  }

  modelFor(workload: WorkloadClass): string {
    return config.ai.models[workload] ?? config.ai.models.fast;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult<string>> {
    const model = this.modelFor(request.workload ?? 'fast');
    const started = Date.now();
    const message = await this.call(model, request);
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (!text) throw upstreamFailure('The model returned an empty response');
    return { value: text, usage: this.usage(model, message, started), raw: text };
  }

  async completeJson<T>(request: JsonCompletionRequest<T>): Promise<CompletionResult<T>> {
    const model = this.modelFor(request.workload ?? 'fast');
    const started = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const message = await this.call(model, {
        ...request,
        prompt: buildJsonPrompt(request, attempt > 0 ? lastError?.message : undefined),
      });
      const raw = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      try {
        const parsed = extractJson(raw);
        const value = request.validate ? request.validate(parsed) : (parsed as T);
        return { value, usage: this.usage(model, message, started), raw };
      } catch (error) {
        lastError = error as Error;
      }
    }
    throw upstreamFailure(`Model output failed validation: ${lastError?.message ?? 'unknown'}`);
  }

  private async call(model: string, request: CompletionRequest) {
    const content: Anthropic.ContentBlockParam[] = [];
    for (const image of request.images ?? []) {
      if (image.label) content.push({ type: 'text', text: `Image: ${image.label}` });
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mimeType as 'image/png', data: image.base64 },
      });
    }
    content.push({ type: 'text', text: request.prompt });

    return withRetry(
      () =>
        this.client.messages.create({
          model,
          system: request.system,
          messages: [{ role: 'user', content }],
          max_tokens: request.maxOutputTokens ?? config.ai.maxOutputTokens,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        }),
      { retries: config.ai.maxRetries, shouldRetry: (error) => isRetryable(error) },
    ).catch((error: unknown) => {
      const status = (error as { status?: number }).status;
      if (status === 401) throw upstreamFailure('The AI provider rejected the API key. Check ANTHROPIC_API_KEY.');
      throw upstreamFailure(`AI request failed: ${(error as Error).message}`);
    });
  }

  private usage(model: string, message: Anthropic.Message, started: number) {
    const inputTokens = message.usage?.input_tokens ?? 0;
    const outputTokens = message.usage?.output_tokens ?? 0;
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

function buildJsonPrompt(request: JsonCompletionRequest<unknown>, repair?: string): string {
  const schema = JSON.stringify(request.schema, null, 2);
  return [
    request.prompt,
    '',
    'Respond with a single JSON value and nothing else. No prose, no code fences.',
    'It must satisfy this JSON schema:',
    schema,
    repair ? `\nYour previous response was rejected: ${repair}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  if (status === undefined) return true;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
