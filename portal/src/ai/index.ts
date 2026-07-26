/**
 * The AI layer's front door.
 *
 * ```ts
 * import { suggestCategory } from './ai/tasks/suggestCategory.js';
 *
 * const s = await suggestCategory({ clientId, transaction, categories, rules, priorDecisions });
 * // s: Suggestion<CategorySuggestion> — display it, or:
 * await applyCategory(s.confirm(staffUser.id));   // only a human gets to commit
 * ```
 *
 * ## What this module guarantees, whichever provider is selected
 *
 * | Guardrail | Where |
 * |---|---|
 * | AI never writes to the ledger | tasks return `Suggestion<T>`; only `runlog.ts` touches the db, only `ai_runs` |
 * | Confidence + reasoning on every suggestion | enforced in the `Suggestion` constructor |
 * | Below threshold → `needsHuman`, not a guess | {@link runTask} gates on `AI_CONFIDENCE_THRESHOLD` |
 * | Every invocation logs an `ai_runs` row | {@link runTask}, including on error |
 * | No cross-client data in prompts | `buildRequest()` asserts scoping before serialising |
 * | No tax or legal advice | `prompts.ts` clause + `safety.ts` tripwire, in and out |
 *
 * @see ../lib/ai-guard.ts for the structural rules this layer is built around.
 */

import { config } from '../config.js';
import { Suggestion, type SuggestionMeta, type SuggestionSource } from '../lib/ai-guard.js';
import { logAiRun, type RunLogger } from './runlog.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAiProvider } from './providers/openai.js';
import { StubProvider } from './providers/stub.js';
import { AiError, AiOutputError, type AiProvider, type AiRequest, type AiResponse, type AiTask } from './provider.js';

export * from './provider.js';
export * from './payloads.js';
export { buildRequest, extractPayload } from './request.js';
export { systemPrompt, taxAdviceDeflection, FIRM_VOICE, SAFETY_CLAUSE } from './prompts.js';
export { checkForAdviceRequest, containsAdviceOutput } from './safety.js';
export { StubProvider, STUB_PROVIDER_NAME } from './providers/stub.js';
export { AnthropicProvider } from './providers/anthropic.js';
export { OpenAiProvider } from './providers/openai.js';
export {
  Suggestion,
  type ConfirmedSuggestion,
  type SuggestionMeta,
  type SuggestionSource,
} from '../lib/ai-guard.js';

let cached: AiProvider | null = null;

/**
 * Select the provider from `AI_PROVIDER` (stub | anthropic | openai).
 * Defaults to the deterministic stub, which needs no key and always works —
 * so the portal has no hard dependency on any model vendor.
 */
export function getProvider(override?: 'stub' | 'anthropic' | 'openai'): AiProvider {
  const which = override ?? config.AI_PROVIDER;
  if (!override && cached) return cached;

  const provider: AiProvider =
    which === 'anthropic'
      ? new AnthropicProvider()
      : which === 'openai'
        ? new OpenAiProvider()
        : new StubProvider();

  if (!override) cached = provider;
  return provider;
}

/** Test seam. Also used when a task deliberately runs against the stub. */
export function setProvider(provider: AiProvider | null): void {
  cached = provider;
}

/** The confidence floor below which a suggestion routes to a human. */
export function confidenceThreshold(override?: number): number {
  return override ?? config.AI_CONFIDENCE_THRESHOLD;
}

export interface RunTaskInput<T> {
  readonly task: AiTask;
  readonly clientId: string | null;
  readonly userId?: string | null;
  readonly request: AiRequest;
  /**
   * Turn a raw provider response into the task's output type. Throw
   * {@link AiOutputError} if the response cannot be trusted — that is logged
   * as a failed run rather than passed on as a suggestion.
   */
  readonly parse: (res: AiResponse) => { value: T; confidence: number; reasoning: string };
  readonly relatedEntity?: string | null;
  readonly relatedId?: string | null;
  readonly provider?: AiProvider;
  readonly source?: SuggestionSource;
  /** Per-call threshold override; defaults to `AI_CONFIDENCE_THRESHOLD`. */
  readonly threshold?: number;
  readonly logger?: RunLogger;
  /** Force `needsHuman` regardless of confidence (e.g. anything client-facing). */
  readonly alwaysNeedsHuman?: boolean;
}

