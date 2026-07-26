/**
 * OpenAI Chat Completions provider.
 *
 * POST https://api.openai.com/v1/chat/completions
 *   headers: Authorization: Bearer <key>, content-type
 *   body:    { model, messages: [{role:'system'|'user'|'assistant', content}],
 *              max_tokens, temperature, response_format? }
 *   response:{ id, model, choices:[{message:{content}}],
 *              usage:{prompt_tokens, completion_tokens} }
 *
 * Raw fetch, no SDK — same reasoning as the Anthropic provider.
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

export const OPENAI_PROVIDER_NAME = 'openai';

interface OpenAiResponseBody {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { type?: string; message?: string };
}

export class OpenAiProvider implements AiProvider {
  readonly name = OPENAI_PROVIDER_NAME;

  constructor(
    private readonly apiKey: string = config.OPENAI_API_KEY,
    private readonly model: string = config.OPENAI_MODEL,
    private readonly baseUrl: string = config.OPENAI_BASE_URL,
  ) {}

  isConfigured(): boolean {
    return this.apiKey.trim().length > 0;
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    if (!this.isConfigured()) {
      throw new AiNotConfiguredError(this.name, 'OPENAI_API_KEY');
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: req.system },
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      max_tokens: req.maxTokens,
      temperature: req.temperature,
    };
    // Every task in this layer asks for a JSON object, so JSON mode is always
    // correct here. Note the API requires the word "JSON" in the prompt, which
    // prompts.ts OUTPUT_CONTRACT guarantees.
    if (req.jsonSchema) {
      body['response_format'] = { type: 'json_object' };
    }

    const res = await fetchWithTimeout(
      `${this.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
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
        const parsed = JSON.parse(raw) as OpenAiResponseBody;
        if (parsed.error?.message) message = `${parsed.error.type ?? 'error'}: ${parsed.error.message}`;
      } catch {
        // Keep the truncated raw body.
      }
      throw new AiProviderError(this.name, res.status, `OpenAI returned ${res.status}: ${message}`);
    }

    let parsed: OpenAiResponseBody;
    try {
      parsed = JSON.parse(raw) as OpenAiResponseBody;
    } catch (err) {
      throw new AiProviderError(this.name, res.status, 'OpenAI returned a non-JSON body.', err);
    }

    const text = (parsed.choices?.[0]?.message?.content ?? '').trim();
    if (!text) {
      throw new AiProviderError(this.name, res.status, 'OpenAI returned no message content.');
    }

    const json = coerceJson(text);
    return {
      text,
      ...(json !== undefined ? { json } : {}),
      inputTokens: parsed.usage?.prompt_tokens ?? 0,
      outputTokens: parsed.usage?.completion_tokens ?? 0,
      model: parsed.model ?? this.model,
    };
  }
}
