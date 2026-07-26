/**
 * Task: precedent search — firm memory.
 *
 * *"How did we handle retainage for Ramirez Construction last year?"* For a
 * small firm this is disproportionately valuable: it makes institutional
 * knowledge survive turnover and cuts new-hire ramp from months to weeks
 * (STAFF-WORKSPACE.md §7).
 *
 * Client isolation is enforced twice: the caller should only load precedents
 * this client is entitled to, and this task filters again before building the
 * prompt. A precedent belongs to one client (`clientId` set) or to the firm
 * (`clientId` null); anything else is dropped and counted.
 */

import { Suggestion } from '../../lib/ai-guard.js';
import { clampConfidence } from '../format.js';
import { buildRequest } from '../request.js';
import { requireJson, runTask } from '../index.js';
import type { RunLogger } from '../runlog.js';
import type { AiProvider } from '../provider.js';
import type { PrecedentMatchModel, PrecedentPayload, PrecedentRef, PrecedentResultModel } from '../payloads.js';

export interface SearchPrecedentsInput {
  readonly clientId: string;
  readonly userId?: string | null;
  readonly query: string;
  /** Candidates: this client's precedents plus firm-wide ones. */
  readonly precedents: readonly PrecedentRef[];
  readonly industry?: string | null;
  readonly limit?: number;
  readonly provider?: AiProvider;
  readonly threshold?: number;
  readonly logger?: RunLogger;
}

export interface PrecedentMatch {
  readonly precedentId: string;
  readonly title: string;
  /** 0-100 relevance. */
  readonly score: number;
  readonly whyMatched: string;
  readonly snippet: string;
  /** Whose precedent this is: this client's, or the firm playbook. */
  readonly scope: 'client' | 'firm';
}

export interface PrecedentSearchResult {
  readonly matches: readonly PrecedentMatch[];
  readonly confidence: number;
  readonly reasoning: string;
  readonly needsHuman: boolean;
  /** Candidates excluded for belonging to another client. Should be zero. */
  readonly excludedForScope: number;
}

const SCHEMA = {
  type: 'object',
  required: ['matches', 'confidence', 'reasoning'],
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        required: ['precedentId', 'title', 'score', 'whyMatched'],
        properties: {
          precedentId: { type: 'string' },
          title: { type: 'string' },
          score: { type: 'integer', minimum: 0, maximum: 100 },
          whyMatched: { type: 'string' },
          snippet: { type: 'string' },
        },
      },
    },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    reasoning: { type: 'string' },
  },
};

export async function searchPrecedents(
  input: SearchPrecedentsInput,
): Promise<Suggestion<PrecedentSearchResult>> {
  // Scope filter, before anything is serialised into a prompt.
  const eligible = input.precedents.filter((p) => p.clientId === null || p.clientId === input.clientId);
  const excludedForScope = input.precedents.length - eligible.length;
  const limit = Math.max(1, Math.min(input.limit ?? 5, 20));

  const payload: PrecedentPayload = {
    clientId: input.clientId,
    query: input.query,
    industry: input.industry ?? null,
    precedents: eligible,
    limit,
  };

  const request = buildRequest({
    task: 'precedent_search',
    clientId: input.clientId,
    payload,
    jsonSchema: SCHEMA,
    instructions:
      `Rank the supplied precedents by how well they answer: "${input.query}". Return at most ${limit}, best ` +
      'first, each with the specific overlap that makes it relevant. Only ids that appear below. If nothing ' +
      'genuinely matches, return an empty list — a bad precedent is worse than none.',
  });

  const byId = new Map(eligible.map((p) => [p.id, p]));

  return runTask<PrecedentSearchResult>({
    task: 'precedent_search',
    clientId: input.clientId,
    userId: input.userId ?? null,
    request,
    relatedEntity: 'precedents',
    relatedId: null,
    provider: input.provider,
    threshold: input.threshold,
    logger: input.logger,
    parse: (res) => {
      const raw = requireJson<Partial<PrecedentResultModel>>(res, res.model, 'precedent search');
      const list = Array.isArray(raw.matches) ? (raw.matches as Partial<PrecedentMatchModel>[]) : [];

      const matches: PrecedentMatch[] = [];
      let fabricated = 0;
      for (const m of list) {
        const source = typeof m.precedentId === 'string' ? byId.get(m.precedentId) : undefined;
        if (!source) {
          fabricated += 1;
          continue;
        }
        matches.push({
          precedentId: source.id,
          title: source.title, // trust our record, not the model's restatement
          score: clampConfidence(Number(m.score ?? 0)),
          whyMatched:
            typeof m.whyMatched === 'string' && m.whyMatched.trim()
              ? m.whyMatched.trim()
              : 'No explanation supplied.',
          snippet:
            typeof m.snippet === 'string' && m.snippet.trim()
              ? m.snippet.trim()
              : source.body.slice(0, 220),
          scope: source.clientId === null ? 'firm' : 'client',
        });
        if (matches.length >= limit) break;
      }

      const confidence = clampConfidence(Number(raw.confidence ?? 0));
      const notes: string[] = [];
      if (fabricated > 0) notes.push(`${fabricated} returned id(s) were not in the candidate set and were dropped`);
      if (excludedForScope > 0) {
        notes.push(`${excludedForScope} candidate(s) excluded before the prompt for belonging to another client`);
      }

      const reasoning =
        (typeof raw.reasoning === 'string' && raw.reasoning.trim()
          ? raw.reasoning.trim()
          : 'No reasoning supplied by the provider.') + (notes.length ? ` Validation: ${notes.join('; ')}.` : '');

      const value: PrecedentSearchResult = {
        matches,
        confidence,
        reasoning,
        needsHuman: false, // set by the gate below
        excludedForScope,
      };
      return { value, confidence, reasoning };
    },
  }).then((s) => s.map((v) => ({ ...v, needsHuman: s.needsHuman, reasoning: s.meta.reasoning })));
}