/**
 * Run one task end to end: call the provider, time it, parse it, gate it on
 * confidence, log an `ai_runs` row, and wrap the result in a `Suggestion<T>`.
 *
 * Errors are logged to `ai_runs` (with `error` set) and then rethrown — the
 * caller decides whether a failure means "show nothing" or "fall back to the
 * deterministic path". Nothing is silently swallowed.
 */
export async function runTask<T>(input: RunTaskInput<T>): Promise<Suggestion<T>> {
  const provider = input.provider ?? getProvider();
  const started = Date.now();

  let res: AiResponse | null = null;
  try {
    res = await provider.complete(input.request);
    const parsed = input.parse(res);
    const latencyMs = Date.now() - started;

    const threshold = confidenceThreshold(input.threshold);
    const needsHuman = input.alwaysNeedsHuman === true || parsed.confidence < threshold;

    const runId = await logAiRun(
      {
        clientId: input.clientId,
        userId: input.userId ?? null,
        task: input.task,
        provider: provider.name,
        model: res.model,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        latencyMs,
        confidence: parsed.confidence,
        relatedEntity: input.relatedEntity ?? null,
        relatedId: input.relatedId ?? null,
        error: null,
      },
      input.logger ?? null,
    );

    const meta: SuggestionMeta = {
      confidence: parsed.confidence,
      reasoning: needsHuman
        ? `${parsed.reasoning} Confidence ${parsed.confidence} is below the ${threshold} threshold, so this needs a human rather than being applied.`
        : parsed.reasoning,
      needsHuman,
      source: input.source ?? 'model',
      task: input.task,
      provider: provider.name,
      model: res.model,
      clientId: input.clientId,
      runId,
      latencyMs,
    };

    return new Suggestion(parsed.value, meta);
  } catch (err) {
    const latencyMs = Date.now() - started;
    await logAiRun(
      {
        clientId: input.clientId,
        userId: input.userId ?? null,
        task: input.task,
        provider: provider.name,
        model: res?.model ?? null,
        inputTokens: res?.inputTokens ?? null,
        outputTokens: res?.outputTokens ?? null,
        latencyMs,
        confidence: null,
        relatedEntity: input.relatedEntity ?? null,
        relatedId: input.relatedId ?? null,
        error: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 1000) : String(err).slice(0, 1000),
      },
      input.logger ?? null,
    );
    throw err;
  }
}

/**
 * Record a deterministic (non-model) decision as a suggestion, still logged to
 * `ai_runs` so the rules engine's contribution is measurable against the
 * model's. A rule hit is `source: 'rule'` and confidence 100 — deterministic
 * beats probabilistic, every time (STAFF-WORKSPACE.md §10.3).
 */
export async function recordDeterministic<T>(input: {
  readonly task: AiTask;
  readonly clientId: string | null;
  readonly userId?: string | null;
  readonly value: T;
  readonly confidence: number;
  readonly reasoning: string;
  readonly source?: SuggestionSource;
  readonly relatedEntity?: string | null;
  readonly relatedId?: string | null;
  readonly threshold?: number;
  readonly logger?: RunLogger;
  readonly alwaysNeedsHuman?: boolean;
  readonly startedAt?: number;
}): Promise<Suggestion<T>> {
  const latencyMs = input.startedAt ? Date.now() - input.startedAt : 0;
  const threshold = confidenceThreshold(input.threshold);
  const needsHuman = input.alwaysNeedsHuman === true || input.confidence < threshold;

  const runId = await logAiRun(
    {
      clientId: input.clientId,
      userId: input.userId ?? null,
      task: input.task,
      provider: input.source === 'rule' ? 'rules-engine' : 'deterministic',
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs,
      confidence: input.confidence,
      relatedEntity: input.relatedEntity ?? null,
      relatedId: input.relatedId ?? null,
      error: null,
    },
    input.logger ?? null,
  );

  return new Suggestion(input.value, {
    confidence: input.confidence,
    reasoning: input.reasoning,
    needsHuman,
    source: input.source ?? 'rule',
    task: input.task,
    provider: input.source === 'rule' ? 'rules-engine' : 'deterministic',
    model: null,
    clientId: input.clientId,
    runId,
    latencyMs,
  });
}

/** Narrow a provider response to its JSON body, or fail the run. */
export function requireJson<T>(res: AiResponse, provider: string, what: string): T {
  if (res.json === undefined || res.json === null || typeof res.json !== 'object') {
    throw new AiOutputError(provider, `Expected a JSON object for ${what} but got none.`, res.text.slice(0, 400));
  }
  return res.json as T;
}

export { AiError };
