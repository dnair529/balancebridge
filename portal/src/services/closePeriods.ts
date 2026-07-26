/**
 * Close orchestration and the AI pre-flight.
 *
 * STAFF-WORKSPACE.md §6: *"Only files that pass pre-flight reach the reviewer.
 * This is the mechanism that lets client count grow **without error rate
 * growing** — the failure mode that kills scaling firms."*
 *
 * ## The gate
 *
 * `preflightClose` returns a `Suggestion<PreflightResult>` whose blocking
 * checks are arithmetic, not opinion (see `ai/tasks/preflightClose.ts` — the
 * provider's verdict is overwritten wherever it disagrees with the supplied
 * counts). This module persists those checks to `close_checks` and then
 * {@link advanceToReview} refuses to move a period to `in_review` while any
 * `severity: 'block'` check is failing. The refusal reads from the database,
 * not from the in-memory result, so it holds however the caller got here.
 *
 * ## The narrative
 *
 * Drafting and approving are two different acts by two different columns:
 *
 * - {@link draftCloseNarrative} writes `close_periods.narrative` and leaves
 *   `narrative_approved_by` / `_at` **null**. A draft is not an approval.
 * - {@link approveNarrative} sets those columns, and only a human calls it.
 *
 * Nothing here sends anything to a client. Ever.
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  accounts,
  anomalies,
  categories,
  clientQuestions,
  clients,
  closeChecks,
  closePeriods,
  documentRequests,
  transactions,
} from '../db/schema.js';
import { draftNarrative, type NarrativeDraft } from '../ai/tasks/draftNarrative.js';
import { preflightClose, type PreflightResult } from '../ai/tasks/preflightClose.js';
import type { CategoryMovement, PeriodRef, PreflightFacts } from '../ai/payloads.js';
import { requireConfirmed, type ConfirmedSuggestion, type Suggestion } from '../lib/ai-guard.js';
import { audit } from '../lib/audit.js';

export type ClosePeriodRow = typeof closePeriods.$inferSelect;
export type CloseCheckRow = typeof closeChecks.$inferSelect;

export interface CloseView {
  readonly client: typeof clients.$inferSelect;
  readonly period: ClosePeriodRow | null;
  readonly checks: readonly CloseCheckRow[];
  readonly blockingFailures: number;
  readonly warnings: number;
  readonly readyForReview: boolean;
  readonly lastCheckedAt: Date | null;
  readonly facts: PreflightFacts | null;
  readonly history: readonly ClosePeriodRow[];
}

/* ========================================================================== */
/* Periods                                                                    */
/* ========================================================================== */

/** The period a bookkeeper means when they say "the close". Newest first. */
export async function latestPeriod(clientId: string): Promise<ClosePeriodRow | null> {
  const rows = await db.query.closePeriods.findMany({
    where: eq(closePeriods.clientId, clientId),
    orderBy: [desc(closePeriods.periodStart)],
    limit: 1,
  });
  return rows[0] ?? null;
}

/** Previous calendar month, delivered by the 10th of this one — the norm. */
export function previousMonthPeriod(now = new Date()): {
  periodStart: string;
  periodEnd: string;
  targetDate: string;
  label: string;
} {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 10));
  return {
    periodStart: iso(start),
    periodEnd: iso(end),
    targetDate: iso(target),
    label: start.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  };
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Idempotent: one row per (client, period_start) is enforced by the schema. */
export async function openPeriod(
  clientId: string,
  userId: string,
  now = new Date(),
): Promise<ClosePeriodRow> {
  const spec = previousMonthPeriod(now);
  const existing = await db.query.closePeriods.findFirst({
    where: and(eq(closePeriods.clientId, clientId), eq(closePeriods.periodStart, spec.periodStart)),
  });
  if (existing) return existing;

  const [row] = await db
    .insert(closePeriods)
    .values({
      clientId,
      periodStart: spec.periodStart,
      periodEnd: spec.periodEnd,
      targetDate: spec.targetDate,
      status: 'in_progress',
      ownerId: userId,
    })
    .returning();

  await audit(null, {
    action: 'workspace.close_open',
    userId,
    clientId,
    entity: 'close_periods',
    entityId: row!.id,
    meta: { periodStart: spec.periodStart, targetDate: spec.targetDate },
  });
  return row!;
}

export function periodRef(period: ClosePeriodRow): PeriodRef {
  const start = new Date(`${period.periodStart}T00:00:00Z`);
  return {
    start: period.periodStart,
    end: period.periodEnd,
    label: start.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  };
}

