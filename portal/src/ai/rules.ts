/**
 * The rules engine — the deterministic half of categorisation.
 *
 * This is the compounding asset. Every human correction becomes a rule, so a
 * client in year two costs materially less to serve than in year one, and the
 * advantage belongs to the firm rather than to a model vendor
 * (STAFF-WORKSPACE.md §2, §10.3).
 *
 * **A rule hit always beats the model.** `suggestCategory` consults rules first
 * and only calls a provider when nothing matches.
 *
 * Rules are passed *in* as plain data rather than queried here: the AI layer
 * reads no tables and writes none. The calling service loads them (scoped to
 * the client) and hands them over.
 */

import { normalizeVendor } from './format.js';
import type { TransactionRef } from './payloads.js';

/** Mirrors a `categorization_rules` row (src/db/schema.ts). */
export interface CategorizationRuleRef {
  readonly id: string;
  /** Null = firm-wide rule. */
  readonly clientId: string | null;
  readonly matchType: 'contains' | 'equals' | 'regex' | 'counterparty';
  readonly pattern: string;
  readonly minAmountCents: number | null;
  readonly maxAmountCents: number | null;
  readonly categoryId: string;
  readonly source: 'learned' | 'manual';
  readonly hitCount: number;
  readonly disabledAt: string | null;
}

export interface RuleMatch {
  readonly rule: CategorizationRuleRef;
  /** Human-readable, for the reasoning line the bookkeeper reads. */
  readonly why: string;
}

const MAX_PATTERN_LENGTH = 200;
/** Crude nested-quantifier check — enough to keep a pathological rule out. */
const REDOS_SHAPE = /(\([^)]*[+*][^)]*\)|\[[^\]]*\])\s*[+*]\s*[+*]?/;

/**
 * Find the best matching rule for a transaction, or null.
 *
 * Specificity order (first differing test wins):
 *   1. client-specific beats firm-wide
 *   2. match type: equals > counterparty > regex > contains
 *   3. rule with an amount window beats one without
 *   4. longer pattern beats shorter
 *   5. more historical hits beats fewer
 */
export function matchRule(
  txn: Pick<TransactionRef, 'description' | 'counterparty' | 'amountCents'>,
  rules: readonly CategorizationRuleRef[],
): RuleMatch | null {
  const candidates: RuleMatch[] = [];

  for (const rule of rules) {
    if (rule.disabledAt) continue;
    if (!withinAmountWindow(txn.amountCents, rule)) continue;
    const why = testRule(txn, rule);
    if (why) candidates.push({ rule, why });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => specificity(b.rule) - specificity(a.rule));
  return candidates[0] ?? null;
}

function withinAmountWindow(amountCents: number, rule: CategorizationRuleRef): boolean {
  // Windows are expressed on the signed value as stored (negative = money out).
  if (rule.minAmountCents !== null && amountCents < rule.minAmountCents) return false;
  if (rule.maxAmountCents !== null && amountCents > rule.maxAmountCents) return false;
  return true;
}

function testRule(
  txn: Pick<TransactionRef, 'description' | 'counterparty' | 'amountCents'>,
  rule: CategorizationRuleRef,
): string | null {
  const description = txn.description ?? '';
  const counterparty = txn.counterparty ?? '';
  const window =
    rule.minAmountCents !== null || rule.maxAmountCents !== null
      ? ' within its amount window'
      : '';

  switch (rule.matchType) {
    case 'equals': {
      const hit =
        description.trim().toLowerCase() === rule.pattern.trim().toLowerCase() ||
        counterparty.trim().toLowerCase() === rule.pattern.trim().toLowerCase();
      return hit ? `rule (exact match on "${rule.pattern}")${window}` : null;
    }
    case 'counterparty': {
      const hit = normalizeVendor(counterparty) === normalizeVendor(rule.pattern);
      return hit ? `rule (counterparty "${rule.pattern}")${window}` : null;
    }
    case 'regex': {
      const re = compileSafe(rule.pattern);
      if (!re) return null;
      const hit = re.test(description) || re.test(counterparty);
      return hit ? `rule (pattern /${rule.pattern}/i)${window}` : null;
    }
    case 'contains': {
      const needle = rule.pattern.trim().toLowerCase();
      if (!needle) return null;
      const hit =
        description.toLowerCase().includes(needle) || counterparty.toLowerCase().includes(needle);
      return hit ? `rule (description contains "${rule.pattern}")${window}` : null;
    }
  }
}

/** Compile a stored regex defensively — a bad rule must not take the queue down. */
function compileSafe(pattern: string): RegExp | null {
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH) return null;
  if (REDOS_SHAPE.test(pattern)) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

const MATCH_TYPE_RANK: Record<CategorizationRuleRef['matchType'], number> = {
  equals: 4,
  counterparty: 3,
  regex: 2,
  contains: 1,
};

function specificity(rule: CategorizationRuleRef): number {
  const clientScoped = rule.clientId ? 10_000 : 0;
  const typeRank = MATCH_TYPE_RANK[rule.matchType] * 1_000;
  const windowed = rule.minAmountCents !== null || rule.maxAmountCents !== null ? 500 : 0;
  const length = Math.min(rule.pattern.length, 200);
  const hits = Math.min(rule.hitCount, 99) / 100;
  return clientScoped + typeRank + windowed + length + hits;
}
