/**
 * The bookkeeper workspace — queue building and the priority formula.
 *
 * STAFF-WORKSPACE.md §1: *"Most firms organize work as a folder per client.
 * That's a filing system, not an operating model — the bookkeeper decides what
 * to do next, and decides badly, because they can't see across the book."*
 *
 * This module is the answer to "what do I work on now?". Everything above the
 * `/* ---- database ---- *\/` divider is **pure** — no imports from `db/`, no
 * clock of its own (every function takes `now`), no I/O. That is deliberate:
 * the ranking is the product decision that matters most, so it has to be
 * readable and testable without a database.
 *
 * ============================================================================
 * THE PRIORITY FORMULA
 * ============================================================================
 *
 * ```
 *   priority = clamp(0, 100,
 *       slaScore      (0-40)   how close — or how late — this item is to its own due date
 *     + closeScore    (0-20)   this client's open close period against its contractual target
 *     + blockedScore  (0-15)   blocked work stalls everything queued behind it
 *     + ageScore      (0-10)   how long it has already sat in the queue
 *     + volumeScore   (0-10)   log-scaled item count: one decision, 47 outcomes
 *     + kindScore     (0-5)    tie-break by work type
 *   )
 * ```
 *
 * Why these weights:
 *
 * - **SLA risk dominates (40).** A missed close date is the only failure the
 *   client actually experiences. Nothing else outranks it.
 * - **Close risk is a second, separate axis (20).** An item can be individually
 *   un-urgent and still sit on the critical path of a close due in two days.
 *   Folding it into the SLA term would hide that; keeping it separate means the
 *   queue reorders itself as the 10th approaches without anyone touching a due
 *   date.
 * - **Blocked ranks high but below SLA (15).** Blocked items are cheap to
 *   action (one message unblocks them) and expensive to leave (everything
 *   behind them waits) — but a blocked item on a delivered close is not urgent.
 * - **Age is small and capped (10).** Enough to stop anything starving
 *   permanently; not enough to let stale low-value work outrank a live close.
 * - **Volume is logarithmic, not linear (10).** 47 transactions from Shell is
 *   worth more attention than 5 — but not 9× more, because it is still *one
 *   decision*. Linear volume would let a bulk import bury everything else.
 * - **Kind is a tie-break only (5).** It never reorders across risk bands.
 *
 * Ties break by due date (soonest first), then by age (oldest first), so the
 * order is total and stable — the same queue renders identically on a refresh.
 */

import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  anomalies,
  auditLog,
  clientQuestions,
  clients,
  closeChecks,
  closePeriods,
  documentRequests,
  invoices,
  messages,
  threads,
  timeEntries,
  transactions,
  users,
  workItems,
} from '../db/schema.js';

/* ========================================================================== */
/* Types                                                                      */
/* ========================================================================== */

export type WorkKind = 'categorize' | 'reconcile' | 'answer' | 'review' | 'chase' | 'quarantine' | 'close';
export type WorkStatus = 'open' | 'snoozed' | 'blocked' | 'done';
export type ClosePeriodStatus = 'not_started' | 'in_progress' | 'preflight' | 'in_review' | 'delivered';

export const WORK_KINDS: readonly WorkKind[] = [
  'categorize',
  'reconcile',
  'answer',
  'review',
  'chase',
  'quarantine',
  'close',
];

/** The minimum a work item must expose to be ranked. Deliberately not a row. */
export interface QueueItemInput {
  readonly id: string;
  readonly kind: WorkKind;
  readonly status: WorkStatus;
  readonly dueAt: Date | null;
  readonly createdAt: Date;
  readonly itemCount: number;
  /** The client's open close period, if any — the second risk axis. */
  readonly closeTargetDate: string | null;
  readonly closeStatus: ClosePeriodStatus | null;
}

