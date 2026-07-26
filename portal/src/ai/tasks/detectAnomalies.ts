/**
 * Task: anomaly detection.
 *
 * The trust engine. The first time the firm catches a duplicate $8,000 payment
 * before the owner notices, it stops being a vendor and starts being
 * infrastructure (CLIENT-PLATFORM-STRATEGY.md §2 feature #9). Anomalies are
 * surfaced to *staff* first — the firm reports the problem rather than being
 * asked about it (STAFF-WORKSPACE.md §5).
 *
 * Hard validation on the way out: every `transactionIds` entry must exist in
 * the transactions that were passed in. A fabricated id is dropped, and an
 * anomaly left with no real ids is discarded entirely. A false alarm costs the
 * firm credibility, and a hallucinated transaction id costs it more.
 */

import { Suggestion } from '../../lib/ai-guard.js';
import { clampConfidence } from '../format.js';
import { buildRequest } from '../request.js';
import { requireJson, runTask } from '../index.js';
import type { RunLogger } from '../runlog.js';
import type { AiProvider } from '../provider.js';
import type {
  AnomalyKind,
  AnomalyModel,
  AnomalyPayload,
  AnomalyResultModel,
  PeriodRef,
  Severity,
  TransactionRef,
} from '../payloads.js';

export interface DetectAnomaliesInput {
  readonly clientId: string;
  readonly userId?: string | null;
  readonly transactions: readonly TransactionRef[];
  readonly period?: PeriodRef | null;
  readonly provider?: AiProvider;
  readonly threshold?: number;
  readonly logger?: RunLogger;
}

export interface DetectedAnomaly {
  readonly kind: AnomalyKind;
  readonly severity: Severity;
  readonly summary: string;
  readonly detail: string;
  readonly transactionIds: readonly string[];
  readonly confidence: number;
  readonly reasoning: string;
  readonly needsHuman: boolean;
}

const KINDS: readonly AnomalyKind[] = [
  'duplicate_payment', 'price_increase', 'unusual_amount', 'new_vendor',
  'slow_paying_customer', 'missing_deposit', 'other',
];
const SEVERITIES: readonly Severity[] = ['low', 'medium', 'high'];

const SCHEMA = {
  type: 'object',
  required: ['anomalies', 'confidence', 'reasoning'],
  properties: {
    anomalies: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'severity', 'summary', 'detail', 'transactionIds', 'confidence', 'reasoning'],
        properties: {
          kind: { type: 'string', enum: KINDS },
          severity: { type: 'string', enum: SEVERITIES },
          summary: { type: 'string' },
          detail: { type: 'string' },
          transactionIds: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'integer', minimum: 0, maximum: 100 },
          reasoning: { type: 'string' },
        },
      },
    },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    reasoning: { type: 'string' },
  },
};

export async function detectAnomalies(
  input: DetectAnomaliesInput,
): Promise<Suggestion<readonly DetectedAnomaly[]>> {
  const payload: AnomalyPayload = {
    clientId: input.clientId,
    period: input.period ?? null,
    transactions: input.transactions,
  };

  const request = buildRequest({
    task: 'anomaly',
    clientId: input.clientId,
    payload,
    jsonSchema: SCHEMA,
    instructions:
      'Review these transactions for anything a bookkeeper should look at before the client notices it: duplicate ' +
      'payments, subscription price increases, unusual amounts, first-time vendors with real money attached, ' +
      'deposits that stopped. Reference only transaction ids that appear below. Report nothing rather than pad ' +
      'the list.',
  });

  const knownIds = new Set(input.transactions.map((t) => t.id));
  const threshold = input.threshold;

  return runTask<readonly DetectedAnomaly[]>({
    task: 'anomaly',
    clientId: input.clientId,
    userId: input.userId ?? null,
    request,
    relatedEntity: 'clients',
    relatedId: input.clientId,
    provider: input.provider,
    threshold,
    logger: input.logger,
    parse: (res) => {
      const raw = requireJson<Partial<AnomalyResultModel>>(res, res.model, 'anomaly detection');
      const list = Array.isArray(raw.anomalies) ? raw.anomalies : [];

      let droppedIds = 0;
      let droppedAnomalies = 0;

      const value: DetectedAnomaly[] = [];
      for (const a of list as Partial<AnomalyModel>[]) {
        const ids = (Array.isArray(a.transactionIds) ? a.transactionIds : []).filter(
          (id): id is string => typeof id === 'string' && knownIds.has(id),
        );
        droppedIds += (Array.isArray(a.transactionIds) ? a.transactionIds.length : 0) - ids.length;
        // An anomaly that cannot point at a real transaction is not evidence.
        if (ids.length === 0) {
          droppedAnomalies += 1;
          continue;
        }
        const summary = typeof a.summary === 'string' ? a.summary.trim() : '';
        if (!summary) {
          droppedAnomalies += 1;
          continue;
        }
        const confidence = clampConfidence(Number(a.confidence ?? 0));
        value.push({
          kind: KINDS.includes(a.kind as AnomalyKind) ? (a.kind as AnomalyKind) : 'other',
          severity: SEVERITIES.includes(a.severity as Severity) ? (a.severity as Severity) : 'medium',
          summary,
          detail: typeof a.detail === 'string' ? a.detail.trim() : '',
          transactionIds: ids,
          confidence,
          reasoning: typeof a.reasoning === 'string' && a.reasoning.trim() ? a.reasoning.trim() : 'No reasoning supplied.',
          // Each anomaly carries its own gate as well as the batch's.
          needsHuman: true,
        });
      }

      const confidence = clampConfidence(Number(raw.confidence ?? 0));
      const notes: string[] = [];
      if (droppedAnomalies > 0) notes.push(`${droppedAnomalies} item(s) discarded for citing no real transaction`);
      if (droppedIds > 0) notes.push(`${droppedIds} unrecognised transaction id(s) stripped`);

      const reasoning =
        (typeof raw.reasoning === 'string' && raw.reasoning.trim()
          ? raw.reasoning.trim()
          : 'No reasoning supplied by the provider.') + (notes.length ? ` Validation: ${notes.join('; ')}.` : '');

      return { value, confidence, reasoning };
    },
  });
}
