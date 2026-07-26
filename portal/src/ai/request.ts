/**
 * The request builder — the single place a prompt is assembled.
 *
 * Two jobs:
 *   1. Enforce client scoping. Guardrail: no cross-client data in prompts, ever
 *      (STAFF-WORKSPACE.md §10.6). Every payload is walked before it can be
 *      serialised; anything carrying another client's id throws.
 *   2. Put the task's evidence into a machine-readable envelope so both a real
 *      model and the deterministic stub read the same thing.
 *
 * The envelope looks like:
 *
 * ```
 * <instructions...>
 *
 * <payload>
 * { ...json... }
 * </payload>
 * ```
 *
 * Real providers see a well-structured prompt. The stub parses the payload and
 * runs local heuristics against it. Nothing about the task changes when the
 * provider changes.
 */

import { assertClientScoped, assertNoLedgerWrite } from '../lib/ai-guard.js';
import { systemPrompt } from './prompts.js';
import type { AiRequest, AiTask, JsonSchema } from './provider.js';
import { config } from '../config.js';

const PAYLOAD_OPEN = '<payload>';
const PAYLOAD_CLOSE = '</payload>';

export interface BuildRequestInput<P> {
  readonly task: AiTask;
  /** The client this work belongs to. Null only for firm-wide work. */
  readonly clientId: string | null;
  /** Structured evidence. Walked for cross-client leakage before use. */
  readonly payload: P;
  /** Task-specific instruction line(s) shown above the payload. */
  readonly instructions: string;
  readonly jsonSchema?: JsonSchema;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly includeVoice?: boolean;
  readonly systemExtra?: string;
  readonly timeoutMs?: number;
}

/**
 * Build a provider-agnostic request. Throws {@link CrossClientDataError} if the
 * payload mixes clients, and {@link LedgerWriteViolationError} if a database
 * handle was smuggled in as evidence.
 */
export function buildRequest<P>(input: BuildRequestInput<P>): AiRequest {
  // Guardrail 1 (runtime arm): a db handle must never reach the AI layer.
  assertNoLedgerWrite(input.payload, `buildRequest(${input.task}) payload`);
  // Guardrail 5: client scoping, asserted here so no task can forget it.
  assertClientScoped(input.payload, input.clientId, `${input.task}.payload`);

  const body = [
    input.instructions.trim(),
    '',
    PAYLOAD_OPEN,
    JSON.stringify(input.payload, jsonReplacer, 2),
    PAYLOAD_CLOSE,
  ].join('\n');

  return {
    system: systemPrompt(input.task, {
      includeVoice: input.includeVoice,
      extra: input.systemExtra,
    }),
    messages: [{ role: 'user', content: body }],
    maxTokens: input.maxTokens ?? config.AI_MAX_TOKENS,
    temperature: input.temperature ?? config.AI_TEMPERATURE,
    ...(input.jsonSchema ? { jsonSchema: input.jsonSchema } : {}),
    task: input.task,
    clientId: input.clientId,
    timeoutMs: input.timeoutMs ?? config.AI_TIMEOUT_MS,
  };
}

/** Dates serialise as YYYY-MM-DD; undefined never reaches a prompt as "null". */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}

/**
 * Recover the structured payload from a built request. Used by the stub
 * provider (which is a local heuristic engine, not a language model) and by
 * tests. Returns undefined if the request was not built by {@link buildRequest}.
 */
export function extractPayload<P = unknown>(req: AiRequest): P | undefined {
  for (const msg of req.messages) {
    const start = msg.content.indexOf(PAYLOAD_OPEN);
    const end = msg.content.lastIndexOf(PAYLOAD_CLOSE);
    if (start === -1 || end <= start) continue;
    const raw = msg.content.slice(start + PAYLOAD_OPEN.length, end).trim();
    try {
      return JSON.parse(raw) as P;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Rough token estimate for providers that do not report usage. ~4 chars/token. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