export interface PriorityBreakdown {
  readonly priority: number;
  readonly sla: number;
  readonly close: number;
  readonly blocked: number;
  readonly age: number;
  readonly volume: number;
  readonly kind: number;
  /** Whole days until `dueAt`; negative when overdue, null when undated. */
  readonly daysToDue: number | null;
  /** One of: overdue | today | soon | scheduled | undated. */
  readonly slaBand: SlaBand;
  readonly slaLabel: string;
}

export type SlaBand = 'overdue' | 'today' | 'soon' | 'scheduled' | 'undated';

const MS_PER_DAY = 86_400_000;

/* ========================================================================== */
/* Pure scoring                                                               */
/* ========================================================================== */

/** Whole days from `now` to `when`. Negative = in the past. */
export function daysUntil(when: Date | string | null, now: Date): number | null {
  if (!when) return null;
  const target = typeof when === 'string' ? Date.parse(`${when}T23:59:59Z`) : when.getTime();
  if (!Number.isFinite(target)) return null;
  return Math.floor((target - now.getTime()) / MS_PER_DAY);
}

/** 0-40. The dominant term: an item's own contractual due date. */
export function slaScore(dueAt: Date | null, now: Date): { score: number; band: SlaBand; days: number | null } {
  const days = daysUntil(dueAt, now);
  if (days === null) return { score: 4, band: 'undated', days: null };
  if (days < 0) return { score: 40, band: 'overdue', days };
  if (days < 1) return { score: 36, band: 'today', days };
  if (days < 2) return { score: 30, band: 'soon', days };
  if (days < 4) return { score: 22, band: 'soon', days };
  if (days < 8) return { score: 12, band: 'scheduled', days };
  return { score: 4, band: 'scheduled', days };
}

/** 0-20. The client's close period against its target date. */
export function closeScore(
  targetDate: string | null,
  status: ClosePeriodStatus | null,
  now: Date,
): { score: number; days: number | null } {
  if (!targetDate || status === null || status === 'delivered') return { score: 0, days: null };
  const days = daysUntil(targetDate, now);
  if (days === null) return { score: 0, days: null };
  if (days < 0) return { score: 20, days };
  if (days <= 1) return { score: 17, days };
  if (days <= 3) return { score: 12, days };
  if (days <= 7) return { score: 6, days };
  return { score: 2, days };
}

/** 0-15. Blocked work stalls everything behind it. */
export function blockedScore(status: WorkStatus): number {
  return status === 'blocked' ? 15 : 0;
}

/** 0-10, capped. Stops anything starving without letting stale work win. */
export function ageScore(createdAt: Date, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - createdAt.getTime()) / MS_PER_DAY);
  return Math.min(10, Math.round(ageDays * 0.7));
}

/**
 * 0-10, logarithmic. "47 transactions from Shell" is one decision with 47
 * outcomes — worth more than a single item, but nowhere near 47× more.
 */
export function volumeScore(itemCount: number): number {
  const n = Math.max(1, Math.floor(itemCount));
  return Math.min(10, Math.round(Math.log10(n + 1) * 6));
}

/** 0-5. Tie-break only; never reorders across risk bands. */
export function kindScore(kind: WorkKind): number {
  switch (kind) {
    case 'close':
      return 5;
    case 'reconcile':
      return 4;
    case 'quarantine':
      return 4;
    case 'categorize':
      return 3;
    case 'answer':
      return 3;
    case 'review':
      return 2;
    case 'chase':
      return 1;
  }
}

function slaLabelFor(band: SlaBand, days: number | null): string {
  if (band === 'undated') return 'no due date';
  if (days === null) return 'no due date';
  if (days < -1) return `${Math.abs(days)} days overdue`;
  if (days < 0) return '1 day overdue';
  if (days < 1) return 'due today';
  if (days < 2) return 'due tomorrow';
  return `due in ${days} days`;
}

