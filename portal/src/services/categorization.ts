/**
 * The categorisation co-pilot — the volume win, and the compounding one.
 *
 * STAFF-WORKSPACE.md §2 in four rules, all implemented here:
 *
 * 1. **Grouped, not one-by-one.** Uncategorised transactions are collapsed by
 *    normalised counterparty, so the bookkeeper sees *"47 transactions from
 *    Shell"* and makes one decision with 47 outcomes.
 * 2. **Confidence-sorted.** High-confidence groups come first for fast
 *    clearing; anything the model or the rules engine flagged `needsHuman` is
 *    surfaced separately rather than mixed in where it can be rubber-stamped.
 * 3. **Reasoning always visible.** Every group carries the suggestion's
 *    confidence, its source (rule vs model) and its reasoning line. A
 *    suggestion you can't audit is a suggestion you shouldn't trust.
 * 4. **Every confirmation becomes a durable rule.** {@link applyCategoryToGroup}
 *    writes a `categorization_rules` row with `source: 'learned'`. That is the
 *    compounding loop: the same vendor never costs a decision twice, the
 *    deterministic path takes over from the model, and the advantage accrues to
 *    the firm rather than to a model vendor.
 *
 * ## Where the guardrail sits
 *
 * `suggestCategory` returns a `Suggestion<CategorySuggestion>`. It cannot be
 * persisted. {@link applyCategoryToGroup} accepts only a
 * `ConfirmedSuggestion<CategorySuggestion>` — minted by `.confirm(userId)` and
 * re-checked at runtime by `requireConfirmed` — or no suggestion at all, when
 * the human picked a category outright. AI proposes; a human commits.
 */

import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { categories, categorizationRules, clients, transactions } from '../db/schema.js';
import { normalizeVendor } from '../ai/format.js';
import { suggestCategory, type CategorySuggestion } from '../ai/tasks/suggestCategory.js';
import type { CategorizationRuleRef } from '../ai/rules.js';
import type { CategoryRef, PriorDecision, TransactionRef } from '../ai/payloads.js';
import {
  requireConfirmed,
  type ConfirmedSuggestion,
  type Suggestion,
} from '../lib/ai-guard.js';
import { audit } from '../lib/audit.js';

/** Groups per page. Beyond this the screen stops being scannable. */
export const MAX_GROUPS = 40;
/** Transactions pulled per client. A bigger backlog is a bulk-import problem. */
export const MAX_TRANSACTIONS = 2000;

export type TxnRow = typeof transactions.$inferSelect;

export interface CounterpartyGroup {
  /** `normalizeVendor()` output — the identity the group is keyed on. */
  readonly key: string;
  /** The label a human recognises, e.g. "Shell". */
  readonly label: string;
  readonly transactions: readonly TxnRow[];
  readonly count: number;
  readonly totalCents: number;
  readonly firstPostedAt: string;
  readonly lastPostedAt: string;
  /** The transaction the suggestion was computed against. */
  readonly representative: TxnRow;
}

export interface SuggestedGroup extends CounterpartyGroup {
  readonly suggestion: CategorySuggestion;
  readonly confidence: number;
  readonly reasoning: string;
  readonly source: 'rule' | 'model';
  readonly needsHuman: boolean;
  readonly suggestedCategoryId: string | null;
  readonly suggestedCategoryName: string | null;
  readonly suggestedQuestion: string | null;
}

export interface CategorizeView {
  readonly client: typeof clients.$inferSelect;
  readonly categories: readonly (typeof categories.$inferSelect)[];
  /** Confident enough to clear in a keystroke, best first. */
  readonly confident: readonly SuggestedGroup[];
  /** Below the threshold — surfaced separately, never mixed in. */
  readonly needsReview: readonly SuggestedGroup[];
  readonly totalUncategorized: number;
  readonly groupedCount: number;
  readonly learnedRuleCount: number;
}

/* ========================================================================== */
/* Grouping — pure                                                            */
/* ========================================================================== */