/* ========================================================================== */
/* Facts — everything the pre-flight judges, computed from the ledger          */
/* ========================================================================== */

/**
 * Gather the counts the pre-flight is judged on. Deliberately a separate,
 * inspectable step: the same facts are rendered on the close page, so a
 * bookkeeper can see *why* a check failed without re-running anything.
 */
export async function gatherFacts(clientId: string, period: ClosePeriodRow): Promise<PreflightFacts> {
  const inPeriod = and(
    eq(transactions.clientId, clientId),
    sql`${transactions.postedAt} >= ${period.periodStart}`,
    sql`${transactions.postedAt} <= ${period.periodEnd}`,
  );

  const [periodTxns, accountRows, allTxns, docReqs, questions, openAnoms] = await Promise.all([
    db.select().from(transactions).where(inPeriod).limit(20_000),
    db.query.accounts.findMany({ where: and(eq(accounts.clientId, clientId), isNull(accounts.closedAt)) }),
    db
      .select({
        accountId: transactions.accountId,
        amountCents: transactions.amountCents,
        postedAt: transactions.postedAt,
        reconciledAt: transactions.reconciledAt,
        categoryId: transactions.categoryId,
      })
      .from(transactions)
      .where(and(eq(transactions.clientId, clientId), sql`${transactions.postedAt} <= ${period.periodEnd}`))
      .limit(50_000),
    db.query.documentRequests.findMany({
      where: and(eq(documentRequests.clientId, clientId), eq(documentRequests.status, 'open')),
      limit: 200,
    }),
    db
      .select({ id: clientQuestions.id })
      .from(clientQuestions)
      .where(and(eq(clientQuestions.clientId, clientId), isNull(clientQuestions.answeredAt))),
    db
      .select({ id: anomalies.id })
      .from(anomalies)
      .where(and(eq(anomalies.clientId, clientId), eq(anomalies.status, 'open'))),
  ]);

  const nameById = new Map(accountRows.map((a) => [a.id, a] as const));

  // Unreconciled: an account with uncleared activity inside the period. The
  // variance is what has not been ticked off against a statement.
  const unreconciled = new Map<string, number>();
  for (const t of periodTxns) {
    if (t.reconciledAt) continue;
    unreconciled.set(t.accountId, (unreconciled.get(t.accountId) ?? 0) + t.amountCents);
  }

  // Balances run from the beginning of time to the period end, not just the
  // period — a negative balance is a fact about the account, not the month.
  const balances = new Map<string, number>();
  for (const t of allTxns) {
    balances.set(t.accountId, (balances.get(t.accountId) ?? 0) + t.amountCents);
  }

  const priorSpec = priorPeriodOf(period);
  const [thisPeriodCats, priorPeriodCats] = await Promise.all([
    categoryTotals(clientId, period.periodStart, period.periodEnd),
    categoryTotals(clientId, priorSpec.start, priorSpec.end),
  ]);
  const priorByName = new Map(priorPeriodCats.map((c) => [c.name, c.amountCents] as const));

  return {
    totalTransactions: periodTxns.length,
    uncategorizedCount: periodTxns.filter((t) => t.categoryId === null).length,
    unreconciledAccounts: [...unreconciled.entries()]
      .filter(([, variance]) => variance !== 0)
      .map(([accountId, varianceCents]) => ({
        name: nameById.get(accountId)?.name ?? 'Unknown account',
        varianceCents,
      })),
    negativeBalances: [...balances.entries()]
      .filter(([accountId, cents]) => {
        const account = nameById.get(accountId);
        // A credit card is *supposed* to sit negative. A bank account is not.
        return cents < 0 && account !== undefined && (account.kind === 'bank' || account.kind === 'cash');
      })
      .map(([accountId, balanceCents]) => ({
        name: nameById.get(accountId)?.name ?? 'Unknown account',
        balanceCents,
      })),
    missingDocuments: docReqs.map((d) => ({ label: d.label, amountCents: null })),
    unansweredQuestions: questions.length,
    openAnomalies: openAnoms.length,
    periodSwings: thisPeriodCats
      .filter((c) => priorByName.has(c.name))
      .map((c) => ({
        category: c.name,
        amountCents: c.amountCents,
        priorAmountCents: priorByName.get(c.name) ?? 0,
      })),
  };
}