/** The whole formula in one call. Deterministic given `now`. */
export function computePriority(item: QueueItemInput, now: Date): PriorityBreakdown {
  const sla = slaScore(item.dueAt, now);
  const close = closeScore(item.closeTargetDate, item.closeStatus, now);
  const blocked = blockedScore(item.status);
  const age = ageScore(item.createdAt, now);
  const volume = volumeScore(item.itemCount);
  const kind = kindScore(item.kind);
  const priority = Math.max(0, Math.min(100, sla.score + close.score + blocked + age + volume + kind));

  return {
    priority,
    sla: sla.score,
    close: close.score,
    blocked,
    age,
    volume,
    kind,
    daysToDue: sla.days,
    slaBand: sla.band,
    slaLabel: slaLabelFor(sla.band, sla.days),
  };
}

/**
 * Rank a queue. Priority desc, then soonest due (undated last), then oldest
 * first — a total order, so the same set always renders in the same sequence.
 */
export function rankQueue<T extends QueueItemInput>(
  items: readonly T[],
  now: Date,
): readonly (T & { score: PriorityBreakdown })[] {
  return items
    .map((item) => ({ ...item, score: computePriority(item, now) }))
    .sort((a, b) => {
      if (b.score.priority !== a.score.priority) return b.score.priority - a.score.priority;
      const ad = a.dueAt ? a.dueAt.getTime() : Number.POSITIVE_INFINITY;
      const bd = b.dueAt ? b.dueAt.getTime() : Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad - bd;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
}

/* -------------------------------------------------------------------------- */
/* Close risk — "N clients at risk of missing the 10th"                        */
/* -------------------------------------------------------------------------- */

export type CloseRiskLevel = 'missed' | 'critical' | 'warning' | 'ok';

export interface CloseRiskVerdict {
  readonly level: CloseRiskLevel;
  readonly atRisk: boolean;
  readonly daysToTarget: number | null;
  readonly reason: string;
}

/**
 * Is this close period at risk of missing its contractual target date?
 *
 * Derived from `close_periods.target_date` against `close_periods.status` —
 * never from a flag somebody has to remember to set.
 */
export function closeRisk(
  period: { targetDate: string | null; status: ClosePeriodStatus },
  now: Date,
): CloseRiskVerdict {
  if (period.status === 'delivered') {
    return { level: 'ok', atRisk: false, daysToTarget: null, reason: 'Delivered.' };
  }
  const days = daysUntil(period.targetDate, now);
  if (days === null) {
    return { level: 'ok', atRisk: false, daysToTarget: null, reason: 'No target date on this period.' };
  }
  if (days < 0) {
    return {
      level: 'missed',
      atRisk: true,
      daysToTarget: days,
      reason: `Target passed ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago and the close is ${readable(period.status)}.`,
    };
  }
  if (days <= 3) {
    return {
      level: 'critical',
      atRisk: true,
      daysToTarget: days,
      reason: `${days === 0 ? 'Due today' : `${days} day${days === 1 ? '' : 's'} to target`} and the close is ${readable(period.status)}.`,
    };
  }
  if (days <= 7 && (period.status === 'not_started' || period.status === 'in_progress')) {
    return {
      level: 'warning',
      atRisk: true,
      daysToTarget: days,
      reason: `${days} days to target and the close is still ${readable(period.status)}.`,
    };
  }
  return { level: 'ok', atRisk: false, daysToTarget: days, reason: `${days} days to target, on track.` };
}

function readable(status: ClosePeriodStatus): string {
  return status.replace(/_/g, ' ');
}

/* -------------------------------------------------------------------------- */
/* Capacity — effort vs fee, and who is trending above similar engagements     */
/* -------------------------------------------------------------------------- */

export interface CapacityInput {
  readonly clientId: string;
  readonly businessName: string;
  readonly minutes: number;
  readonly invoicedCents: number;
  readonly openItems: number;
}

export interface CapacityRow extends CapacityInput {
  /** Minutes of effort per $100 invoiced. null when nothing is invoiced yet. */
  readonly minutesPer100: number | null;
  /** How this client compares to the median engagement. 1 = at the median. */
  readonly ratioToMedian: number | null;
  readonly flagged: boolean;
  readonly note: string;
}

/** Above this multiple of the median effort ratio, a client gets flagged. */
export const CAPACITY_FLAG_RATIO = 1.75;

/**
 * "This client is trending 2× the effort of similar engagements."
 * (STAFF-WORKSPACE.md §9.) Median rather than mean, so one pathological
 * cleanup engagement does not move the bar for everybody else.
 */
export function analyseCapacity(rows: readonly CapacityInput[]): readonly CapacityRow[] {
  const ratios = rows
    .filter((r) => r.invoicedCents > 0)
    .map((r) => (r.minutes / r.invoicedCents) * 10_000);
  const sorted = [...ratios].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length === 0
      ? null
      : sorted.length % 2 === 1
        ? (sorted[mid] ?? null)
        : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;

  return rows
    .map((r) => {
      const minutesPer100 = r.invoicedCents > 0 ? (r.minutes / r.invoicedCents) * 10_000 : null;
      const ratioToMedian = minutesPer100 !== null && median ? minutesPer100 / median : null;
      const flagged = ratioToMedian !== null && ratioToMedian >= CAPACITY_FLAG_RATIO;
      const note =
        minutesPer100 === null
          ? 'Nothing invoiced yet — no fee to measure effort against.'
          : ratioToMedian === null
            ? 'Not enough comparable engagements to rank against.'
            : flagged
              ? `Trending ${ratioToMedian.toFixed(1)}× the effort of the median engagement. Worth a scope conversation.`
              : `${ratioToMedian.toFixed(1)}× the median engagement.`;
      return { ...r, minutesPer100, ratioToMedian, flagged, note };
    })
    .sort((a, b) => (b.ratioToMedian ?? -1) - (a.ratioToMedian ?? -1));
}

/* ========================================================================== */
/* ---- database ---- everything below reads Postgres                          */
/* ========================================================================== */

export interface QueueFilters {
  readonly kind?: WorkKind | null;
  readonly clientId?: string | null;
  /** 'me' = assigned to this user; 'unassigned' = nobody owns it yet. */
  readonly assigned?: 'me' | 'unassigned' | null;
  readonly userId: string;
}

export interface QueueRow extends QueueItemInput {
  readonly clientId: string;
  readonly clientName: string;
  readonly title: string;
  readonly detail: string | null;
  readonly assignedTo: string | null;
  readonly assigneeName: string | null;
  readonly relatedEntity: string | null;
  readonly relatedId: string | null;
  readonly score: PriorityBreakdown;
  /** Where `enter` takes you from the queue. */
  readonly href: string;
}

export interface CloseRiskRow {
  readonly clientId: string;
  readonly clientName: string;
  readonly closePeriodId: string;
  readonly periodStart: string;
  readonly targetDate: string | null;
  readonly status: ClosePeriodStatus;
  readonly verdict: CloseRiskVerdict;
}

/** Open close periods, one per client, newest period first. */
async function openClosePeriods(): Promise<Map<string, typeof closePeriods.$inferSelect>> {
  const rows = await db.query.closePeriods.findMany({
    where: ne(closePeriods.status, 'delivered'),
    orderBy: [desc(closePeriods.periodStart)],
  });
  const byClient = new Map<string, typeof closePeriods.$inferSelect>();
  for (const row of rows) {
    if (!byClient.has(row.clientId)) byClient.set(row.clientId, row);
  }
  return byClient;
}

/**
 * The cross-client queue: every open (or blocked) work item across every
 * client, ranked by {@link computePriority}. One flat list — client is a
 * grouping label on the row, never a folder you have to open.
 */
export async function buildQueue(filters: QueueFilters, now = new Date()): Promise<readonly QueueRow[]> {
  const conditions = [
    // Snoozed items come back on their own; done items are gone.
    or(eq(workItems.status, 'open'), eq(workItems.status, 'blocked')),
  ];
  if (filters.kind) conditions.push(eq(workItems.kind, filters.kind));
  if (filters.clientId) conditions.push(eq(workItems.clientId, filters.clientId));
  if (filters.assigned === 'me') conditions.push(eq(workItems.assignedTo, filters.userId));
  if (filters.assigned === 'unassigned') conditions.push(isNull(workItems.assignedTo));

  const rows = await db
    .select({
      item: workItems,
      clientName: clients.businessName,
      assigneeName: users.name,
    })
    .from(workItems)
    .innerJoin(clients, eq(clients.id, workItems.clientId))
    .leftJoin(users, eq(users.id, workItems.assignedTo))
    .where(and(...conditions))
    .orderBy(desc(workItems.priority))
    .limit(500);

  const periods = await openClosePeriods();

  const inputs = rows.map(({ item, clientName, assigneeName }) => {
    const period = periods.get(item.clientId) ?? null;
    return {
      id: item.id,
      kind: item.kind,
      status: item.status,
      dueAt: item.dueAt,
      createdAt: item.createdAt,
      itemCount: item.itemCount,
      closeTargetDate: period?.targetDate ?? null,
      closeStatus: period?.status ?? null,
      clientId: item.clientId,
      clientName,
      title: item.title,
      detail: item.detail,
      assignedTo: item.assignedTo,
      assigneeName,
      relatedEntity: item.relatedEntity,
      relatedId: item.relatedId,
      href: hrefFor(item),
    };
  });

  return rankQueue(inputs, now) as readonly QueueRow[];
}

/** Where `enter` on a queue row lands. Work items, not folders. */
function hrefFor(item: typeof workItems.$inferSelect): string {
  switch (item.kind) {
    case 'categorize':
      return `/workspace/categorize/${item.clientId}`;
    case 'close':
    case 'review':
      return `/workspace/close/${item.clientId}`;
    // Quarantine now has a staff HTML page of its own.
    case 'quarantine':
      return '/admin/quarantine';
    case 'answer':
    case 'chase':
    case 'reconcile':
    default:
      return `/workspace/client/${item.clientId}`;
  }
}

/** The top strip: which clients are about to miss their close target. */
export async function closeRiskStrip(now = new Date()): Promise<readonly CloseRiskRow[]> {
  const rows = await db
    .select({ period: closePeriods, clientName: clients.businessName })
    .from(closePeriods)
    .innerJoin(clients, eq(clients.id, closePeriods.clientId))
    .where(ne(closePeriods.status, 'delivered'))
    .orderBy(asc(closePeriods.targetDate));

  return rows
    .map(({ period, clientName }) => ({
      clientId: period.clientId,
      clientName,
      closePeriodId: period.id,
      periodStart: period.periodStart,
      targetDate: period.targetDate,
      status: period.status,
      verdict: closeRisk(period, now),
    }))
    .filter((r) => r.verdict.atRisk);
}

/** Counts for the filter chips, so a filter never leads to a dead end. */
export async function queueFacets(userId: string): Promise<{
  byKind: Record<string, number>;
  mine: number;
  unassigned: number;
  total: number;
}> {
  const rows = await db
    .select({ kind: workItems.kind, assignedTo: workItems.assignedTo })
    .from(workItems)
    .where(or(eq(workItems.status, 'open'), eq(workItems.status, 'blocked')));

  const byKind: Record<string, number> = {};
  let mine = 0;
  let unassigned = 0;
  for (const row of rows) {
    byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    if (row.assignedTo === userId) mine += 1;
    if (row.assignedTo === null) unassigned += 1;
  }
  return { byKind, mine, unassigned, total: rows.length };
}

/* -------------------------------------------------------------------------- */
/* Client context brief (§3) — thirty seconds instead of ten minutes           */
/* -------------------------------------------------------------------------- */

export const BRIEF_VIEW_ACTION = 'workspace.brief_view';

export interface ClientBrief {
  readonly client: typeof clients.$inferSelect;
  /** When this staff member last opened this brief. Null on a first visit. */
  readonly lastViewedAt: Date | null;
  readonly changes: readonly { at: Date; what: string; detail: string | null }[];
  readonly openQuestions: readonly (typeof clientQuestions.$inferSelect)[];
  readonly openAnomalies: readonly (typeof anomalies.$inferSelect)[];
  readonly blockers: readonly { label: string; severity: string; detail: string | null }[];
  readonly closePeriod: typeof closePeriods.$inferSelect | null;
  readonly closeVerdict: CloseRiskVerdict | null;
  readonly conversation: {
    readonly threadId: string | null;
    readonly subject: string | null;
    readonly summary: string;
    readonly lastAt: Date | null;
  };
  readonly uncategorizedCount: number;
  readonly openDocRequests: readonly (typeof documentRequests.$inferSelect)[];
  readonly minutesLast30: number;
  readonly openWorkItems: readonly (typeof workItems.$inferSelect)[];
}

/**
 * Everything a bookkeeper would otherwise reconstruct from memory and email.
 *
 * "Since you last looked" is real, not a guess: each brief view writes an
 * `audit_log` row, and the *previous* one for this user + client is the
 * watermark. Work item, question, anomaly and time-entry activity after that
 * watermark is what changed.
 */
export async function clientBrief(
  clientId: string,
  userId: string,
  now = new Date(),
): Promise<ClientBrief | null> {
  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client) return null;

  const previousView = await db.query.auditLog.findFirst({
    where: and(
      eq(auditLog.action, BRIEF_VIEW_ACTION),
      eq(auditLog.userId, userId),
      eq(auditLog.clientId, clientId),
    ),
    orderBy: [desc(auditLog.id)],
  });
  const lastViewedAt = previousView?.at ?? null;
  const since = lastViewedAt ?? new Date(now.getTime() - 14 * MS_PER_DAY);

  const [questions, openAnoms, period, itemRows, threadRows, uncatRows, docReqs, timeRows] =
    await Promise.all([
      db.query.clientQuestions.findMany({
        where: and(eq(clientQuestions.clientId, clientId), isNull(clientQuestions.answeredAt)),
        orderBy: [desc(clientQuestions.createdAt)],
        limit: 25,
      }),
      db.query.anomalies.findMany({
        where: and(eq(anomalies.clientId, clientId), eq(anomalies.status, 'open')),
        orderBy: [desc(anomalies.createdAt)],
        limit: 25,
      }),
      db.query.closePeriods.findMany({
        where: eq(closePeriods.clientId, clientId),
        orderBy: [desc(closePeriods.periodStart)],
        limit: 1,
      }),
      db.query.workItems.findMany({
        where: and(
          eq(workItems.clientId, clientId),
          or(eq(workItems.status, 'open'), eq(workItems.status, 'blocked')),
        ),
        orderBy: [desc(workItems.priority)],
        limit: 50,
      }),
      db
        .select({ thread: threads, message: messages })
        .from(threads)
        .leftJoin(messages, eq(messages.threadId, threads.id))
        .where(eq(threads.clientId, clientId))
        .orderBy(desc(messages.createdAt))
        .limit(12),
      db
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.clientId, clientId), isNull(transactions.categoryId)))
        .limit(1000),
      db.query.documentRequests.findMany({
        where: and(eq(documentRequests.clientId, clientId), eq(documentRequests.status, 'open')),
        orderBy: [desc(documentRequests.createdAt)],
        limit: 25,
      }),
      db.query.timeEntries.findMany({
        where: eq(timeEntries.clientId, clientId),
        orderBy: [desc(timeEntries.occurredOn)],
        limit: 400,
      }),
    ]);

  const closePeriod = period[0] ?? null;
  const closeVerdict = closePeriod ? closeRisk(closePeriod, now) : null;

  // What blocks the close, specifically — the failing checks from the last
  // pre-flight, not a general feeling that things are messy.
  const blockers: { label: string; severity: string; detail: string | null }[] = [];
  if (closePeriod) {
    const checks = await db.query.closeChecks.findMany({
      where: and(eq(closeChecks.closePeriodId, closePeriod.id), eq(closeChecks.passed, false)),
      orderBy: [desc(closeChecks.checkedAt)],
    });
    const seen = new Set<string>();
    for (const check of checks) {
      if (seen.has(check.code)) continue;
      seen.add(check.code);
      blockers.push({ label: check.label, severity: check.severity, detail: check.detail });
    }
    blockers.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  }

  // "What changed since you last looked."
  const changes: { at: Date; what: string; detail: string | null }[] = [];
  for (const item of itemRows) {
    if (item.createdAt > since) {
      changes.push({
        at: item.createdAt,
        what: `New ${item.kind} work item`,
        detail: item.title,
      });
    }
  }
  for (const q of questions) {
    if (q.createdAt > since) changes.push({ at: q.createdAt, what: 'Question raised', detail: q.question });
  }
  for (const a of openAnoms) {
    if (a.createdAt > since) changes.push({ at: a.createdAt, what: `Anomaly: ${a.kind}`, detail: a.summary });
  }
  for (const t of timeRows) {
    if (t.createdAt > since) {
      changes.push({ at: t.createdAt, what: `${t.minutes} min logged`, detail: t.note });
    }
  }
  changes.sort((a, b) => b.at.getTime() - a.at.getTime());

  const withMessage = threadRows.filter((r) => r.message !== null);
  const latest = withMessage[0];
  const conversation = {
    threadId: latest?.thread.id ?? null,
    subject: latest?.thread.subject ?? null,
    lastAt: latest?.message?.createdAt ?? null,
    summary: summariseConversation(
      withMessage.map((r) => ({ body: r.message!.body, at: r.message!.createdAt })),
    ),
  };

  const cutoff = new Date(now.getTime() - 30 * MS_PER_DAY).toISOString().slice(0, 10);
  const minutesLast30 = timeRows
    .filter((t) => t.occurredOn >= cutoff)
    .reduce((n, t) => n + t.minutes, 0);

  return {
    client,
    lastViewedAt,
    changes: changes.slice(0, 25),
    openQuestions: questions,
    openAnomalies: openAnoms,
    blockers,
    closePeriod,
    closeVerdict,
    conversation,
    uncategorizedCount: uncatRows.length,
    openDocRequests: docReqs,
    minutesLast30,
    openWorkItems: itemRows,
  };
}