/**
 * Collapse transactions by normalised counterparty. Bank-feed vendor strings
 * are noisy ("SHELL OIL 57444102 03/14" and "SHELL SERVICE #4021" are one
 * vendor); `normalizeVendor` strips the terminal ids, embedded dates and card
 * prefixes so they land in the same bucket.
 *
 * Groups are returned largest first — clearing the biggest pile first is what
 * makes the screen feel fast.
 */
export function groupByCounterparty(rows: readonly TxnRow[]): readonly CounterpartyGroup[] {
  const buckets = new Map<string, TxnRow[]>();
  for (const row of rows) {
    const key = normalizeVendor(row.counterparty ?? row.description) || '(unrecognised)';
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
  }

  const groups: CounterpartyGroup[] = [];
  for (const [key, list] of buckets) {
    const sorted = [...list].sort((a, b) => a.postedAt.localeCompare(b.postedAt));
    const representative = sorted[sorted.length - 1]!;
    groups.push({
      key,
      label: prettyLabel(list),
      transactions: sorted,
      count: sorted.length,
      totalCents: sorted.reduce((n, t) => n + t.amountCents, 0),
      firstPostedAt: sorted[0]!.postedAt,
      lastPostedAt: representative.postedAt,
      representative,
    });
  }
  return groups.sort((a, b) => b.count - a.count || Math.abs(b.totalCents) - Math.abs(a.totalCents));
}

/** The most common raw counterparty in the bucket — what a human calls it. */
function prettyLabel(rows: readonly TxnRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const raw = (row.counterparty ?? row.description).trim();
    if (!raw) continue;
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  let best = '';
  let bestCount = -1;
  for (const [label, n] of counts) {
    // Prefer the most frequent, then the shortest (least feed noise).
    if (n > bestCount || (n === bestCount && label.length < best.length)) {
      best = label;
      bestCount = n;
    }
  }
  return best || 'Unrecognised vendor';
}

/**
 * Sort for throughput: confident groups first so they clear in a keystroke,
 * biggest first inside a confidence band. Low-confidence groups are *returned
 * separately*, not sorted to the bottom — mixing them in is how a low-
 * confidence guess gets rubber-stamped along with everything else.
 */
export function splitByConfidence(groups: readonly SuggestedGroup[]): {
  confident: readonly SuggestedGroup[];
  needsReview: readonly SuggestedGroup[];
} {
  const confident = groups
    .filter((g) => !g.needsHuman && g.suggestedCategoryId !== null)
    .sort((a, b) => b.confidence - a.confidence || b.count - a.count);
  const needsReview = groups
    .filter((g) => g.needsHuman || g.suggestedCategoryId === null)
    .sort((a, b) => b.count - a.count || b.confidence - a.confidence);
  return { confident, needsReview };
}

/* ========================================================================== */
/* Loading                                                                    */
/* ========================================================================== */

/** This client's chart of accounts plus the firm-wide defaults. */
export async function loadCategories(clientId: string): Promise<(typeof categories.$inferSelect)[]> {
  return db.query.categories.findMany({
    where: and(
      or(eq(categories.clientId, clientId), isNull(categories.clientId)),
      isNull(categories.archivedAt),
    ),
    orderBy: [categories.name],
  });
}

/** This client's rules plus firm-wide ones. Consulted before any model. */
export async function loadRules(clientId: string): Promise<CategorizationRuleRef[]> {
  const rows = await db.query.categorizationRules.findMany({
    where: and(
      or(eq(categorizationRules.clientId, clientId), isNull(categorizationRules.clientId)),
      isNull(categorizationRules.disabledAt),
    ),
    orderBy: [desc(categorizationRules.hitCount)],
  });
  return rows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    matchType: r.matchType,
    pattern: r.pattern,
    minAmountCents: r.minAmountCents,
    maxAmountCents: r.maxAmountCents,
    categoryId: r.categoryId,
    source: r.source,
    hitCount: r.hitCount,
    disabledAt: r.disabledAt ? r.disabledAt.toISOString() : null,
  }));
}