function priorPeriodOf(period: ClosePeriodRow): { start: string; end: string } {
  const start = new Date(`${period.periodStart}T00:00:00Z`);
  const priorStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
  const priorEnd = new Date(Date.UTC(priorStart.getUTCFullYear(), priorStart.getUTCMonth() + 1, 0));
  return { start: iso(priorStart), end: iso(priorEnd) };
}

async function categoryTotals(
  clientId: string,
  start: string,
  end: string,
): Promise<{ name: string; amountCents: number }[]> {
  const rows = await db
    .select({ name: categories.name, amountCents: transactions.amountCents })
    .from(transactions)
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .where(
      and(
        eq(transactions.clientId, clientId),
        sql`${transactions.postedAt} >= ${start}`,
        sql`${transactions.postedAt} <= ${end}`,
      ),
    )
    .limit(20_000);

  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.name, (totals.get(row.name) ?? 0) + row.amountCents);
  return [...totals.entries()]
    .map(([name, amountCents]) => ({ name, amountCents }))
    .sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents));
}

/* ========================================================================== */
/* Pre-flight                                                                 */
/* ========================================================================== */

export interface PreflightOutcome {
  readonly result: PreflightResult;
  readonly checksWritten: number;
  readonly blockingFailures: number;
  readonly warnings: number;
  readonly readyForReview: boolean;
  readonly confidence: number;
  readonly reasoning: string;
}

/**
 * Run the pre-flight and persist its checks.
 *
 * The suggestion is confirmed by the staff member who pressed the button —
 * they are taking responsibility for running it, which is what the audit trail
 * records. The *verdict* is not theirs to soften: blocking checks come from
 * arithmetic over the facts above, and `advanceToReview` reads them back out
 * of the database.
 *
 * Checks are replaced, not appended: a period has one current pre-flight
 * result. The history lives in `ai_runs` and `audit_log`.
 */
export async function runPreflight(
  clientId: string,
  period: ClosePeriodRow,
  userId: string,
): Promise<PreflightOutcome> {
  const facts = await gatherFacts(clientId, period);

  const suggestion: Suggestion<PreflightResult> = await preflightClose({
    clientId,
    userId,
    closePeriodId: period.id,
    period: periodRef(period),
    facts,
  });

  // A human takes responsibility for the run before anything is written.
  const confirmed: ConfirmedSuggestion<PreflightResult> = suggestion.confirm(userId, {
    acknowledgeLowConfidence: suggestion.needsHuman,
  });
  const checked = requireConfirmed(confirmed, 'runPreflight');
  const result = checked.value;

  await db.delete(closeChecks).where(eq(closeChecks.closePeriodId, period.id));
  if (result.checks.length > 0) {
    await db.insert(closeChecks).values(
      result.checks.map((c) => ({
        closePeriodId: period.id,
        code: c.code.slice(0, 60),
        label: c.label.slice(0, 200),
        severity: c.severity,
        passed: c.passed,
        detail: c.detail.slice(0, 2000),
      })),
    );
  }

  // Status reflects the gate, never the operator's optimism.
  const nextStatus = result.readyForReview ? 'preflight' : 'in_progress';
  if (period.status !== 'in_review' && period.status !== 'delivered') {
    await db.update(closePeriods).set({ status: nextStatus }).where(eq(closePeriods.id, period.id));
  }

  await audit(null, {
    action: 'workspace.close_preflight',
    userId,
    clientId,
    entity: 'close_periods',
    entityId: period.id,
    meta: {
      checks: result.checks.length,
      blockingFailures: result.blockingFailures,
      warnings: result.warnings,
      readyForReview: result.readyForReview,
      confidence: checked.meta.confidence,
      aiRunId: checked.meta.runId,
      provider: checked.meta.provider,
    },
  });

  return {
    result,
    checksWritten: result.checks.length,
    blockingFailures: result.blockingFailures,
    warnings: result.warnings,
    readyForReview: result.readyForReview,
    confidence: checked.meta.confidence,
    reasoning: checked.meta.reasoning,
  };
}

/** Failing blocking checks, read from the database. The gate's source of truth. */
export async function blockingFailuresFor(closePeriodId: string): Promise<readonly CloseCheckRow[]> {
  return db.query.closeChecks.findMany({
    where: and(
      eq(closeChecks.closePeriodId, closePeriodId),
      eq(closeChecks.passed, false),
      eq(closeChecks.severity, 'block'),
    ),
    orderBy: [asc(closeChecks.code)],
  });
}

