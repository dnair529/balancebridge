/**
 * The provider seam.
 *
 * Text in, text out, with usage. Nothing above this line knows whether an
 * answer came from Anthropic, OpenAI, or the deterministic local stub — which
 * is the point: the firm's advantage is the rules engine and the data, not a
 * model vendor (STAFF-WORKSPACE.md §10.3, §11).
 *
 * Providers are dumb pipes. They do not know about clients, ledgers, or the
 * database. All safety (client scoping, confidence gating, ai_runs logging,
 * ledger isolation) lives above them in `src/ai/index.ts` and
 * `src/lib/ai-guard.ts`.
 */

/** Tasks, matching the `ai_runs.task` enum in src/db/schema.ts. */
export const AI_TASKS = [
  'extract',
  'categorize',
  'narrative',
  'reply_draft',
  'anomaly',
  'precedent_search',
  'reconcile',
  'preflight',
] as const;

export type AiTask = (typeof AI_TASKS)[number];

export interface AiMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/**
 * A JSON Schema fragment describing the response shape. Providers use it where
 * the API supports structured output; where it does not, it is appended to the
 * prompt. Kept as a loose record so no schema library becomes a dependency of
 * the provider seam.
 */
export type JsonSchema = Record<string, unknown>;

export interface AiRequest {
  /** System prompt. Always includes the no-tax-advice clause (see prompts.ts). */
  readonly system: string;
  readonly messages: readonly AiMessage[];
  readonly maxTokens: number;
  readonly temperature: number;
  readonly jsonSchema?: JsonSchema;

  /**
   * Routing/telemetry metadata. Not sent to the model as content; the stub
   * dispatches on it, and `ai_runs` records it.
   */
  readonly task: AiTask;
  /** Null only for firm-wide work with no client data in the payload. */
  readonly clientId: string | null;
  readonly timeoutMs?: number;
}

export interface AiResponse {
  readonly text: string;
  /** Parsed JSON when the response was (or could be coerced to) JSON. */
  readonly json?: unknown;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string;
}

export interface AiProvider {
  readonly name: string;
  complete(req: AiRequest): Promise<AiResponse>;
}

/* ------------------------------------------------------------------------- */
/* Typed errors                                                              */
/* ------------------------------------------------------------------------- */

export class AiError extends Error {
  override readonly name: string = 'AiError';
  constructor(
    message: string,
    readonly provider: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/**
 * Thrown when a provider is selected but has no credentials. Distinct from a
 * transport failure so callers can fall back to the stub or surface a config
 * problem instead of retrying.
 */
export class AiNotConfiguredError extends AiError {
  override readonly name = 'AiNotConfiguredError';
  constructor(provider: string, readonly missingEnv: string) {
    super(
      `AI provider "${provider}" is selected but ${missingEnv} is not set. ` +
        `Set ${missingEnv}, or set AI_PROVIDER=stub to use the deterministic local provider.`,
      provider,
    );
  }
}

/** Non-2xx from the provider, or a malformed body. */
export class AiProviderError extends AiError {
  override readonly name = 'AiProviderError';
  constructor(
    provider: string,
    readonly status: number | null,
    message: string,
    cause?: unknown,
  ) {
    super(message, provider, cause);
  }
}

export class AiTimeoutError extends AiError {
  override readonly name = 'AiTimeoutError';
  constructor(provider: string, readonly timeoutMs: number) {
    super(`AI provider "${provider}" timed out after ${timeoutMs}ms.`, provider);
  }
}

/** The model returned something the task could not parse into its output type. */
export class AiOutputError extends AiError {
  override readonly name = 'AiOutputError';
  constructor(provider: string, message: string, readonly raw?: string) {
    super(message, provider);
  }
}

/* ------------------------------------------------------------------------- */
/* Shared helpers for provider implementations                                */
/* ------------------------------------------------------------------------- */

/**
 * Pull a JSON object out of a model response that may be wrapped in prose or
 * a fenced code block. Returns undefined rather than throwing — the caller
 * decides whether missing JSON is fatal.
 */
export function coerceJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = [fenced?.[1], trimmed].filter((c): c is string => typeof c === 'string');

  for (const candidate of candidates) {
    const c = candidate.trim();
    try {
      return JSON.parse(c) as unknown;
    } catch {
      // Fall through to a brace/bracket slice for prose-wrapped JSON.
    }
    const start = c.search(/[[{]/);
    if (start === -1) continue;
    const openChar = c[start];
    const closeChar = openChar === '{' ? '}' : ']';
    const end = c.lastIndexOf(closeChar);
    if (end > start) {
      try {
        return JSON.parse(c.slice(start, end + 1)) as unknown;
      } catch {
        // Give up on this candidate.
      }
    }
  }
  return undefined;
}

/** fetch with an AbortController timeout, normalised to AiTimeoutError. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  provider: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AiTimeoutError(provider, timeoutMs);
    }
    throw new AiProviderError(provider, null, `Network failure calling ${provider}: ${String(err)}`, err);
  } finally {
    clearTimeout(timer);
  }
}