/**
 * Prior human decisions for this client, by counterparty — the strongest
 * evidence there is, and the only history that ever reaches a prompt. Never
 * another client's: see `assertClientScoped` in `lib/ai-guard.ts`.
 */
export async function loadPriorDecisions(clientId: string): Promise<PriorDecision[]> {
  const rows = await db
    .select({
      counterparty: transactions.counterparty,
      description: transactions.description,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
    })
    .from(transactions)
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .where(
      and(
        eq(transactions.clientId, clientId),
        isNotNull(transactions.categoryId),
        inArray(transactions.categorizedBy, ['human', 'rule']),
      ),
    )
    .limit(5000);

  const tally = new Map<string, PriorDecision & { key: string }>();
  for (const row of rows) {
    const raw = (row.counterparty ?? row.description).trim();
    const key = `${normalizeVendor(raw)}|${row.categoryId}`;
    if (!normalizeVendor(raw)) continue;
    const existing = tally.get(key);
    if (existing) {
      tally.set(key, { ...existing, count: existing.count + 1 });
    } else {
      tally.set(key, {
        key,
        counterparty: raw,
        categoryId: row.categoryId!,
        categoryName: row.categoryName,
        count: 1,
      });
    }
  }
  return [...tally.values()]
    .map(({ key: _key, ...d }) => d)
    .sort((a, b) => b.count - a.count);
}

function toTransactionRef(row: TxnRow): TransactionRef {
  return {
    id: row.id,
    clientId: row.clientId,
    postedAt: row.postedAt,
    description: row.description,
    counterparty: row.counterparty,
    amountCents: row.amountCents,
  };
}

function toCategoryRef(row: typeof categories.$inferSelect): CategoryRef {
  return { id: row.id, clientId: row.clientId, name: row.name, kind: row.kind };
}

/**
 * Build the whole co-pilot screen: group, suggest, split by confidence.
 *
 * One suggestion per *group*, not per transaction — the representative is the
 * most recent charge in the bucket. That is 40 provider calls for a 2,000-line
 * backlog instead of 2,000, and it is the same decision either way.
 */
export async function buildCategorizeView(
  clientId: string,
  userId: string,
): Promise<CategorizeView | null> {
  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client) return null;

  const [uncategorized, cats, rules, priorDecisions, learnedRules] = await Promise.all([
    db.query.transactions.findMany({
      where: and(eq(transactions.clientId, clientId), isNull(transactions.categoryId)),
      orderBy: [desc(transactions.postedAt)],
      limit: MAX_TRANSACTIONS,
    }),
    loadCategories(clientId),
    loadRules(clientId),
    loadPriorDecisions(clientId),
    db
      .select({ id: categorizationRules.id })
      .from(categorizationRules)
      .where(
        and(eq(categorizationRules.clientId, clientId), eq(categorizationRules.source, 'learned')),
      ),
  ]);

  const allGroups = groupByCounterparty(uncategorized);
  const shown = allGroups.slice(0, MAX_GROUPS);
  const categoryRefs = cats.map(toCategoryRef);

  const suggested = await Promise.all(
    shown.map(async (group) => {
      const suggestion = await suggestCategory({
        clientId,
        userId,
        transaction: toTransactionRef(group.representative),
        categories: categoryRefs,
        rules,
        priorDecisions,
        businessType: null,
      });
      return decorate(group, suggestion);
    }),
  );

  const { confident, needsReview } = splitByConfidence(suggested);

  return {
    client,
    categories: cats,
    confident,
    needsReview,
    totalUncategorized: uncategorized.length,
    groupedCount: allGroups.length,
    learnedRuleCount: learnedRules.length,
  };
}

function decorate(group: CounterpartyGroup, suggestion: Suggestion<CategorySuggestion>): SuggestedGroup {
  const v = suggestion.value;
  return {
    ...group,
    suggestion: v,
    confidence: suggestion.meta.confidence,
    reasoning: suggestion.meta.reasoning,
    source: v.source,
    needsHuman: suggestion.meta.needsHuman,
    suggestedCategoryId: v.categoryId,
    suggestedCategoryName: v.categoryName,
    suggestedQuestion: v.suggestedQuestion,
  };
}

