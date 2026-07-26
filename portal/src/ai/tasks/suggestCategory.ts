/**
 * Task: categorisation suggestion — the volume win, and the compounding one.
 *
 * ## Order of consultation (this order is the whole point)
 *
 * 1. **`categorization_rules`.** A rule hit returns immediately with
 *    `confidence: 100` and `source: 'rule'`. No provider is called. Every human
 *    correction becomes a rule, so the system improves *deterministically*
 *    rather than only probabilistically, and the advantage accrues to the firm
 *    rather than to a model vendor (STAFF-WORKSPACE.md §2, §10.3).
 * 2. **The model**, given this client's chart of accounts and this client's
 *    prior human decisions — never another client's.
 * 3. **Neither.** Below the confidence threshold the answer is `needsHuman:
 *    true` and a suggested question for the client, not a guess. In accounting
 *    a confident wrong number is worse than no number.
 *
 * Rules, categories and prior decisions are passed in by the calling service.
 * The AI layer reads no tables and writes none.
 */

import { Suggestion } from '../../lib/ai-guard.js';
import { clampConfidence } from '../format.js';
import { buildRequest } from '../request.js';
import { recordDeterministic, requireJson, runTask } from '../index.js';
import { matchRule, type CategorizationRuleRef } from '../rules.js';
import type { RunLogger } from '../runlog.js';
import type { AiProvider } from '../provider.js';
import type {
  CategorizeModel,
  CategorizePayload,
  CategoryRef,
  PriorDecision,
  TransactionRef,
} from '../payloads.js';

export interface SuggestCategoryInput {
  readonly clientId: string;
  readonly userId?: string | null;
  readonly transaction: TransactionRef;
  /** This client's chart of accounts, plus firm-wide defaults. */
  readonly categories: readonly CategoryRef[];
  /** This client's rules, loaded by the caller. Consulted before the model. */
  readonly rules?: readonly CategorizationRuleRef[];
  /** Prior human categorisations for this client, grouped by counterparty. */
  readonly priorDecisions?: readonly PriorDecision[];
  readonly businessType?: string | null;
  readonly provider?: AiProvider;
  readonly threshold?: number;
  readonly logger?: RunLogger;
}

export interface CategorySuggestion {
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly confidence: number;
  readonly reasoning: string;
  readonly needsHuman: boolean;
  /** `rule` beats `model`. Recorded so the compounding effect is measurable. */
  readonly source: 'rule' | 'model';
  /** The rule that fired, when source is 'rule'. */
  readonly ruleId: string | null;
  /** Set when the vendor genuinely cannot be resolved from the line alone. */
  readonly suggestedQuestion: string | null;
}

const SCHEMA = {
  type: 'object',
  required: ['categoryId', 'categoryName', 'confidence', 'reasoning'],
  properties: {
    categoryId: { type: ['string', 'null'], description: 'must be one of the supplied category ids' },
    categoryName: { type: ['string', 'null'] },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    reasoning: { type: 'string' },
    ambiguous: { type: 'boolean' },
    suggestedQuestion: { type: ['string', 'null'] },
  },
};

export async function suggestCategory(input: SuggestCategoryInput): Promise<Suggestion<CategorySuggestion>> {
  const started = Date.now();
  const txn = input.transaction;
  const rules = input.rules ?? [];

  // ---- 1. Deterministic rules first. A rule hit never reaches a model. ----
  const hit = matchRule(txn, rules);
  if (hit) {
    const category = input.categories.find((c) => c.id === hit.rule.categoryId);
    const value: CategorySuggestion = {
      categoryId: hit.rule.categoryId,
      categoryName: category?.name ?? null,
      confidence: 100,
      reasoning:
        `Matched a ${hit.rule.source === 'learned' ? 'learned' : 'hand-written'} ${hit.why}` +
        `${category ? ` → ${category.name}` : ''}. ` +
        `This rule has fired ${hit.rule.hitCount} time${hit.rule.hitCount === 1 ? '' : 's'} before. ` +
        'Deterministic rule, no model involved.',
      needsHuman: false,
      source: 'rule',
      ruleId: hit.rule.id,
      suggestedQuestion: null,
    };
    return recordDeterministic({
      task: 'categorize',
      clientId: input.clientId,
      userId: input.userId ?? null,
      value,
      confidence: 100,
      reasoning: value.reasoning,
      source: 'rule',
      relatedEntity: 'transactions',
      relatedId: txn.id,
      threshold: input.threshold,
      logger: input.logger,
      startedAt: started,
    });
  }

  // ---- 2. Fall back to the model, scoped to this client only. ----
  const payload: CategorizePayload = {
    clientId: input.clientId,
    transaction: txn,
    categories: input.categories,
    priorDecisions: input.priorDecisions ?? [],
    businessType: input.businessType ?? null,
  };

  const request = buildRequest({
    task: 'categorize',
    clientId: input.clientId,
    payload,
    jsonSchema: SCHEMA,
    instructions:
      'Suggest a category for this one transaction. Choose only from the supplied categories and return its exact ' +
      'id. Prior human decisions for this client outweigh anything you know about the vendor in general. If the ' +
      'vendor is ambiguous for this business, return a low confidence and a question worth asking the client — ' +
      'that is a better outcome than a guess.',
  });

  return runTask<CategorySuggestion>({
    task: 'categorize',
    clientId: input.clientId,
    userId: input.userId ?? null,
    request,
    relatedEntity: 'transactions',
    relatedId: txn.id,
    provider: input.provider,
    threshold: input.threshold,
    logger: input.logger,
    source: 'model',
    parse: (res) => {
      const raw = requireJson<Partial<CategorizeModel>>(res, res.model, 'category suggestion');

      // A category id the model invented is worse than no answer — drop it.
      const proposedId = typeof raw.categoryId === 'string' ? raw.categoryId : null;
      const category = proposedId ? input.categories.find((c) => c.id === proposedId) : undefined;
      const invented = proposedId !== null && category === undefined;

      let confidence = clampConfidence(Number(raw.confidence ?? 0));
      let reasoning = typeof raw.reasoning === 'string' && raw.reasoning.trim()
        ? raw.reasoning.trim()
        : 'No reasoning supplied by the provider.';

      if (invented) {
        confidence = 0;
        reasoning =
          `Provider returned category id "${proposedId}", which is not in this client's chart of accounts. ` +
          `Discarded and routed to a human. (Original reasoning: ${reasoning})`;
      }

      const value: CategorySuggestion = {
        categoryId: category?.id ?? null,
        categoryName: category?.name ?? null,
        confidence,
        reasoning,
        needsHuman: false, // set by the gate below
        source: 'model',
        ruleId: null,
        suggestedQuestion:
          typeof raw.suggestedQuestion === 'string' && raw.suggestedQuestion.trim()
            ? raw.suggestedQuestion.trim()
            : null,
      };
      return { value, confidence, reasoning };
    },
  }).then((s) =>
    s.map((v) => ({
      ...v,
      needsHuman: s.needsHuman,
      reasoning: s.meta.reasoning,
      // Below the threshold with nothing to ask, generate the question the
      // bookkeeper would have had to write by hand.
      suggestedQuestion:
        v.suggestedQuestion ??
        (s.needsHuman
          ? `What was the charge from "${(txn.counterparty ?? txn.description).trim()}" on ${txn.postedAt} for?`
          : null),
    })),
  );
}