function severityRank(s: string): number {
  return s === 'block' ? 3 : s === 'warn' ? 2 : 1;
}

/**
 * A deterministic extractive summary of the last few messages. No model call:
 * a brief that costs a provider round-trip every time it is opened is a brief
 * nobody opens.
 */
export function summariseConversation(
  msgs: readonly { body: string; at: Date }[],
  maxChars = 320,
): string {
  if (msgs.length === 0) return 'No messages on file.';
  const recent = msgs.slice(0, 3);
  const parts = recent.map((m) => {
    const firstSentence = m.body.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] ?? '';
    return firstSentence.length > 140 ? `${firstSentence.slice(0, 137)}…` : firstSentence;
  });
  const joined = parts.filter(Boolean).join(' · ');
  const summary = joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined;
  return summary || 'No readable message content.';
}

/** Record that this staff member looked, so the next brief can say what changed. */
export async function recordBriefView(clientId: string, userId: string, ip: string | null): Promise<void> {
  await db.insert(auditLog).values({
    action: BRIEF_VIEW_ACTION,
    userId,
    clientId,
    entity: 'client',
    entityId: clientId,
    ip,
  });
}

/* -------------------------------------------------------------------------- */
/* Capacity (§9)                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Effort against fee, per client. Most small firms genuinely do not know who
 * they are losing money on (STAFF-WORKSPACE.md §9).
 */
