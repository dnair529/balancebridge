/**
 * The AI audit trail.
 *
 * **This is the only module under `src/ai/` that imports the database, and the
 * only table it writes is `ai_runs`.** Every write is gated through
 * {@link assertWritableByAi}, so extending this file to touch the ledger throws
 * at runtime rather than quietly working.
 *
 * Required by STAFF-WORKSPACE.md §10.4 (full audit trail distinguishing
 * AI-suggested from human-confirmed) and CLIENT-PLATFORM-STRATEGY.md §3.5
 * (every AI action lands in the audit log).
 *
 * A logging failure never fails the task — the same convention as
 * `src/lib/audit.ts`. Losing a telemetry row is not worth losing a
 * bookkeeper's work; the failure is surfaced to the caller-supplied logger.
 */

import { db } from '../db/index.js';
import { aiRuns } from '../db/schema.js';
import { assertWritableByAi } from '../lib/ai-guard.js';
import type { AiTask } from './provider.js';

export interface AiRunRecord {
  readonly clientId: string | null;
  readonly userId: string | null;
  readonly task: AiTask;
  readonly provider: string;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number;
  readonly confidence: number | null;
  readonly relatedEntity: string | null;
  readonly relatedId: string | null;
  readonly error: string | null;
}

/** Somewhere to send a logging failure without importing fastify here. */
export type RunLogger = { error: (obj: unknown, msg?: string) => void } | null;

/**
 * Insert one `ai_runs` row. Returns the row id, or null if the write failed
 * (never throws).
 */
export async function logAiRun(record: AiRunRecord, logger: RunLogger = null): Promise<string | null> {
  // Guardrail 1, enforced on the one write path the AI layer has.
  assertWritableByAi('ai_runs', 'logAiRun');

  try {
    const [row] = await db
      .insert(aiRuns)
      .values({
        clientId: record.clientId,
        userId: record.userId,
        task: record.task,
        provider: record.provider,
        model: record.model,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        latencyMs: record.latencyMs,
        confidence: record.confidence,
        // Null = not yet reviewed. Only the route that persists a confirmed
        // suggestion may set this to true — never this module.
        accepted: null,
        relatedEntity: record.relatedEntity,
        relatedId: record.relatedId,
        error: record.error,
      })
      .returning({ id: aiRuns.id });
    return row?.id ?? null;
  } catch (err) {
    logger?.error({ err, task: record.task, provider: record.provider }, 'ai_runs write failed');
    return null;
  }
}
