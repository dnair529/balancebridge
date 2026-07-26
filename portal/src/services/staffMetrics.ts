/**
 * Bookkeeper metrics — outcomes first, activity never a score.
 *
 * OVERSIGHT-AND-PERFORMANCE.md §1 names the trap before it names a single
 * metric, and the whole shape of this module follows from it:
 *
 * > Measuring logins and hours is easy to build and easy to get wrong. Track
 * > them as a productivity score and you get three predictable outcomes: people
 * > pad their time, they stay logged in doing nothing, and your best bookkeeper
 * > — the fast one — looks worst.
 *
 * > **Measure outcomes. Use activity for capacity and wellbeing, never as a
 * > score.**
 *
 * So the rollup keeps three separate tiers and the scorecard renders them as
 * three separate things:
 *
 * - **Tier 1 — Outcomes.** On-time close rate, pre-flight first-pass rate,
 *   reviewer rejections, median reply time, SLA breaches. This is the
 *   scorecard.
 * - **Tier 2 — Throughput.** Items cleared, transactions categorised, rule
 *   leverage, AI accepted vs overridden. Context, not ranking. Both directions
 *   of the AI ratio are signal: near-100% acceptance may be rubber-stamping.
 * - **Tier 3 — Capacity and wellbeing.** Active clients, minutes worked,
 *   sessions, out-of-hours minutes. **Never a score.** Out-of-hours work is a
 *   burnout signal to act on, not a diligence badge to reward.
 *
 * And the fairness adjustment §3 calls non-negotiable:
 *
 * > Raw comparison is dishonest: three messy catch-up clients will always look
 * > worse than three clean ones.
 *
 * `difficultyIndex` is a per-person weighting of transaction volume, account
 * count, months of backlog and industry complexity, with 100 as the baseline
 * engagement. Every comparison the scorecard draws is against the **team
 * median**, never against a named individual (DECISIONS.md §6).
 */

import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  accounts,
  aiRuns,
  auditLog,
  clientAssignments,
  clients,
  closeChecks,
  closePeriods,
  sessions,
  staffMetricsDaily,
  timeEntries,
  transactions,
  users,
  workItems,
} from '../db/schema.js';
import { ctParts, isQuietHours } from './alerts.js';

const MS_PER_DAY = 86_400_000;

/** The internal reply target from DECISIONS.md §7: 4 business hours. */
export const REPLY_SLA_MINUTES = 240;

export type MetricsRow = typeof staffMetricsDaily.$inferSelect;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/* ========================================================================== */
/* Difficulty — the fairness adjustment                                        */
/* ========================================================================== */

/**
 * How much harder than a baseline engagement each industry runs. Job costing,
 * tips and payroll, and multi-channel settlement are the three things that
 * genuinely change how long a month takes.
 */
export const INDUSTRY_COMPLEXITY: Record<string, number> = {
  'construction-trades': 1.6,
  'restaurants-hospitality': 1.5,
  'ecommerce-retail': 1.4,
  'medical-dental': 1.1,
  'real-estate': 1.0,
  'professional-services': 0.6,
  other: 0.8,
};

export interface DifficultyInput {
  readonly txns90: number;
  readonly accountCount: number;
  readonly monthsBehind: number;
  readonly industry: string | null;
}

/**
 * One client's difficulty, indexed so that a clean, low-volume, current-books
 * engagement scores **100**. A messy multi-account catch-up runs 250–350.
 *
 * Each term is capped, because the point is to stop a hard portfolio looking
 * like poor work — not to let one pathological client swamp the index.
 */
export function clientDifficulty(input: DifficultyInput): number {
  const volume = Math.min(input.txns90 / 300, 2); // ~100/month is one unit
  const accountLoad = Math.min(input.accountCount / 5, 2);
  const backlog = Math.min(input.monthsBehind / 12, 2);
  const industry = Math.min(INDUSTRY_COMPLEXITY[input.industry ?? 'other'] ?? 0.8, 2);

  const factor = 1 + 0.35 * volume + 0.25 * accountLoad + 0.25 * backlog + 0.15 * industry;
  return Math.round(100 * factor);
}

/** The mean difficulty of a person's live portfolio. 100 with no clients. */
export function portfolioDifficulty(clientIndices: readonly number[]): number {
  if (clientIndices.length === 0) return 100;
  return Math.round(clientIndices.reduce((a, b) => a + b, 0) / clientIndices.length);
}