export interface AdvanceResult {
  readonly advanced: boolean;
  readonly reason: string;
  readonly blockers: readonly CloseCheckRow[];
}

/**
 * Move a period to `in_review`. Refuses while any blocking check is failing,
 * and refuses outright if the pre-flight has never been run — "no checks" is
 * not the same as "no failures".
 */
export async function advanceToReview(
  period: ClosePeriodRow,
  userId: string,
): Promise<AdvanceResult> {
  const all = await db.query.closeChecks.findMany({
    where: eq(closeChecks.closePeriodId, period.id),
  });
  if (all.length === 0) {
    return {
      advanced: false,
      reason: 'Run the pre-flight first — nothing reaches a reviewer unchecked.',
      blockers: [],
    };
  }

  const blockers = all.filter((c) => !c.passed && c.severity === 'block');
  if (blockers.length > 0) {
    return {
      advanced: false,
      reason: `${blockers.length} blocking check${blockers.length === 1 ? '' : 's'} still failing: ${blockers
        .map((b) => b.label)
        .join(', ')}.`,
      blockers,
    };
  }

  await db
    .update(closePeriods)
    .set({ status: 'in_review', reviewerId: userId })
    .where(eq(closePeriods.id, period.id));

  await audit(null, {
    action: 'workspace.close_to_review',
    userId,
    clientId: period.clientId,
    entity: 'close_periods',
    entityId: period.id,
    meta: { checks: all.length },
  });

  return { advanced: true, reason: 'Pre-flight clean — moved to review.', blockers: [] };
}

/* ========================================================================== */
/* Narrative                                                                  */
/* ========================================================================== */

export interface NarrativeOutcome {
  readonly draft: NarrativeDraft;
  readonly confidence: number;
  readonly reasoning: string;
  readonly stored: boolean;
}

/**
 * Draft the plain-English close summary and store it **as a draft**.
 *
 * `draftNarrative` is `alwaysNeedsHuman`, so confirming it requires an explicit
 * `acknowledgeLowConfidence` — that flag is exactly the point: storing a draft
 * is a deliberate, attributed act, and it is still not an approval.
 * `narrative_approved_by` stays null until {@link approveNarrative} runs.
 */
export async function draftCloseNarrative(
  clientId: string,
  period: ClosePeriodRow,
  userId: string,
): Promise<NarrativeOutcome> {
  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client) throw new Error('draftCloseNarrative: unknown client.');

  const figures = await narrativeFigures(clientId, period);
  const prior = priorPeriodOf(period);
  const [thisCats, priorCats] = await Promise.all([
    categoryTotals(clientId, period.periodStart, period.periodEnd),
    categoryTotals(clientId, prior.start, prior.end),
  ]);
  const priorByName = new Map(priorCats.map((c) => [c.name, c.amountCents] as const));
  const topCategories: CategoryMovement[] = thisCats.slice(0, 6).map((c) => ({
    name: c.name,
    amountCents: c.amountCents,
    priorAmountCents: priorByName.get(c.name) ?? null,
  }));

  const facts = await gatherFacts(clientId, period);
  const watchItems: string[] = [];
  if (facts.uncategorizedCount > 0) {
    watchItems.push(`${facts.uncategorizedCount} transactions still uncategorised`);
  }
  if (facts.openAnomalies > 0) watchItems.push(`${facts.openAnomalies} flagged items open`);
  if (facts.missingDocuments.length > 0) {
    watchItems.push(`${facts.missingDocuments.length} documents outstanding`);
  }

  const suggestion = await draftNarrative({
    clientId,
    userId,
    businessName: client.businessName,
    period: periodRef(period),
    figures,
    topCategories,
    watchItems,
    closePeriodId: period.id,
  });

  // Always needsHuman by construction — the acknowledgement is the record that
  // a named person chose to keep this draft.
  const confirmed = suggestion.confirm(userId, { acknowledgeLowConfidence: true });
  const checked = requireConfirmed(confirmed, 'draftCloseNarrative');
  const draft = checked.value;

  let stored = false;
  if (!draft.suppressed && draft.narrative) {
    await db
      .update(closePeriods)
      .set({ narrative: draft.narrative, narrativeApprovedBy: null, narrativeApprovedAt: null })
      .where(eq(closePeriods.id, period.id));
    stored = true;
  }

  await audit(null, {
    action: 'workspace.close_narrative_draft',
    userId,
    clientId,
    entity: 'close_periods',
    entityId: period.id,
    meta: {
      stored,
      suppressed: draft.suppressed,
      suppressionReason: draft.suppressionReason,
      confidence: checked.meta.confidence,
      aiRunId: checked.meta.runId,
      provider: checked.meta.provider,
    },
  });

  return { draft, confidence: checked.meta.confidence, reasoning: checked.meta.reasoning, stored };
}