export async function capacityReport(sinceDays = 90, now = new Date()): Promise<readonly CapacityRow[]> {
  const since = new Date(now.getTime() - sinceDays * MS_PER_DAY).toISOString().slice(0, 10);

  const [clientRows, entries, invoiceRows, openItems] = await Promise.all([
    db.query.clients.findMany({ orderBy: [asc(clients.businessName)] }),
    db
      .select({ clientId: timeEntries.clientId, minutes: timeEntries.minutes })
      .from(timeEntries)
      .where(sql`${timeEntries.occurredOn} >= ${since}`),
    db
      .select({
        clientId: invoices.clientId,
        amountPaidCents: invoices.amountPaidCents,
        amountDueCents: invoices.amountDueCents,
        issuedAt: invoices.issuedAt,
      })
      .from(invoices),
    db
      .select({ clientId: workItems.clientId })
      .from(workItems)
      .where(or(eq(workItems.status, 'open'), eq(workItems.status, 'blocked'))),
  ]);

  const minutesBy = new Map<string, number>();
  for (const e of entries) minutesBy.set(e.clientId, (minutesBy.get(e.clientId) ?? 0) + e.minutes);

  const sinceDate = new Date(now.getTime() - sinceDays * MS_PER_DAY);
  const feeBy = new Map<string, number>();
  for (const inv of invoiceRows) {
    if (inv.issuedAt && inv.issuedAt < sinceDate) continue;
    // Invoiced value, not collected value: effort is measured against what the
    // engagement is worth, not against how fast the client pays.
    feeBy.set(inv.clientId, (feeBy.get(inv.clientId) ?? 0) + Math.max(inv.amountDueCents, inv.amountPaidCents));
  }

  const openBy = new Map<string, number>();
  for (const w of openItems) openBy.set(w.clientId, (openBy.get(w.clientId) ?? 0) + 1);

  return analyseCapacity(
    clientRows.map((c) => ({
      clientId: c.id,
      businessName: c.businessName,
      minutes: minutesBy.get(c.id) ?? 0,
      invoicedCents: feeBy.get(c.id) ?? 0,
      openItems: openBy.get(c.id) ?? 0,
    })),
  );
}