/* ========================================================================== */
/* The nightly rollup                                                          */
/* ========================================================================== */

export interface RollupResult {
  readonly onDate: string;
  readonly users: number;
  readonly rows: readonly MetricsRow[];
}

/**
 * Roll one day up into `staff_metrics_daily`, for every firm-side user.
 *
 * Idempotent by construction: the table has a unique index on (user, date) and
 * this upserts, so re-running a night — or running it twice by accident —
 * overwrites rather than doubles.
 */
export async function rollupDay(day: Date, now = new Date()): Promise<RollupResult> {
  const onDate = isoDay(day);
  const dayStart = new Date(`${onDate}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + MS_PER_DAY);

  const staff = await db.query.users.findMany({
    where: inArray(users.role, ['staff', 'admin']),
    orderBy: [asc(users.name)],
  });
  if (staff.length === 0) return { onDate, users: 0, rows: [] };
  const staffIds = staff.map((s) => s.id);

  const [
    assignmentRows,
    closeRows,
    checkRows,
    itemRows,
    txnRows,
    aiRows,
    timeRows,
    sessionRows,
    rejectionRows,
    replyRows,
    clientRows,
    txnCountRows,
    accountRows,
  ] = await Promise.all([
    // Assignments live at the end of that day — capacity as it actually was.
    db
      .select({ userId: clientAssignments.userId, clientId: clientAssignments.clientId })
      .from(clientAssignments)
      .where(
        and(
          inArray(clientAssignments.userId, staffIds),
          lte(clientAssignments.assignedAt, dayEnd),
          or(isNull(clientAssignments.endedAt), gte(clientAssignments.endedAt, dayEnd)),
        ),
      ),
    db.query.closePeriods.findMany({
      where: sql`${closePeriods.targetDate} = ${onDate} or (${closePeriods.deliveredAt} >= ${dayStart} and ${closePeriods.deliveredAt} < ${dayEnd})`,
    }),
    db
      .select({ check: closeChecks, ownerId: closePeriods.ownerId, periodId: closePeriods.id })
      .from(closeChecks)
      .innerJoin(closePeriods, eq(closePeriods.id, closeChecks.closePeriodId))
      .where(
        and(gte(closeChecks.checkedAt, dayStart), sql`${closeChecks.checkedAt} < ${dayEnd}`),
      ),
    db
      .select({ userId: workItems.completedBy, n: sql<string>`count(*)` })
      .from(workItems)
      .where(
        and(
          inArray(workItems.completedBy, staffIds),
          gte(workItems.completedAt, dayStart),
          sql`${workItems.completedAt} < ${dayEnd}`,
        ),
      )
      .groupBy(workItems.completedBy),
    db
      .select({ userId: transactions.categorizedById, n: sql<string>`count(*)` })
      .from(transactions)
      .where(
        and(
          inArray(transactions.categorizedById, staffIds),
          gte(transactions.categorizedAt, dayStart),
          sql`${transactions.categorizedAt} < ${dayEnd}`,
        ),
      )
      .groupBy(transactions.categorizedById),
    db
      .select({
        userId: aiRuns.userId,
        provider: aiRuns.provider,
        accepted: aiRuns.accepted,
        n: sql<string>`count(*)`,
      })
      .from(aiRuns)
      .where(
        and(
          inArray(aiRuns.userId, staffIds),
          eq(aiRuns.task, 'categorize'),
          gte(aiRuns.createdAt, dayStart),
          sql`${aiRuns.createdAt} < ${dayEnd}`,
        ),
      )
      .groupBy(aiRuns.userId, aiRuns.provider, aiRuns.accepted),
    db
      .select({
        userId: timeEntries.userId,
        minutes: timeEntries.minutes,
        createdAt: timeEntries.createdAt,
      })
      .from(timeEntries)
      .where(and(inArray(timeEntries.userId, staffIds), eq(timeEntries.occurredOn, onDate))),
    db
      .select({ userId: sessions.userId, createdAt: sessions.createdAt })
      .from(sessions)
      .where(
        and(
          inArray(sessions.userId, staffIds),
          gte(sessions.createdAt, dayStart),
          sql`${sessions.createdAt} < ${dayEnd}`,
        ),
      ),
    // A reviewer rejecting a close is recorded in the audit log. Nothing in the
    // current close flow writes this action yet, so the figure reads zero until
    // a rejection path exists — honest, and it needs no schema change to light up.
    db
      .select({ userId: auditLog.userId, n: sql<string>`count(*)` })
      .from(auditLog)
      .where(
        and(
          inArray(auditLog.action, ['workspace.close_reject', 'oversight.close_reject']),
          gte(auditLog.at, dayStart),
          sql`${auditLog.at} < ${dayEnd}`,
        ),
      )
      .groupBy(auditLog.userId),
    // First staff reply to each client message: the relationship SLA, per person.
    db.execute(sql`
      with client_msgs as (
        select m.id, m.thread_id, m.created_at
          from messages m join users u on u.id = m.sender_id
         where u.role = 'client'
      ),
      first_reply as (
        select cm.id as msg_id,
               cm.created_at as asked_at,
               (select r.id from messages r join users ru on ru.id = r.sender_id
                 where r.thread_id = cm.thread_id and r.created_at > cm.created_at
                   and ru.role in ('staff','admin')
                 order by r.created_at asc limit 1) as reply_id
          from client_msgs cm
      )
      select rm.sender_id as user_id,
             extract(epoch from (rm.created_at - fr.asked_at)) / 60 as minutes
        from first_reply fr
        join messages rm on rm.id = fr.reply_id
       where rm.created_at >= ${dayStart} and rm.created_at < ${dayEnd}`),
    db.query.clients.findMany({ where: inArray(clients.status, ['active', 'paused']) }),
    db
      .select({ clientId: transactions.clientId, n: sql<string>`count(*)` })
      .from(transactions)
      .where(
        sql`${transactions.postedAt} >= ${isoDay(new Date(dayEnd.getTime() - 90 * MS_PER_DAY))}`,
      )
      .groupBy(transactions.clientId),
    db
      .select({ clientId: accounts.clientId, n: sql<string>`count(*)` })
      .from(accounts)
      .where(isNull(accounts.closedAt))
      .groupBy(accounts.clientId),
  ]);

  const num = (v: unknown) => Number(v ?? 0) || 0;

  /* --- difficulty per client, then per person -------------------------- */
  const txnsBy = new Map(txnCountRows.map((r) => [r.clientId, num(r.n)] as const));
  const acctBy = new Map(accountRows.map((r) => [r.clientId, num(r.n)] as const));
  const difficultyByClient = new Map<string, number>();
  for (const c of clientRows) {
    difficultyByClient.set(
      c.id,
      clientDifficulty({
        txns90: txnsBy.get(c.id) ?? 0,
        accountCount: acctBy.get(c.id) ?? 0,
        monthsBehind: c.monthsBehind ?? 0,
        industry: c.industry,
      }),
    );
  }

  const clientsByUser = new Map<string, Set<string>>();
  for (const a of assignmentRows) {
    const set = clientsByUser.get(a.userId) ?? new Set<string>();
    set.add(a.clientId);
    clientsByUser.set(a.userId, set);
  }

  /* --- outcomes --------------------------------------------------------- */
  // A period with no explicit owner is attributed to whoever is primary today,
  // which is the person who would have been chased about it.
  const primaryByClient = new Map<string, string>();
  for (const a of assignmentRows) {
    if (!primaryByClient.has(a.clientId)) primaryByClient.set(a.clientId, a.userId);
  }
  const ownerOf = (p: typeof closePeriods.$inferSelect): string | null =>
    p.ownerId ?? primaryByClient.get(p.clientId) ?? null;

  const closesDue = new Map<string, number>();
  const closesOnTime = new Map<string, number>();
  for (const p of closeRows) {
    const owner = ownerOf(p);
    if (!owner) continue;
    if (String(p.targetDate) === onDate) closesDue.set(owner, (closesDue.get(owner) ?? 0) + 1);
    if (p.deliveredAt && p.deliveredAt >= dayStart && p.deliveredAt < dayEnd && p.targetDate) {
      const target = new Date(`${String(p.targetDate)}T23:59:59.999Z`);
      if (p.deliveredAt <= target) closesOnTime.set(owner, (closesOnTime.get(owner) ?? 0) + 1);
    }
  }

  // A pre-flight "attempt" is one batch of checks; a first pass is a batch with
  // no blocking failure. Only the earliest batch per period counts as first.
  const batches = new Map<string, Map<number, { blocked: boolean; owner: string | null }>>();
  for (const row of checkRows) {
    const perPeriod = batches.get(row.periodId) ?? new Map();
    const stamp = Math.floor(row.check.checkedAt.getTime() / 1000);
    const cur = perPeriod.get(stamp) ?? {
      blocked: false,
      owner: row.ownerId ?? null,
    };
    if (row.check.severity === 'block' && !row.check.passed) cur.blocked = true;
    perPeriod.set(stamp, cur);
    batches.set(row.periodId, perPeriod);
  }
  const preflightAttempts = new Map<string, number>();
  const preflightFirstPass = new Map<string, number>();
  for (const perPeriod of batches.values()) {
    const stamps = [...perPeriod.keys()].sort((a, b) => a - b);
    stamps.forEach((s, i) => {
      const b = perPeriod.get(s)!;
      if (!b.owner) return;
      preflightAttempts.set(b.owner, (preflightAttempts.get(b.owner) ?? 0) + 1);
      if (i === 0 && !b.blocked) {
        preflightFirstPass.set(b.owner, (preflightFirstPass.get(b.owner) ?? 0) + 1);
      }
    });
  }

  const replyMinutes = new Map<string, number[]>();
  for (const r of (replyRows as unknown as { rows: { user_id: string; minutes: string }[] }).rows ??
    []) {
    const arr = replyMinutes.get(r.user_id) ?? [];
    arr.push(Number(r.minutes) || 0);
    replyMinutes.set(r.user_id, arr);
  }

  /* --- throughput ------------------------------------------------------- */
  const itemsBy = new Map(itemRows.map((r) => [r.userId!, num(r.n)] as const));
  const txnBy = new Map(txnRows.map((r) => [r.userId!, num(r.n)] as const));
  const ruleBy = new Map<string, number>();
  const acceptedBy = new Map<string, number>();
  const overriddenBy = new Map<string, number>();
  for (const r of aiRows) {
    if (!r.userId) continue;
    const n = num(r.n);
    if (r.provider === 'rules-engine') ruleBy.set(r.userId, (ruleBy.get(r.userId) ?? 0) + n);
    if (r.accepted === true) acceptedBy.set(r.userId, (acceptedBy.get(r.userId) ?? 0) + n);
    if (r.accepted === false) overriddenBy.set(r.userId, (overriddenBy.get(r.userId) ?? 0) + n);
  }

  /* --- capacity and wellbeing ------------------------------------------- */
  const minutesBy = new Map<string, number>();
  const outOfHoursBy = new Map<string, number>();
  for (const t of timeRows) {
    minutesBy.set(t.userId, (minutesBy.get(t.userId) ?? 0) + t.minutes);
    // The entry's own timestamp says when the work was actually logged, which
    // for automatic entries is when it happened. Weekend and evening minutes
    // are counted so somebody can act on them — never scored.
    if (isQuietHours(t.createdAt)) {
      outOfHoursBy.set(t.userId, (outOfHoursBy.get(t.userId) ?? 0) + t.minutes);
    }
  }
  const sessionsBy = new Map<string, number>();
  const outOfHoursSessions = new Map<string, number>();
  for (const s of sessionRows) {
    sessionsBy.set(s.userId, (sessionsBy.get(s.userId) ?? 0) + 1);
    if (isQuietHours(s.createdAt)) {
      outOfHoursSessions.set(s.userId, (outOfHoursSessions.get(s.userId) ?? 0) + 1);
    }
  }
  const rejectionsBy = new Map(rejectionRows.map((r) => [r.userId ?? '', num(r.n)] as const));

  /* --- write ------------------------------------------------------------ */
  const written: MetricsRow[] = [];
  for (const s of staff) {
    const portfolio = [...(clientsByUser.get(s.id) ?? new Set<string>())];
    const replies = replyMinutes.get(s.id) ?? [];
    const sorted = [...replies].sort((a, b) => a - b);
    const median =
      sorted.length === 0
        ? null
        : sorted.length % 2 === 1
          ? Math.round(sorted[(sorted.length - 1) / 2]!)
          : Math.round((sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2);

    // No time entries but sessions out of hours still tells you something: fall
    // back to the session share rather than reporting a confident zero.
    const minutes = minutesBy.get(s.id) ?? 0;
    let outOfHours = outOfHoursBy.get(s.id) ?? 0;
    const sessionCount = sessionsBy.get(s.id) ?? 0;
    if (outOfHours === 0 && minutes > 0 && sessionCount > 0) {
      const share = (outOfHoursSessions.get(s.id) ?? 0) / sessionCount;
      outOfHours = Math.round(minutes * share);
    }

    const values = {
      userId: s.id,
      onDate,
      closesDue: closesDue.get(s.id) ?? 0,
      closesOnTime: closesOnTime.get(s.id) ?? 0,
      preflightFirstPass: preflightFirstPass.get(s.id) ?? 0,
      preflightAttempts: preflightAttempts.get(s.id) ?? 0,
      reviewerRejections: rejectionsBy.get(s.id) ?? 0,
      medianReplyMinutes: median,
      slaBreaches: replies.filter((m) => m > REPLY_SLA_MINUTES).length,
      itemsCleared: itemsBy.get(s.id) ?? 0,
      txnsCategorized: txnBy.get(s.id) ?? 0,
      ruleResolved: ruleBy.get(s.id) ?? 0,
      aiAccepted: acceptedBy.get(s.id) ?? 0,
      aiOverridden: overriddenBy.get(s.id) ?? 0,
      activeClients: portfolio.length,
      minutesWorked: minutes,
      sessionsCount: sessionCount,
      outOfHoursMinutes: outOfHours,
      difficultyIndex: portfolioDifficulty(
        portfolio.map((c) => difficultyByClient.get(c) ?? 100),
      ),
    };

    const [row] = await db
      .insert(staffMetricsDaily)
      .values(values)
      .onConflictDoUpdate({
        target: [staffMetricsDaily.userId, staffMetricsDaily.onDate],
        set: values,
      })
      .returning();
    if (row) written.push(row);
  }

  void now;
  return { onDate, users: staff.length, rows: written };
}

/** Roll up a window of days, oldest first. Used by the nightly job's catch-up. */
export async function rollupRange(from: Date, to: Date): Promise<RollupResult[]> {
  const out: RollupResult[] = [];
  for (let t = from.getTime(); t <= to.getTime(); t += MS_PER_DAY) {
    out.push(await rollupDay(new Date(t)));
  }
  return out;
}

/* ========================================================================== */
/* Scorecards                                                                  */
/* ========================================================================== */

export interface Outcomes {
  readonly closesDue: number;
  readonly closesOnTime: number;
  /** Percent, null when nothing was due in the period. */
  readonly onTimeClosePct: number | null;
  readonly preflightAttempts: number;
  readonly preflightFirstPass: number;
  readonly preflightFirstPassPct: number | null;
  readonly reviewerRejections: number;
  readonly medianReplyMinutes: number | null;
  readonly slaBreaches: number;
}

export interface Throughput {
  readonly itemsCleared: number;
  readonly txnsCategorized: number;
  readonly ruleResolved: number;
  /** Rule leverage — the compounding asset (§3 Tier 2). */
  readonly ruleSharePct: number | null;
  readonly aiAccepted: number;
  readonly aiOverridden: number;
  readonly aiAcceptancePct: number | null;
}

export interface Capacity {
  readonly activeClients: number;
  readonly minutesWorked: number;
  readonly sessionsCount: number;
  readonly outOfHoursMinutes: number;
  readonly outOfHoursPct: number | null;
  readonly activeDays: number;
}

export interface Adjusted {
  readonly difficultyIndex: number;
  /** On-time rate credited for portfolio difficulty, capped at 100. */
  readonly onTimeClosePct: number | null;
  readonly txnsPerActiveDay: number | null;
  readonly medianReplyMinutes: number | null;
}

export interface Scorecard {
  readonly userId: string;
  readonly name: string;
  readonly role: string;
  readonly from: string;
  readonly to: string;
  readonly days: number;
  readonly outcomes: Outcomes;
  readonly throughput: Throughput;
  readonly capacity: Capacity;
  readonly adjusted: Adjusted;
  /** The benchmark. A median, never a leaderboard (DECISIONS.md §6). */
  readonly teamMedian: TeamMedian;
  /** How many people the median was drawn from — honesty about small n. */
  readonly teamSize: number;
  readonly portfolio: readonly PortfolioSlice[];
  readonly daily: readonly MetricsRow[];
}

export interface TeamMedian {
  readonly onTimeClosePct: number | null;
  readonly preflightFirstPassPct: number | null;
  readonly medianReplyMinutes: number | null;
  readonly slaBreaches: number | null;
  readonly itemsCleared: number | null;
  readonly txnsCategorized: number | null;
  readonly ruleSharePct: number | null;
  readonly aiAcceptancePct: number | null;
  readonly activeClients: number | null;
  readonly minutesWorked: number | null;
  readonly outOfHoursMinutes: number | null;
  readonly difficultyIndex: number | null;
  readonly adjustedOnTimeClosePct: number | null;
}

export interface PortfolioSlice {
  readonly clientId: string;
  readonly businessName: string;
  readonly difficultyIndex: number;
}

export type Period = '7d' | '30d' | '90d' | '6m';

export const PERIODS: readonly { value: Period; label: string; days: number }[] = [
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: '90d', label: 'Last 90 days', days: 90 },
  { value: '6m', label: 'Last 6 months', days: 183 },
];

export function isPeriod(v: unknown): v is Period {
  return PERIODS.some((p) => p.value === v);
}

function pct(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 100);
}

function median(values: readonly number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? Math.round(sorted[mid]!)
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

interface Aggregate {
  outcomes: Outcomes;
  throughput: Throughput;
  capacity: Capacity;
  adjusted: Adjusted;
}

function aggregate(rows: readonly MetricsRow[]): Aggregate {
  const sum = (f: (r: MetricsRow) => number) => rows.reduce((n, r) => n + f(r), 0);

  const closesDue = sum((r) => r.closesDue);
  const closesOnTime = sum((r) => r.closesOnTime);
  const preflightAttempts = sum((r) => r.preflightAttempts);
  const preflightFirstPass = sum((r) => r.preflightFirstPass);
  const replyValues = rows
    .map((r) => r.medianReplyMinutes)
    .filter((v): v is number => v !== null);
  const txnsCategorized = sum((r) => r.txnsCategorized);
  const ruleResolved = sum((r) => r.ruleResolved);
  const aiAccepted = sum((r) => r.aiAccepted);
  const aiOverridden = sum((r) => r.aiOverridden);
  const minutesWorked = sum((r) => r.minutesWorked);
  const outOfHoursMinutes = sum((r) => r.outOfHoursMinutes);
  const activeDays = rows.filter((r) => r.minutesWorked > 0 || r.itemsCleared > 0).length;
  // Carried capacity is a level, not a total: the latest day that has one.
  const latest = [...rows].sort((a, b) => String(a.onDate).localeCompare(String(b.onDate))).at(-1);
  const difficultyIndex = latest?.difficultyIndex ?? 100;

  const onTimeClosePct = pct(closesOnTime, closesDue);
  const medianReply = median(replyValues);

  return {
    outcomes: {
      closesDue,
      closesOnTime,
      onTimeClosePct,
      preflightAttempts,
      preflightFirstPass,
      preflightFirstPassPct: pct(preflightFirstPass, preflightAttempts),
      reviewerRejections: sum((r) => r.reviewerRejections),
      medianReplyMinutes: medianReply,
      slaBreaches: sum((r) => r.slaBreaches),
    },
    throughput: {
      itemsCleared: sum((r) => r.itemsCleared),
      txnsCategorized,
      ruleResolved,
      ruleSharePct: pct(ruleResolved, txnsCategorized),
      aiAccepted,
      aiOverridden,
      aiAcceptancePct: pct(aiAccepted, aiAccepted + aiOverridden),
    },
    capacity: {
      activeClients: latest?.activeClients ?? 0,
      minutesWorked,
      sessionsCount: sum((r) => r.sessionsCount),
      outOfHoursMinutes,
      outOfHoursPct: pct(outOfHoursMinutes, minutesWorked),
      activeDays,
    },
    adjusted: {
      difficultyIndex,
      // Credit a harder portfolio; never let the adjustment invent >100%.
      onTimeClosePct:
        onTimeClosePct === null
          ? null
          : Math.min(100, Math.round((onTimeClosePct * difficultyIndex) / 100)),
      txnsPerActiveDay:
        activeDays === 0
          ? null
          : Math.round(((txnsCategorized / activeDays) * difficultyIndex) / 100),
      // Lower is better, so a harder portfolio earns a discount, not a penalty.
      medianReplyMinutes:
        medianReply === null ? null : Math.round((medianReply * 100) / difficultyIndex),
    },
  };
}

/**
 * One person's scorecard for a period.
 *
 * Returned to the admin for anybody, and to a staff user **for themselves
 * only** — the route enforces that, and the only cross-person figure in the
 * payload is the team median. There is deliberately no field anywhere in this
 * shape that carries another individual's numbers or name.
 */
export async function scorecard(userId: string, period: Period = '30d'): Promise<Scorecard | null> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || user.role === 'client') return null;

  const days = PERIODS.find((p) => p.value === period)?.days ?? 30;
  const to = new Date();
  const from = new Date(to.getTime() - days * MS_PER_DAY);
  const fromDay = isoDay(from);
  const toDay = isoDay(to);

  const [allRows, portfolioRows, clientRows, txnCountRows, accountRows] = await Promise.all([
    db
      .select()
      .from(staffMetricsDaily)
      .where(and(gte(staffMetricsDaily.onDate, fromDay), lte(staffMetricsDaily.onDate, toDay)))
      .orderBy(asc(staffMetricsDaily.onDate)),
    db
      .select({ clientId: clientAssignments.clientId, businessName: clients.businessName })
      .from(clientAssignments)
      .innerJoin(clients, eq(clients.id, clientAssignments.clientId))
      .where(and(eq(clientAssignments.userId, userId), isNull(clientAssignments.endedAt))),
    db.query.clients.findMany({ where: inArray(clients.status, ['active', 'paused']) }),
    db
      .select({ clientId: transactions.clientId, n: sql<string>`count(*)` })
      .from(transactions)
      .where(sql`${transactions.postedAt} >= ${isoDay(new Date(to.getTime() - 90 * MS_PER_DAY))}`)
      .groupBy(transactions.clientId),
    db
      .select({ clientId: accounts.clientId, n: sql<string>`count(*)` })
      .from(accounts)
      .where(isNull(accounts.closedAt))
      .groupBy(accounts.clientId),
  ]);

  const mine = allRows.filter((r) => r.userId === userId);
  const agg = aggregate(mine);

  // Team median: everyone else's aggregate reduced to a middle value. The
  // individual aggregates are computed and then discarded — nothing but the
  // median leaves this function.
  const byUser = new Map<string, MetricsRow[]>();
  for (const r of allRows) {
    const arr = byUser.get(r.userId) ?? [];
    arr.push(r);
    byUser.set(r.userId, arr);
  }
  const peers = [...byUser.values()].map(aggregate);
  const collect = <T>(f: (a: Aggregate) => T | null): number[] =>
    peers.map(f).filter((v): v is T & number => typeof v === 'number');

  const teamMedian: TeamMedian = {
    onTimeClosePct: median(collect((a) => a.outcomes.onTimeClosePct)),
    preflightFirstPassPct: median(collect((a) => a.outcomes.preflightFirstPassPct)),
    medianReplyMinutes: median(collect((a) => a.outcomes.medianReplyMinutes)),
    slaBreaches: median(collect((a) => a.outcomes.slaBreaches)),
    itemsCleared: median(collect((a) => a.throughput.itemsCleared)),
    txnsCategorized: median(collect((a) => a.throughput.txnsCategorized)),
    ruleSharePct: median(collect((a) => a.throughput.ruleSharePct)),
    aiAcceptancePct: median(collect((a) => a.throughput.aiAcceptancePct)),
    activeClients: median(collect((a) => a.capacity.activeClients)),
    minutesWorked: median(collect((a) => a.capacity.minutesWorked)),
    outOfHoursMinutes: median(collect((a) => a.capacity.outOfHoursMinutes)),
    difficultyIndex: median(collect((a) => a.adjusted.difficultyIndex)),
    adjustedOnTimeClosePct: median(collect((a) => a.adjusted.onTimeClosePct)),
  };

  const num = (v: unknown) => Number(v ?? 0) || 0;
  const txnsBy = new Map(txnCountRows.map((r) => [r.clientId, num(r.n)] as const));
  const acctBy = new Map(accountRows.map((r) => [r.clientId, num(r.n)] as const));
  const clientBy = new Map(clientRows.map((c) => [c.id, c] as const));

  const portfolio: PortfolioSlice[] = portfolioRows.map((p) => {
    const c = clientBy.get(p.clientId);
    return {
      clientId: p.clientId,
      businessName: p.businessName,
      difficultyIndex: clientDifficulty({
        txns90: txnsBy.get(p.clientId) ?? 0,
        accountCount: acctBy.get(p.clientId) ?? 0,
        monthsBehind: c?.monthsBehind ?? 0,
        industry: c?.industry ?? null,
      }),
    };
  });

  return {
    userId,
    name: user.name,
    role: user.role,
    from: fromDay,
    to: toDay,
    days,
    ...agg,
    teamMedian,
    teamSize: byUser.size,
    portfolio: portfolio.sort((a, b) => b.difficultyIndex - a.difficultyIndex),
    daily: mine,
  };
}

/* ========================================================================== */
/* Wellbeing                                                                   */
/* ========================================================================== */

export interface WellbeingFlag {
  readonly userId: string;
  readonly name: string;
  readonly weekMinutes: number;
  readonly outOfHoursMinutes: number;
  readonly baselineMinutes: number;
  readonly ratio: number;
}

/**
 * §4: *"Bookkeeper >2× normal weekend hours — admin only, weekly, framed as
 * wellbeing."*
 *
 * The comparison is against that person's own trailing baseline, not against a
 * colleague. Somebody who normally works no weekends doubling to four hours is
 * the signal; somebody who has always worked Saturday mornings is not news.
 */
export async function wellbeingFlags(now = new Date()): Promise<WellbeingFlag[]> {
  const weekFrom = isoDay(new Date(now.getTime() - 7 * MS_PER_DAY));
  const baseFrom = isoDay(new Date(now.getTime() - 56 * MS_PER_DAY));
  const today = isoDay(now);

  const rows = await db
    .select({ m: staffMetricsDaily, name: users.name })
    .from(staffMetricsDaily)
    .innerJoin(users, eq(users.id, staffMetricsDaily.userId))
    .where(and(gte(staffMetricsDaily.onDate, baseFrom), lte(staffMetricsDaily.onDate, today)));

  const byUser = new Map<string, { name: string; rows: MetricsRow[] }>();
  for (const r of rows) {
    const entry = byUser.get(r.m.userId) ?? { name: r.name, rows: [] };
    entry.rows.push(r.m);
    byUser.set(r.m.userId, entry);
  }

  const out: WellbeingFlag[] = [];
  for (const [userId, entry] of byUser) {
    const week = entry.rows.filter((r) => String(r.onDate) >= weekFrom);
    const before = entry.rows.filter((r) => String(r.onDate) < weekFrom);
    const weekOut = week.reduce((n, r) => n + r.outOfHoursMinutes, 0);
    const weeksBefore = Math.max(1, before.length / 7);
    const baseline = before.reduce((n, r) => n + r.outOfHoursMinutes, 0) / weeksBefore;

    if (weekOut < 120) continue; // under two hours is not a pattern
    const ratio = baseline === 0 ? Infinity : weekOut / baseline;
    if (ratio < 2) continue;

    out.push({
      userId,
      name: entry.name,
      weekMinutes: week.reduce((n, r) => n + r.minutesWorked, 0),
      outOfHoursMinutes: weekOut,
      baselineMinutes: Math.round(baseline),
      ratio: Number.isFinite(ratio) ? Math.round(ratio * 10) / 10 : 99,
    });
  }
  return out;
}

/** Local re-export so callers do not have to reach into the alerts module. */
export function ctHourOf(d: Date): number {
  return ctParts(d).hour;
}

/** Every firm-side user with a rolled-up presence, for the admin's index. */
export async function staffWithMetrics(): Promise<
  { id: string; name: string; email: string; role: string; disabled: boolean; lastRollup: string | null }[]
> {
  const [staff, latest] = await Promise.all([
    db.query.users.findMany({
      where: inArray(users.role, ['staff', 'admin']),
      orderBy: [asc(users.name)],
    }),
    db
      .select({
        userId: staffMetricsDaily.userId,
        last: sql<string>`max(${staffMetricsDaily.onDate})`,
      })
      .from(staffMetricsDaily)
      .groupBy(staffMetricsDaily.userId),
  ]);
  const by = new Map(latest.map((r) => [r.userId, r.last] as const));
  return staff.map((s) => ({
    id: s.id,
    name: s.name,
    email: s.email,
    role: s.role,
    disabled: s.disabled,
    lastRollup: by.get(s.id) ?? null,
  }));
}