/** A named human approves. Nothing is sent here — approval is not delivery. */
export async function approveNarrative(period: ClosePeriodRow, userId: string): Promise<boolean> {
  if (!period.narrative) return false;
  await db
    .update(closePeriods)
    .set({ narrativeApprovedBy: userId, narrativeApprovedAt: new Date() })
    .where(eq(closePeriods.id, period.id));
  await audit(null, {
    action: 'workspace.close_narrative_approve',
    userId,
    clientId: period.clientId,
    entity: 'close_periods',
    entityId: period.id,
    meta: { chars: period.narrative.length },
  });
  return true;
}

async function narrativeFigures(clientId: string, period: ClosePeriodRow) {
  const prior = priorPeriodOf(period);
  const [current, previous, cash] = await Promise.all([
    periodTotals(clientId, period.periodStart, period.periodEnd),
    periodTotals(clientId, prior.start, prior.end),
    cashOnHand(clientId, period.periodEnd),
  ]);
  return {
    revenueCents: current.revenueCents,
    priorRevenueCents: previous.revenueCents,
    expensesCents: current.expensesCents,
    priorExpensesCents: previous.expensesCents,
    netCents: current.revenueCents - current.expensesCents,
    priorNetCents: previous.revenueCents - previous.expensesCents,
    cashOnHandCents: cash,
    receivablesCents: null,
    payablesCents: null,
  };
}

async function periodTotals(
  clientId: string,
  start: string,
  end: string,
): Promise<{ revenueCents: number; expensesCents: number }> {
  const rows = await db
    .select({ amountCents: transactions.amountCents })
    .from(transactions)
    .where(
      and(
        eq(transactions.clientId, clientId),
        sql`${transactions.postedAt} >= ${start}`,
        sql`${transactions.postedAt} <= ${end}`,
      ),
    )
    .limit(50_000);

  let revenueCents = 0;
  let expensesCents = 0;
  for (const r of rows) {
    if (r.amountCents >= 0) revenueCents += r.amountCents;
    else expensesCents += Math.abs(r.amountCents);
  }
  return { revenueCents, expensesCents };
}

async function cashOnHand(clientId: string, asOf: string): Promise<number | null> {
  const rows = await db
    .select({ amountCents: transactions.amountCents, kind: accounts.kind })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(and(eq(transactions.clientId, clientId), sql`${transactions.postedAt} <= ${asOf}`))
    .limit(50_000);
  if (rows.length === 0) return null;
  return rows
    .filter((r) => r.kind === 'bank' || r.kind === 'cash')
    .reduce((n, r) => n + r.amountCents, 0);
}

/* ========================================================================== */
/* The screen                                                                 */
/* ========================================================================== */

export async function buildCloseView(clientId: string): Promise<CloseView | null> {
  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client) return null;

  const period = await latestPeriod(clientId);
  const [checks, history] = await Promise.all([
    period
      ? db.query.closeChecks.findMany({
          where: eq(closeChecks.closePeriodId, period.id),
          orderBy: [asc(closeChecks.severity), asc(closeChecks.code)],
        })
      : Promise.resolve([] as CloseCheckRow[]),
    db.query.closePeriods.findMany({
      where: eq(closePeriods.clientId, clientId),
      orderBy: [desc(closePeriods.periodStart)],
      limit: 6,
    }),
  ]);

  const blockingFailures = checks.filter((c) => !c.passed && c.severity === 'block').length;
  const warnings = checks.filter((c) => !c.passed && c.severity === 'warn').length;
  const lastCheckedAt = checks.reduce<Date | null>(
    (latest, c) => (latest === null || c.checkedAt > latest ? c.checkedAt : latest),
    null,
  );

  return {
    client,
    period,
    checks,
    blockingFailures,
    warnings,
    readyForReview: checks.length > 0 && blockingFailures === 0,
    lastCheckedAt,
    facts: period ? await gatherFacts(clientId, period) : null,
    history,
  };
}