/**
 * Re-derive a single group's suggestion — used by the apply path so the
 * `Suggestion` a human confirms is one this process actually produced, rather
 * than one reconstructed from form fields the browser sent back.
 */
export async function suggestForGroup(
  clientId: string,
  userId: string,
  representative: TxnRow,
): Promise<Suggestion<CategorySuggestion>> {
  const [cats, rules, priorDecisions] = await Promise.all([
    loadCategories(clientId),
    loadRules(clientId),
    loadPriorDecisions(clientId),
  ]);
  return suggestCategory({
    clientId,
    userId,
    transaction: toTransactionRef(representative),
    categories: cats.map(toCategoryRef),
    rules,
    priorDecisions,
    businessType: null,
  });
}

/* ========================================================================== */
/* Applying — the compounding loop                                            */
/* ========================================================================== */

export interface ApplyGroupInput {
  readonly clientId: string;
  readonly userId: string;
  /** The transactions to categorise. Scoped to the client before any write. */
  readonly transactionIds: readonly string[];
  readonly categoryId: string;
  /**
   * The suggestion the human accepted, already `.confirm(userId)`-ed. Absent
   * when the bookkeeper picked a category outright (number keys) — then the
   * decision is 100% human and no confidence is recorded.
   */
  readonly confirmed?: ConfirmedSuggestion<CategorySuggestion> | null;
  /** Write a `learned` rule so this vendor never costs a decision twice. */
  readonly learnRule?: boolean;
  /** Raw counterparty label the rule should match on. */
  readonly counterpartyLabel?: string | null;
}

export interface ApplyGroupResult {
  readonly categorized: number;
  readonly categoryId: string;
  readonly categoryName: string | null;
  readonly ruleId: string | null;
  readonly ruleCreated: boolean;
  readonly ruleUpdated: boolean;
  readonly confidence: number | null;
  readonly source: 'human' | 'human_confirmed_rule' | 'human_confirmed_model';
}

/**
 * Apply a category to N transactions and learn the rule.
 *
 * Two writes, in this order, both attributed to a named human:
 *
 * 1. `transactions` — `category_id`, `categorized_by`, `categorized_by_id`,
 *    `categorized_at`, `category_confidence`.
 * 2. `categorization_rules` — a `source: 'learned'` rule matching this
 *    counterparty, so the *next* charge from this vendor is resolved
 *    deterministically by the rules engine and never reaches a model at all.
 *
 * `categorized_by` is always `'human'`: a human committed it, whatever
 * suggested it. The AI's contribution is preserved in `category_confidence`
 * and in the audit trail, which is what guardrail §10.4 actually asks for —
 * a record that distinguishes AI-suggested from human-confirmed.
 */
