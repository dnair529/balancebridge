/**
 * Task: the plain-English monthly close narrative.
 *
 * This is the thing owners forward to other owners — the growth loop
 * (CLIENT-PLATFORM-STRATEGY.md §2 feature #6, §4). It is also the highest-risk
 * output in the product, because it goes to a client over the firm's name.
 *
 * Two rules, enforced here rather than trusted to a prompt:
 *  - **`needsHuman` is always true.** `alwaysNeedsHuman: true` on the run. A
 *    bookkeeper approves every narrative before it sends, whatever the
 *    confidence — no exceptions, no threshold override.
 *  - **No advice leaves the building.** The draft is scanned on the way out;
 *    a narrative that strayed into tax or legal recommendations is suppressed
 *    and returned at zero confidence with the reason attached.
 *
 * Persisting to `close_periods.narrative` requires `.confirm(userId)`, and the
 * route that does it is what writes `narrative_approved_by`.
 */

import { Suggestion } from '../../lib/ai-guard.js';
import { clampConfidence } from '../format.js';
import { buildRequest } from '../request.js';
import { requireJson, runTask } from '../index.js';
import { containsAdviceOutput } from '../safety.js';
import type { RunLogger } from '../runlog.js';
import type { AiProvider } from '../provider.js';
import type {
  CategoryMovement,
  NarrativeDriver,
  NarrativeFigures,
  NarrativeModel,
  NarrativePayload,
  PeriodRef,
} from '../payloads.js';

export interface DraftNarrativeInput {
  readonly clientId: string;
  readonly userId?: string | null;
  readonly businessName: string;
  readonly period: PeriodRef;
  /** Every figure the narrative may mention. Nothing else is permitted. */
  readonly figures: NarrativeFigures;
  readonly topCategories?: readonly CategoryMovement[];
  /** Named causes for the big movements — "two large POs", with the amount. */
  readonly drivers?: readonly NarrativeDriver[];
  readonly watchItems?: readonly string[];
  /** `close_periods.id`, recorded on the ai_runs row. */
  readonly closePeriodId?: string | null;
  readonly provider?: AiProvider;
  readonly logger?: RunLogger;
}

export interface NarrativeDraft {
  /** The draft itself. NOT approved, NOT sent. */
  readonly narrative: string;
  readonly highlights: readonly string[];
  readonly watchItems: readonly string[];
  readonly confidence: number;
  readonly reasoning: string;
  /** Always true. A human approves every narrative before a client sees it. */
  readonly needsHuman: true;
  /** Always true — kept in the value so a persisted draft carries the flag. */
  readonly requiresApproval: true;
  /** Set when the draft was suppressed for straying over the advice line. */
  readonly suppressed: boolean;
  readonly suppressionReason: string | null;
}

const SCHEMA = {
  type: 'object',
  required: ['narrative', 'highlights', 'watchItems', 'confidence', 'reasoning'],
  properties: {
    narrative: { type: 'string' },
    highlights: { type: 'array', items: { type: 'string' } },
    watchItems: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    reasoning: { type: 'string' },
  },
};

export async function draftNarrative(input: DraftNarrativeInput): Promise<Suggestion<NarrativeDraft>> {
  const payload: NarrativePayload = {
    clientId: input.clientId,
    businessName: input.businessName,
    period: input.period,
    figures: input.figures,
    topCategories: input.topCategories ?? [],
    drivers: input.drivers ?? [],
    watchItems: input.watchItems ?? [],
  };

  const request = buildRequest({
    task: 'narrative',
    clientId: input.clientId,
    payload,
    jsonSchema: SCHEMA,
    includeVoice: true,
    instructions:
      `Draft the ${input.period.label} close summary for ${input.businessName}. Six to ten sentences in the firm ` +
      'voice. Every number you state must appear in the payload below — do not compute or estimate anything else. ' +
      'End with the things worth watching, phrased as observations. This is a draft for a bookkeeper to approve.',
  });

  return runTask<NarrativeDraft>({
    task: 'narrative',
    clientId: input.clientId,
    userId: input.userId ?? null,
    request,
    relatedEntity: input.closePeriodId ? 'close_periods' : null,
    relatedId: input.closePeriodId ?? null,
    provider: input.provider,
    logger: input.logger,
    // Client-facing prose is never auto-approved, at any confidence.
    alwaysNeedsHuman: true,
    parse: (res) => {
      const raw = requireJson<Partial<NarrativeModel>>(res, res.model, 'close narrative');
      const narrative = typeof raw.narrative === 'string' ? raw.narrative.trim() : '';
      if (!narrative) {
        return {
          value: suppressed('', 'Provider returned an empty narrative.'),
          confidence: 0,
          reasoning: 'Provider returned an empty narrative.',
        };
      }

      // Outbound advice tripwire — belt and braces over the prompt clause.
      const advice = containsAdviceOutput(narrative);
      if (advice.triggered) {
        const reason = `${advice.reason} Matched "${advice.matched}".`;
        return { value: suppressed(narrative, reason), confidence: 0, reasoning: reason };
      }

      const confidence = clampConfidence(Number(raw.confidence ?? 0));
      const reasoning =
        typeof raw.reasoning === 'string' && raw.reasoning.trim()
          ? raw.reasoning.trim()
          : 'No reasoning supplied by the provider.';

      const value: NarrativeDraft = {
        narrative,
        highlights: strings(raw.highlights),
        watchItems: strings(raw.watchItems).length ? strings(raw.watchItems) : [...(input.watchItems ?? [])],
        confidence,
        reasoning,
        needsHuman: true,
        requiresApproval: true,
        suppressed: false,
        suppressionReason: null,
      };
      return { value, confidence, reasoning };
    },
  });
}

function suppressed(narrative: string, reason: string): NarrativeDraft {
  return {
    // The offending text is withheld; only the reason travels.
    narrative: '',
    highlights: [],
    watchItems: [],
    confidence: 0,
    reasoning: `Draft suppressed before review. ${reason}${narrative ? ` (${narrative.length} characters withheld.)` : ''}`,
    needsHuman: true,
    requiresApproval: true,
    suppressed: true,
    suppressionReason: reason,
  };
}

function strings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()).slice(0, 10);
}
