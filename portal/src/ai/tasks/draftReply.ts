/**
 * Task: drafted reply to a client message, in firm voice.
 *
 * Cuts the communication tax without outsourcing the relationship
 * (STAFF-WORKSPACE.md §4, CLIENT-PLATFORM-STRATEGY.md §2 internal). The
 * bookkeeper edits and sends. **Never auto-send** — `needsHuman` is always
 * true, at any confidence.
 *
 * The tax/legal advice line is checked twice:
 *   - **Inbound**, before any provider is called. If the client asked a tax,
 *     legal, or investment question we do not send it to a model at all; we
 *     return the firm's deflection, grounded in the fact that Balance Bridge is
 *     not a CPA firm.
 *   - **Outbound**, on whatever came back, in case a provider answered anyway.
 */

import { Suggestion } from '../../lib/ai-guard.js';
import { clampConfidence } from '../format.js';
import { buildRequest } from '../request.js';
import { recordDeterministic, requireJson, runTask } from '../index.js';
import { taxAdviceDeflection } from '../prompts.js';
import { checkForAdviceRequest, containsAdviceOutput } from '../safety.js';
import type { RunLogger } from '../runlog.js';
import type { AiProvider } from '../provider.js';
import type { ReplyContextItem, ReplyModel, ReplyPayload } from '../payloads.js';

export interface DraftReplyInput {
  readonly clientId: string;
  readonly userId?: string | null;
  readonly clientName?: string | null;
  /** The message we are replying to. */
  readonly clientMessage: string;
  /** Grounding facts. The draft may state nothing that is not in here. */
  readonly context?: readonly ReplyContextItem[];
  readonly threadSummary?: string | null;
  readonly openQuestions?: readonly string[];
  /** `threads.id` / `messages.id`, recorded on the ai_runs row. */
  readonly threadId?: string | null;
  readonly provider?: AiProvider;
  readonly logger?: RunLogger;
}

export interface ReplyDraft {
  readonly reply: string;
  readonly confidence: number;
  readonly reasoning: string;
  /** Always true. Nothing drafted here is ever sent automatically. */
  readonly needsHuman: true;
  /** True when we declined on the tax/legal line and offered the CPA route. */
  readonly deflected: boolean;
  readonly deflectionReason: string | null;
  /** Which supplied facts the draft leaned on — for the bookkeeper to check. */
  readonly grounding: readonly string[];
}

const SCHEMA = {
  type: 'object',
  required: ['reply', 'confidence', 'reasoning', 'deflected'],
  properties: {
    reply: { type: 'string' },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    reasoning: { type: 'string' },
    deflected: { type: 'boolean' },
    deflectionReason: { type: ['string', 'null'] },
    grounding: { type: 'array', items: { type: 'string' } },
  },
};

export async function draftReply(input: DraftReplyInput): Promise<Suggestion<ReplyDraft>> {
  const started = Date.now();

  // ---- Inbound advice tripwire: refuse before the model, not after. ----
  const advice = checkForAdviceRequest(input.clientMessage);
  if (advice.triggered) {
    const value: ReplyDraft = {
      reply: taxAdviceDeflection(input.clientName ?? null),
      confidence: 95,
      reasoning:
        `The client asked a ${advice.category} question, which Balance Bridge does not answer — it is not a CPA ` +
        `firm. ${advice.reason} Matched "${advice.matched}". No model was called; this is the firm's standard ` +
        'redirect, offering to send their CPA whatever they need from our side.',
      needsHuman: true,
      deflected: true,
      deflectionReason: advice.reason,
      grounding: [],
    };
    return recordDeterministic({
      task: 'reply_draft',
      clientId: input.clientId,
      userId: input.userId ?? null,
      value,
      confidence: 95,
      reasoning: value.reasoning,
      source: 'rule',
      relatedEntity: input.threadId ? 'threads' : null,
      relatedId: input.threadId ?? null,
      logger: input.logger,
      alwaysNeedsHuman: true,
      startedAt: started,
    });
  }

  const payload: ReplyPayload = {
    clientId: input.clientId,
    clientName: input.clientName ?? null,
    clientMessage: input.clientMessage,
    threadSummary: input.threadSummary ?? null,
    context: input.context ?? [],
    openQuestions: input.openQuestions ?? [],
  };

  const request = buildRequest({
    task: 'reply_draft',
    clientId: input.clientId,
    payload,
    jsonSchema: SCHEMA,
    includeVoice: true,
    instructions:
      'Draft the bookkeeper\'s reply to the client message below. Answer the question in the first two sentences, ' +
      'using only the supplied context. If the context does not answer it, say what we will do and by when rather ' +
      'than inventing an answer. A bookkeeper edits and sends this — it is never sent as-is.',
  });

  return runTask<ReplyDraft>({
    task: 'reply_draft',
    clientId: input.clientId,
    userId: input.userId ?? null,
    request,
    relatedEntity: input.threadId ? 'threads' : null,
    relatedId: input.threadId ?? null,
    provider: input.provider,
    logger: input.logger,
    alwaysNeedsHuman: true, // never auto-send
    parse: (res) => {
      const raw = requireJson<Partial<ReplyModel>>(res, res.model, 'reply draft');
      const reply = typeof raw.reply === 'string' ? raw.reply.trim() : '';
      if (!reply) {
        const reason = 'Provider returned an empty reply.';
        return { value: blocked(reason), confidence: 0, reasoning: reason };
      }

      // ---- Outbound advice tripwire. ----
      const out = containsAdviceOutput(reply);
      if (out.triggered) {
        const reason = `${out.reason} Matched "${out.matched}".`;
        return {
          value: {
            reply: taxAdviceDeflection(input.clientName ?? null),
            confidence: 0,
            reasoning: `Draft replaced with the standard CPA redirect. ${reason}`,
            needsHuman: true,
            deflected: true,
            deflectionReason: reason,
            grounding: [],
          },
          confidence: 0,
          reasoning: `Draft replaced with the standard CPA redirect. ${reason}`,
        };
      }

      const confidence = clampConfidence(Number(raw.confidence ?? 0));
      const reasoning =
        typeof raw.reasoning === 'string' && raw.reasoning.trim()
          ? raw.reasoning.trim()
          : 'No reasoning supplied by the provider.';

      const value: ReplyDraft = {
        reply,
        confidence,
        reasoning,
        needsHuman: true,
        deflected: raw.deflected === true,
        deflectionReason: typeof raw.deflectionReason === 'string' ? raw.deflectionReason : null,
        grounding: Array.isArray(raw.grounding)
          ? raw.grounding.filter((g): g is string => typeof g === 'string').slice(0, 20)
          : [],
      };
      return { value, confidence, reasoning };
    },
  });
}

function blocked(reason: string): ReplyDraft {
  return {
    reply: '',
    confidence: 0,
    reasoning: reason,
    needsHuman: true,
    deflected: false,
    deflectionReason: null,
    grounding: [],
  };
}
