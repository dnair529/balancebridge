/**
 * Task: document extraction.
 *
 * OCR/text in → vendor, date, amount, tax, line items out. One of the few
 * places AI is unambiguously "real, do it": high accuracy, bounded, and
 * verifiable against the document itself
 * (CLIENT-PLATFORM-STRATEGY.md §3, feature #2/#3).
 *
 * Returns a `Suggestion<ExtractedDocument>`. A route may persist it to
 * `extractions` **only** after `.confirm(userId)`.
 */

import { Suggestion } from '../../lib/ai-guard.js';
import { clampConfidence } from '../format.js';
import { buildRequest } from '../request.js';
import { requireJson, runTask } from '../index.js';
import type { RunLogger } from '../runlog.js';
import type { AiProvider } from '../provider.js';
import type { DocType, ExtractModel, ExtractPayload } from '../payloads.js';

export interface ExtractDocumentInput {
  readonly clientId: string;
  readonly userId?: string | null;
  /** OCR or plain text. Never a path — the AI layer does not read files. */
  readonly text: string;
  readonly filename?: string | null;
  readonly mime?: string | null;
  /** `intake_items.id`, recorded on the ai_runs row. */
  readonly intakeItemId?: string | null;
  readonly provider?: AiProvider;
  readonly threshold?: number;
  readonly logger?: RunLogger;
}

export interface ExtractedLineItem {
  readonly description: string;
  readonly quantity: number | null;
  readonly amountCents: number | null;
}

export interface ExtractedDocument {
  readonly docType: DocType;
  readonly vendor: string | null;
  /** YYYY-MM-DD, or null when the document has no unambiguous date. */
  readonly date: string | null;
  readonly totalCents: number | null;
  readonly taxCents: number | null;
  readonly lineItems: readonly ExtractedLineItem[];
  readonly confidence: number;
  readonly reasoning: string;
  readonly needsHuman: boolean;
}

const DOC_TYPES: readonly DocType[] = [
  'receipt', 'invoice', 'bill', 'statement', 'w9', 'contract', 'other', 'unknown',
];

const SCHEMA = {
  type: 'object',
  required: ['docType', 'vendor', 'date', 'totalCents', 'taxCents', 'lineItems', 'confidence', 'reasoning'],
  properties: {
    docType: { type: 'string', enum: DOC_TYPES },
    vendor: { type: ['string', 'null'] },
    date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    totalCents: { type: ['integer', 'null'], description: 'integer minor units' },
    taxCents: { type: ['integer', 'null'] },
    lineItems: {
      type: 'array',
      items: {
        type: 'object',
        required: ['description', 'amountCents'],
        properties: {
          description: { type: 'string' },
          quantity: { type: ['integer', 'null'] },
          amountCents: { type: ['integer', 'null'] },
        },
      },
    },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    reasoning: { type: 'string' },
  },
};

export async function extractDocument(input: ExtractDocumentInput): Promise<Suggestion<ExtractedDocument>> {
  const payload: ExtractPayload = {
    clientId: input.clientId,
    filename: input.filename ?? null,
    mime: input.mime ?? null,
    text: truncate(input.text, 20_000),
  };

  const request = buildRequest({
    task: 'extract',
    clientId: input.clientId,
    payload,
    jsonSchema: SCHEMA,
    instructions:
      'Extract the fields below from this single document. Use only what is literally printed in the text — ' +
      'never infer a vendor, a total, or a date that is not there. Amounts are integer cents.',
  });

  return runTask<ExtractedDocument>({
    task: 'extract',
    clientId: input.clientId,
    userId: input.userId ?? null,
    request,
    relatedEntity: input.intakeItemId ? 'intake_items' : null,
    relatedId: input.intakeItemId ?? null,
    provider: input.provider,
    threshold: input.threshold,
    logger: input.logger,
    parse: (res) => {
      const raw = requireJson<Partial<ExtractModel>>(res, res.model, 'document extraction');
      const confidence = clampConfidence(Number(raw.confidence ?? 0));
      const value: ExtractedDocument = {
        docType: DOC_TYPES.includes(raw.docType as DocType) ? (raw.docType as DocType) : 'unknown',
        vendor: str(raw.vendor),
        date: isoDate(raw.date),
        totalCents: cents(raw.totalCents),
        taxCents: cents(raw.taxCents),
        lineItems: (raw.lineItems ?? []).slice(0, 100).map((li) => ({
          description: str(li?.description) ?? '',
          quantity: Number.isFinite(Number(li?.quantity)) && li?.quantity !== null ? Math.trunc(Number(li?.quantity)) : null,
          amountCents: cents(li?.amountCents),
        })),
        confidence,
        reasoning: str(raw.reasoning) ?? 'No reasoning supplied by the provider.',
        // Filled in below once runTask has applied the threshold.
        needsHuman: false,
      };
      return { value, confidence, reasoning: value.reasoning };
    },
  }).then((s) =>
    // Mirror the gate onto the value so a persisted extraction carries it too.
    s.needsHuman ? s.map((v) => ({ ...v, needsHuman: true })) : s,
  );
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

function cents(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // Money is integer minor units. A fractional cent is a provider error.
  return Math.round(n);
}

function isoDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}