/* -------------------------------------------------------------------------- */
/* Queue mutations                                                             */
/* -------------------------------------------------------------------------- */

/** Take ownership. Returns the row so the caller can audit it truthfully. */
export async function assignToMe(
  workItemId: string,
  userId: string,
): Promise<typeof workItems.$inferSelect | null> {
  const [row] = await db
    .update(workItems)
    .set({ assignedTo: userId })
    .where(eq(workItems.id, workItemId))
    .returning();
  return row ?? null;
}

/** Snooze: out of the queue until `until`, then back in with its age intact. */
export async function snooze(
  workItemId: string,
  until: Date,
): Promise<typeof workItems.$inferSelect | null> {
  const [row] = await db
    .update(workItems)
    .set({ status: 'snoozed', snoozedUntil: until })
    .where(eq(workItems.id, workItemId))
    .returning();
  return row ?? null;
}

/** Bring back anything whose snooze has expired. Cheap; safe to call often. */
export async function wakeSnoozed(now = new Date()): Promise<number> {
  const rows = await db
    .update(workItems)
    .set({ status: 'open', snoozedUntil: null })
    .where(and(eq(workItems.status, 'snoozed'), sql`${workItems.snoozedUntil} <= ${now}`))
    .returning({ id: workItems.id });
  return rows.length;
}

/** Persist the computed priority so other consumers see the same ordering. */
export async function persistPriorities(rows: readonly QueueRow[]): Promise<void> {
  const changed = rows.filter((r) => r.score.priority >= 0);
  if (changed.length === 0) return;
  // One statement, not N: the queue is re-ranked on every page load.
  const cases = sql.join(
    changed.map((r) => sql`when ${workItems.id} = ${r.id}::uuid then ${r.score.priority}`),
    sql` `,
  );
  await db
    .update(workItems)
    .set({ priority: sql`case ${cases} else ${workItems.priority} end` })
    .where(
      inArray(
        workItems.id,
        changed.map((r) => r.id),
      ),
    );
}