export async function applyCategoryToGroup(input: ApplyGroupInput): Promise<ApplyGroupResult> {
  if (input.transactionIds.length === 0) {
    throw new Error('applyCategoryToGroup: no transactions supplied.');
  }

  // Runtime companion to the compile-time brand. A raw Suggestion never lands.
  const confirmed = input.confirmed
    ? requireConfirmed(input.confirmed, 'applyCategoryToGroup')
    : null;

  // The category must belong to this client (or be a firm-wide default).
  const category = await db.query.categories.findFirst({
    where: and(
      eq(categories.id, input.categoryId),
      or(eq(categories.clientId, input.clientId), isNull(categories.clientId)),
    ),
  });
  if (!category) {
    throw new Error('applyCategoryToGroup: category does not belong to this client.');
  }

  // Client-scoped update: an id from the form is never enough on its own.
  const updated = await db
    .update(transactions)
    .set({
      categoryId: category.id,
      categorizedBy: 'human',
      categorizedById: input.userId,
      categorizedAt: new Date(),
      categoryConfidence: confirmed ? confirmed.meta.confidence : null,
    })
    .where(
      and(
        eq(transactions.clientId, input.clientId),
        inArray(transactions.id, [...input.transactionIds]),
        isNull(transactions.categoryId),
      ),
    )
    .returning({ id: transactions.id });

  // ---- The compounding piece: the correction becomes a durable rule. ----
  let ruleId: string | null = null;
  let ruleCreated = false;
  let ruleUpdated = false;
  const label = (input.counterpartyLabel ?? '').trim();

  if (input.learnRule !== false && label) {
    const learned = await learnRule({
      clientId: input.clientId,
      userId: input.userId,
      pattern: label,
      categoryId: category.id,
    });
    ruleId = learned.ruleId;
    ruleCreated = learned.created;
    ruleUpdated = learned.updated;
  }

  const source: ApplyGroupResult['source'] = !confirmed
    ? 'human'
    : confirmed.meta.source === 'rule'
      ? 'human_confirmed_rule'
      : 'human_confirmed_model';

  await audit(null, {
    action: 'workspace.categorize_apply',
    userId: input.userId,
    clientId: input.clientId,
    entity: 'transactions',
    entityId: category.id,
    meta: {
      categorized: updated.length,
      requested: input.transactionIds.length,
      categoryId: category.id,
      categoryName: category.name,
      counterparty: label || null,
      source,
      aiConfidence: confirmed?.meta.confidence ?? null,
      aiReasoning: confirmed?.meta.reasoning ?? null,
      aiRunId: confirmed?.meta.runId ?? null,
      overrodeLowConfidence: confirmed?.overrodeLowConfidence ?? false,
      ruleId,
      ruleCreated,
      ruleUpdated,
    },
  });

  return {
    categorized: updated.length,
    categoryId: category.id,
    categoryName: category.name,
    ruleId,
    ruleCreated,
    ruleUpdated,
    confidence: confirmed?.meta.confidence ?? null,
    source,
  };
}

/**
 * Create — or sharpen — the learned rule for a counterparty.
 *
 * Same vendor, same category → bump the hit count, so specificity ranking in
 * `ai/rules.ts` learns which rules actually earn their keep. Same vendor,
 * *different* category → the human just corrected us; the rule is repointed
 * rather than left to fight the new decision on every future charge.
 */
export async function learnRule(input: {
  clientId: string;
  userId: string;
  pattern: string;
  categoryId: string;
}): Promise<{ ruleId: string; created: boolean; updated: boolean }> {
  const pattern = input.pattern.slice(0, 200);

  const existing = await db.query.categorizationRules.findFirst({
    where: and(
      eq(categorizationRules.clientId, input.clientId),
      eq(categorizationRules.matchType, 'counterparty'),
      sql`lower(${categorizationRules.pattern}) = lower(${pattern})`,
      isNull(categorizationRules.disabledAt),
    ),
  });

  if (existing) {
    const repoint = existing.categoryId !== input.categoryId;
    await db
      .update(categorizationRules)
      .set({
        categoryId: input.categoryId,
        hitCount: existing.hitCount + 1,
        lastHitAt: new Date(),
      })
      .where(eq(categorizationRules.id, existing.id));
    return { ruleId: existing.id, created: false, updated: repoint };
  }

  const [row] = await db
    .insert(categorizationRules)
    .values({
      clientId: input.clientId,
      matchType: 'counterparty',
      pattern,
      categoryId: input.categoryId,
      source: 'learned',
      createdBy: input.userId,
      hitCount: 1,
      lastHitAt: new Date(),
    })
    .returning();

  return { ruleId: row!.id, created: true, updated: false };
}

/** The transactions a group covers, re-read server-side before any write. */
export async function transactionsForGroup(
  clientId: string,
  groupKey: string,
): Promise<readonly TxnRow[]> {
  const uncategorized = await db.query.transactions.findMany({
    where: and(eq(transactions.clientId, clientId), isNull(transactions.categoryId)),
    orderBy: [desc(transactions.postedAt)],
    limit: MAX_TRANSACTIONS,
  });
  return uncategorized.filter(
    (t) => (normalizeVendor(t.counterparty ?? t.description) || '(unrecognised)') === groupKey,
  );
}
