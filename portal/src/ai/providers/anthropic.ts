/**
 * Anthropic Messages API provider.
 *
 * POST https://api.anthropic.com/v1/messages
 *   headers: x-api-key, anthropic-version, content-type
 *   body:    { model, max_tokens, system, messages: [{role, content}], temperature }
 *   response:{ id, model, content: [{type:'text', text}], usage:{input_tokens, output_tokens} }
 *
 * Raw fetch, no SDK — one less dependency to track and one less supply-chain
 * surface in a system that holds financial records.
 */

import { config } from '../../config.js';
import {
  AiNotConfiguredError,
  AiProviderError,
  coerceJson,
  fetchWithTimeout,
  type AiProvider,
  type AiRequest,
  type AiResponse,
} from '../provider.js';

export const ANTHROPIC_PROVIDER_NAME = 'anthropic';

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicResponseBody {
  model?: string;
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

export class AnthropicProvider implements AiProvider {
  readonly name = ANTHROPIC_PROVIDER_NAME;

  constructor(
    private readonly apiKey: string = config.ANTHROPIC_API_KEY,
    private readonly model: string = config.ANTHROPIC_MODEL,
    private readonly baseUrl: string = config.ANTHROPIC_BASE_URL,
    private readonly apiVersion: string = config.ANTHROPIC_VERSION,
  ) {}

  /** True when a key is present. Callers use this to fall back to the stub. */
  isConfigured(): boolean {
    return this.apiKey.trim().length > 0;
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    if (!this.isConfigured()) {
      throw new AiNotConfiguredError(this.name, 'ANTHROPIC_API_KEY');
    }

    // The API has no structured-output parameter, so the schema goes in the
    // system prompt where the model can actually honour it.
    const system = req.jsonSchema
      ? `${req.system}\n\n---\n\nYour reply must validate against this JSON Schema:\n${JSON.stringify(req.jsonSchema)}`
      : req.system;

    const body = {
      model: this.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };

    const res = await fetchWithTimeout(
      `${this.baseUrl.replace(/\/$/, '')}/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': this.apiVersion,
        },
        body: JSON.stringify(body),
      },
      req.timeoutMs ?? config.AI_TIMEOUT_MS,
      this.name,
    );

    const raw = await res.text();
    if (!res.ok) {
      let message = raw.slice(0, 500);
      try {
        const parsed = JSON.parse(raw) as AnthropicResponseBody;
        if (parsed.error?.message) message = `${parsed.error.type ?? 'error'}: ${parsed.error.message}`;
      } catch {
        // Keep the truncated raw body.
      }
      throw new AiProviderError(this.name, res.status, `Anthropic returned ${res.status}: ${message}`);
    }

    let parsed: AnthropicResponseBody;
    try {
      parsed = JSON.parse(raw) as AnthropicResponseBody;
    } catch (err) {
      throw new AiProviderError(this.name, res.status, 'Anthropic returned a non-JSON body.', err);
    }

    const text = (parsed.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('')
      .trim();

    if (!text) {
      throw new AiProviderError(this.name, res.status, 'Anthropic returned no text content.');
    }

    const json = coerceJson(text);
    return {
      text,
      ...(json !== undefined ? { json } : {}),
      inputTokens: parsed.usage?.input_tokens ?? 0,
      outputTokens: parsed.usage?.output_tokens ?? 0,
      model: parsed.model ?? this.model,
    };
  }
}
