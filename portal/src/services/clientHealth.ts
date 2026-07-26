/**
 * Client health — a RAG status that explains itself.
 *
 * OVERSIGHT-AND-PERFORMANCE.md §2. Six dimensions, each scored independently
 * against an explicit threshold, rolled into one colour. Three rules from that
 * document are load-bearing and are enforced here rather than in any caller:
 *
 * > **Overall status = the worst dimension.** One red makes the client red.
 * > Averaging hides exactly the thing you need to see.
 *
 * > **Every status must name its reason and say who is blocked.** A client can
 * > go red because *we* are behind, or because *they* will not send statements.
 * > If those look identical on a dashboard the number is worse than useless —
 * > it punishes a bookkeeper for a client's behaviour. So every dimension
 * > carries `blockedBy: firm | client | external | none`.
 *
 * > **Thresholds are configurable, never a vibe.** Every number below is read
 * > from `health_thresholds` with the documented default seeded on first use,
 * > so tuning the firm's tolerance is a form submission, not a deploy.
 *
 * A fourth rule comes from DECISIONS.md §9 and is enforced by the *routes*, not
 * by this module: **the engagement RAG is never shown to a client-role user.**
 * Nothing here is client-facing. `services/healthScore.ts` — the 20-point books
 * score — is the client-facing artefact, and it is a different thing.
 *
 * ## Reading the tables
 *
 * The one place the spec leaves a gap is client responsiveness: green is "no
 * request older than 7 days" and yellow is "something outstanding 14–30 days",
 * which says nothing about days 8–13. This module treats 8–30 days as yellow —
 * the stricter reading, and the only one consistent with the stated green
 * bound. The 14-day mark from DECISIONS.md §7 survives as the point at which
 * the reason text starts calling it a chase.
 */

import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  accounts,
  anomalies,
  clientAssignments,
  clientQuestions,
  clientStatusHistory,
  clients,
  closePeriods,
  documentRequests,
  healthThresholds,
  intakeItems,
  invoices,
  messages,
  threads,
  timeEntries,
  transactions,
  users,
} from '../db/schema.js';

export type Rag = 'green' | 'yellow' | 'red';
export type BlockedBy = 'firm' | 'client' | 'external' | 'none';
export type Trend = 'improving' | 'stable' | 'degrading' | 'new';

export const DIMENSIONS = [
  'close',
  'responsiveness',
  'books',
  'risk',
  'relationship',
  'commercial',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<Dimension, string> = {
  close: 'Close timeliness',
  responsiveness: 'Client responsiveness',
  books: 'Books condition',
  risk: 'Risk signals',
  relationship: 'Relationship',
  commercial: 'Commercial',
};

export interface DimensionResult {
  readonly dimension: Dimension;
  readonly label: string;
  readonly status: Rag;
  /** In words. A colour without a reason is useless. */
  readonly reason: string;
  readonly blockedBy: BlockedBy;
}

export interface ClientHealth {
  readonly clientId: string;
  readonly businessName: string;
  readonly clientStatus: string;
  /** The worst dimension, never an average. */
  readonly status: Rag;
  readonly blockedBy: BlockedBy;
  /** One sentence naming what drove the colour. */
  readonly reason: string;
  readonly dimensions: readonly DimensionResult[];
  readonly trend: Trend;
  /** Days spent in the current colour. Null when there is no history yet. */
  readonly timeInStatusDays: number | null;
  readonly statusSince: Date | null;
  /** Business days to the close target; negative means past it. */
  readonly daysToClose: number | null;
  readonly closeTargetDate: Date | null;
  readonly primaryUserId: string | null;
  readonly primaryName: string | null;
  readonly plan: string | null;
  readonly monthlyFeeCents: number | null;
  readonly effortMinutes90: number;
  readonly effortCents90: number;
  readonly feeCents90: number;
  /** Effort as a percentage of fee over 90 days. Null with no fee on record. */
  readonly effortPct: number | null;
}

const RANK: Record<Rag, number> = { green: 0, yellow: 1, red: 2 };
const MS_PER_DAY = 86_400_000;

/** What an hour of bookkeeping costs the firm — the effort-vs-fee denominator. */
export const STAFF_COST_PER_HOUR_CENTS = 6_000;

/* ========================================================================== */
/* Thresholds — seeded defaults, tunable without a deploy                      */
/* ========================================================================== */

export interface ThresholdSpec {
  readonly key: string;
  readonly dimension: Dimension;
  readonly label: string;
  readonly unit: string;
  readonly yellowAt: number;
  readonly redAt: number;
  /** What the two numbers actually mean, shown on the settings page. */
  readonly help: string;
}

/**
 * The defaults are the tables in OVERSIGHT-AND-PERFORMANCE.md §2 and
 * DECISIONS.md §7, transcribed. Changing a row changes behaviour on the next
 * computation; nothing is compiled in.
 */
export const THRESHOLD_DEFAULTS: readonly ThresholdSpec[] = [
  {
    key: 'close_days_late',
    dimension: 'close',
    label: 'Close delivered late',
    unit: 'days',
    yellowAt: 1,
    redAt: 5,
    help: 'Days past the contractual target date. Yellow from 1 day, red beyond 5 — or if a period was skipped entirely.',
  },
  {
    key: 'responsiveness_request_age',
    dimension: 'responsiveness',
    label: 'Oldest thing we are waiting on',
    unit: 'days',
    yellowAt: 7,
    redAt: 30,
    help: 'Age of the oldest open document request or unanswered question. Green while nothing is older than the yellow figure.',
  },
  {
    key: 'responsiveness_silence',
    dimension: 'responsiveness',
    label: 'Client silence',
    unit: 'days',
    yellowAt: 14,
    redAt: 21,
    help: 'Days since anything at all arrived from the client — a document, a message, an answer.',
  },
  {
    key: 'books_stale_txns',
    dimension: 'books',
    label: 'Stale uncategorised transactions',
    unit: 'count',
    yellowAt: 5,
    redAt: 25,
    help: 'Transactions older than 30 days with no category. Yellow at 5, red beyond 25.',
  },
  {
    key: 'books_accounts_behind',
    dimension: 'books',
    label: 'Accounts behind on reconciliation',
    unit: 'count',
    yellowAt: 1,
    redAt: 2,
    help: 'Accounts carrying unreconciled activity from before the current month. One is yellow; more than one period unreconciled is red.',
  },
  {
    key: 'risk_open_anomalies',
    dimension: 'risk',
    label: 'Unresolved anomalies',
    unit: 'count',
    yellowAt: 1,
    redAt: 1,
    help: 'Yellow at this many unresolved medium anomalies; red at this many unresolved high ones (duplicate payment, missing deposit).',
  },
  {
    key: 'relationship_reply_hours',
    dimension: 'relationship',
    label: 'Unanswered client message',
    unit: 'hours',
    yellowAt: 4,
    redAt: 72,
    help: 'Hours a client message has sat without a reply. Yellow at the internal 4-business-hour target; red once it is an escalation rather than a delay.',
  },
  {
    key: 'commercial_invoice_overdue_days',
    dimension: 'commercial',
    label: 'Invoice overdue',
    unit: 'days',
    yellowAt: 1,
    redAt: 30,
    help: 'Days past an invoice due date. With payment on file this should be rare, which is what makes it a meaningful signal.',
  },
  {
    key: 'commercial_effort_pct',
    dimension: 'commercial',
    label: 'Effort against fee',
    unit: 'percent',
    yellowAt: 150,
    redAt: 200,
    help: 'Cost of logged effort as a percentage of the fee over 90 days. 150 is 1.5× the fee; 200 is 2×.',
  },
] as const;

export interface ThresholdRow extends ThresholdSpec {
  readonly id: string | null;
  readonly updatedAt: Date | null;
  readonly updatedByName: string | null;
  /** The figures transcribed from the design docs, for "reset" and comparison. */
  readonly defaultYellowAt: number;
  readonly defaultRedAt: number;
  /** True when the stored figures differ from the documented default. */
  readonly tuned: boolean;
}

/** Insert any documented threshold that has never been stored. Idempotent. */
export async function ensureThresholds(): Promise<void> {
  const existing = await db.select({ dimension: healthThresholds.dimension }).from(healthThresholds);
  const have = new Set(existing.map((r) => r.dimension));
  const missing = THRESHOLD_DEFAULTS.filter((d) => !have.has(d.key));
  if (missing.length === 0) return;
  await db
    .insert(healthThresholds)
    .values(
      missing.map((d) => ({
        dimension: d.key,
        yellowAt: d.yellowAt,
        redAt: d.redAt,
        unit: d.unit,
      })),
    )
    .onConflictDoNothing();
}

export type Thresholds = Record<string, { yellowAt: number; redAt: number }>;

/** Stored values, with the documented default standing in for anything absent. */
export async function loadThresholds(): Promise<Thresholds> {
  const rows = await db.select().from(healthThresholds);
  const byKey = new Map(rows.map((r) => [r.dimension, r] as const));
  const out: Thresholds = {};
  for (const spec of THRESHOLD_DEFAULTS) {
    const row = byKey.get(spec.key);
    out[spec.key] = {
      yellowAt: row?.yellowAt ?? spec.yellowAt,
      redAt: row?.redAt ?? spec.redAt,
    };
  }
  return out;
}

/** The settings page's read model: default, stored, and who last moved it. */
export async function thresholdRows(): Promise<ThresholdRow[]> {
  await ensureThresholds();
  const rows = await db
    .select({ t: healthThresholds, editor: users.name })
    .from(healthThresholds)
    .leftJoin(users, eq(users.id, healthThresholds.updatedBy));
  const byKey = new Map(rows.map((r) => [r.t.dimension, r] as const));

  return THRESHOLD_DEFAULTS.map((spec) => {
    const found = byKey.get(spec.key);
    const yellowAt = found?.t.yellowAt ?? spec.yellowAt;
    const redAt = found?.t.redAt ?? spec.redAt;
    return {
      ...spec,
      yellowAt,
      redAt,
      id: found?.t.id ?? null,
      updatedAt: found?.t.updatedAt ?? null,
      updatedByName: found?.editor ?? null,
      defaultYellowAt: spec.yellowAt,
      defaultRedAt: spec.redAt,
      tuned: yellowAt !== spec.yellowAt || redAt !== spec.redAt,
    };
  });
}

export function isThresholdKey(key: string): boolean {
  return THRESHOLD_DEFAULTS.some((d) => d.key === key);
}

/** Move one threshold. Admin-only at the route; this is the write itself. */
export async function updateThreshold(
  key: string,
  yellowAt: number,
  redAt: number,
  updatedBy: string,
): Promise<boolean> {
  if (!isThresholdKey(key)) return false;
  if (!Number.isFinite(yellowAt) || !Number.isFinite(redAt)) return false;
  if (yellowAt < 0 || redAt < 0) return false;
  await ensureThresholds();
  const spec = THRESHOLD_DEFAULTS.find((d) => d.key === key)!;
  const rows = await db
    .update(healthThresholds)
    .set({
      yellowAt: Math.round(yellowAt),
      redAt: Math.round(redAt),
      unit: spec.unit,
      updatedBy,
      updatedAt: new Date(),
    })
    .where(eq(healthThresholds.dimension, key))
    .returning({ id: healthThresholds.id });
  return rows.length > 0;
}

/* ========================================================================== */
/* Facts — bulk-loaded once, then scored per client in memory                  */
/* ========================================================================== */

export interface Facts {
  readonly client: typeof clients.$inferSelect;
  readonly periods: readonly (typeof closePeriods.$inferSelect)[];
  readonly oldestOpenAskAt: Date | null;
  readonly openAsks: number;
  readonly lastClientActivityAt: Date | null;
  readonly staleTxns: number;
  readonly accountsBehind: number;
  readonly anomalyHigh: number;
  readonly anomalyMedium: number;
  readonly unansweredHours: number | null;
  readonly invoiceOverdueDays: number | null;
  readonly effortMinutes90: number;
  readonly invoiced90Cents: number;
  readonly primaryUserId: string | null;
  readonly primaryName: string | null;
  readonly history: readonly (typeof clientStatusHistory.$inferSelect)[];
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/**
 * Dates arrive in three shapes and all three have to work.
 *
 * A `date` column is `2026-06-30`. A driver-mapped timestamp is a `Date`. An
 * aggregate written as raw SQL (`min(created_at)`) bypasses drizzle's column
 * mapper and arrives as Postgres's own text form, `2026-06-16 23:17:27.144+00`
 * — which `new Date()` will not parse reliably without the `T` separator and a
 * two-digit offset minute. Normalising here is what stops a threshold silently
 * comparing against `NaN` and reporting green.
 */
function asDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const raw = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(`${raw}T00:00:00.000Z`);
  const normalised = raw.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(normalised);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Load every fact the six dimensions need, for every engaged client, in a fixed
 * number of queries. The alternative — a per-client fan-out — turns the morning
 * portfolio screen into a query storm the first time the firm has 40 clients.
 */
async function loadFacts(now: Date): Promise<Facts[]> {
  const since90 = isoDay(new Date(now.getTime() - 90 * MS_PER_DAY));
  const stale = isoDay(new Date(now.getTime() - 30 * MS_PER_DAY));
  const monthStart = isoDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));

  const clientRows = await db.query.clients.findMany({
    where: inArray(clients.status, ['active', 'paused']),
    orderBy: [asc(clients.businessName)],
  });
  const ids = clientRows.map((c) => c.id);
  if (ids.length === 0) return [];

  const [
    periodRows,
    docRows,
    questionRows,
    intakeRows,
    clientMsgRows,
    answerRows,
    staleRows,
    behindRows,
    anomalyRows,
    unansweredRows,
    invoiceRows,
    timeRows,
    invoiced90Rows,
    assignmentRows,
    historyRows,
  ] = await Promise.all([
    db.query.closePeriods.findMany({
      where: inArray(closePeriods.clientId, ids),
      orderBy: [desc(closePeriods.periodStart)],
    }),
    db
      .select({
        clientId: documentRequests.clientId,
        oldest: sql<Date | null>`min(${documentRequests.createdAt})`.mapWith(documentRequests.createdAt),
        n: sql<string>`count(*)`,
      })
      .from(documentRequests)
      .where(and(inArray(documentRequests.clientId, ids), eq(documentRequests.status, 'open')))
      .groupBy(documentRequests.clientId),
    db
      .select({
        clientId: clientQuestions.clientId,
        oldest: sql<Date | null>`min(${clientQuestions.createdAt})`.mapWith(clientQuestions.createdAt),
        n: sql<string>`count(*)`,
      })
      .from(clientQuestions)
      .where(and(inArray(clientQuestions.clientId, ids), isNull(clientQuestions.answeredAt)))
      .groupBy(clientQuestions.clientId),
    db
      .select({
        clientId: intakeItems.clientId,
        last: sql<Date | null>`max(${intakeItems.receivedAt})`.mapWith(intakeItems.receivedAt),
      })
      .from(intakeItems)
      .where(inArray(intakeItems.clientId, ids))
      .groupBy(intakeItems.clientId),
    db
      .select({
        clientId: threads.clientId,
        last: sql<Date | null>`max(${messages.createdAt})`.mapWith(messages.createdAt),
      })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .innerJoin(users, eq(users.id, messages.senderId))
      .where(and(eq(users.role, 'client'), inArray(threads.clientId, ids)))
      .groupBy(threads.clientId),
    db
      .select({
        clientId: clientQuestions.clientId,
        last: sql<Date | null>`max(${clientQuestions.answeredAt})`.mapWith(clientQuestions.createdAt),
      })
      .from(clientQuestions)
      .where(inArray(clientQuestions.clientId, ids))
      .groupBy(clientQuestions.clientId),
    db
      .select({ clientId: transactions.clientId, n: sql<string>`count(*)` })
      .from(transactions)
      .where(
        and(
          inArray(transactions.clientId, ids),
          isNull(transactions.categoryId),
          sql`${transactions.postedAt} <= ${stale}`,
        ),
      )
      .groupBy(transactions.clientId),
    db
      .select({
        clientId: transactions.clientId,
        n: sql<string>`count(distinct ${transactions.accountId})`,
      })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(
        and(
          inArray(transactions.clientId, ids),
          isNull(transactions.reconciledAt),
          isNull(accounts.closedAt),
          sql`${transactions.postedAt} < ${monthStart}`,
        ),
      )
      .groupBy(transactions.clientId),
    db
      .select({
        clientId: anomalies.clientId,
        severity: anomalies.severity,
        n: sql<string>`count(*)`,
      })
      .from(anomalies)
      .where(and(inArray(anomalies.clientId, ids), eq(anomalies.status, 'open')))
      .groupBy(anomalies.clientId, anomalies.severity),
    // Every message on an open thread in the recent window, newest first. The
    // *last* one per thread is the signal: when it came from the client, the
    // firm still owes a reply, and its age is the relationship measure.
    db
      .select({
        threadId: messages.threadId,
        clientId: threads.clientId,
        at: messages.createdAt,
        role: users.role,
      })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .innerJoin(users, eq(users.id, messages.senderId))
      .where(
        and(
          isNull(threads.closedAt),
          inArray(threads.clientId, ids),
          gte(messages.createdAt, new Date(now.getTime() - 180 * MS_PER_DAY)),
        ),
      )
      .orderBy(desc(messages.createdAt)),
    db
      .select({
        clientId: invoices.clientId,
        oldestDue: sql<Date | null>`min(${invoices.dueAt})`.mapWith(invoices.dueAt),
      })
      .from(invoices)
      .where(
        and(
          inArray(invoices.clientId, ids),
          sql`${invoices.amountDueCents} > ${invoices.amountPaidCents}`,
          sql`${invoices.dueAt} is not null and ${invoices.dueAt} < ${now}`,
          sql`${invoices.status} not in ('void','paid','draft')`,
        ),
      )
      .groupBy(invoices.clientId),
    db
      .select({
        clientId: timeEntries.clientId,
        minutes: sql<string>`coalesce(sum(${timeEntries.minutes}), 0)`,
      })
      .from(timeEntries)
      .where(and(inArray(timeEntries.clientId, ids), gte(timeEntries.occurredOn, since90)))
      .groupBy(timeEntries.clientId),
    db
      .select({
        clientId: invoices.clientId,
        cents: sql<string>`coalesce(sum(greatest(${invoices.amountDueCents}, ${invoices.amountPaidCents})), 0)`,
      })
      .from(invoices)
      .where(
        and(
          inArray(invoices.clientId, ids),
          sql`${invoices.issuedAt} is null or ${invoices.issuedAt} >= ${new Date(now.getTime() - 90 * MS_PER_DAY)}`,
        ),
      )
      .groupBy(invoices.clientId),
    db
      .select({
        clientId: clientAssignments.clientId,
        userId: clientAssignments.userId,
        name: users.name,
      })
      .from(clientAssignments)
      .innerJoin(users, eq(users.id, clientAssignments.userId))
      .where(
        and(
          inArray(clientAssignments.clientId, ids),
          eq(clientAssignments.role, 'primary'),
          isNull(clientAssignments.endedAt),
        ),
      ),
    db.query.clientStatusHistory.findMany({
      where: inArray(clientStatusHistory.clientId, ids),
      orderBy: [desc(clientStatusHistory.computedAt)],
      limit: 5000,
    }),
  ]);

  const num = (v: unknown): number => Number(v ?? 0) || 0;
  const group = <T>(rows: readonly T[], key: (r: T) => string | null) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const k = key(r);
      if (!k) continue;
      const arr = m.get(k) ?? [];
      arr.push(r);
      m.set(k, arr);
    }
    return m;
  };

  const periodsBy = group(periodRows, (p) => p.clientId);
  const docBy = new Map(docRows.map((r) => [r.clientId, r] as const));
  const questionBy = new Map(questionRows.map((r) => [r.clientId, r] as const));
  const intakeBy = new Map(intakeRows.map((r) => [r.clientId!, r] as const));
  const answerBy = new Map(answerRows.map((r) => [r.clientId, r] as const));
  const staleBy = new Map(staleRows.map((r) => [r.clientId, num(r.n)] as const));
  const behindBy = new Map(behindRows.map((r) => [r.clientId, num(r.n)] as const));
  const invoiceBy = new Map(invoiceRows.map((r) => [r.clientId, r] as const));
  const timeBy = new Map(timeRows.map((r) => [r.clientId, num(r.minutes)] as const));
  const inv90By = new Map(invoiced90Rows.map((r) => [r.clientId, num(r.cents)] as const));
  const primaryBy = new Map(assignmentRows.map((r) => [r.clientId, r] as const));
  const historyBy = group(historyRows, (h) => h.clientId);

  const msgBy = new Map<string, Date>();
  for (const r of clientMsgRows) {
    const at = asDate(r.last);
    if (!at) continue;
    const cur = msgBy.get(r.clientId);
    if (!cur || at > cur) msgBy.set(r.clientId, at);
  }

  // Rows arrive newest-first, so the first sighting of a thread is its last
  // message. Only a client-authored last message means we still owe a reply.
  const seenThreads = new Set<string>();
  const unansweredBy = new Map<string, number>();
  for (const r of unansweredRows) {
    if (seenThreads.has(r.threadId)) continue;
    seenThreads.add(r.threadId);
    if (r.role !== 'client') continue;
    const hours = (now.getTime() - r.at.getTime()) / 3_600_000;
    unansweredBy.set(r.clientId, Math.max(unansweredBy.get(r.clientId) ?? 0, hours));
  }

  const anomalyBy = new Map<string, { high: number; medium: number }>();
  for (const r of anomalyRows) {
    const cur = anomalyBy.get(r.clientId) ?? { high: 0, medium: 0 };
    if (r.severity === 'high') cur.high += num(r.n);
    if (r.severity === 'medium') cur.medium += num(r.n);
    anomalyBy.set(r.clientId, cur);
  }

  return clientRows.map((client) => {
    const doc = docBy.get(client.id);
    const q = questionBy.get(client.id);
    const askDates = [asDate(doc?.oldest ?? null), asDate(q?.oldest ?? null)].filter(
      (d): d is Date => d !== null,
    );
    const activity = [
      asDate(intakeBy.get(client.id)?.last ?? null),
      msgBy.get(client.id) ?? null,
      asDate(answerBy.get(client.id)?.last ?? null),
    ].filter((d): d is Date => d !== null);

    const overdue = invoiceBy.get(client.id);
    const oldestDue = asDate(overdue?.oldestDue ?? null);

    const primary = primaryBy.get(client.id);

    return {
      client,
      periods: periodsBy.get(client.id) ?? [],
      oldestOpenAskAt: askDates.length ? new Date(Math.min(...askDates.map((d) => d.getTime()))) : null,
      openAsks: num(doc?.n) + num(q?.n),
      lastClientActivityAt: activity.length
        ? new Date(Math.max(...activity.map((d) => d.getTime())))
        : null,
      staleTxns: staleBy.get(client.id) ?? 0,
      accountsBehind: behindBy.get(client.id) ?? 0,
      anomalyHigh: anomalyBy.get(client.id)?.high ?? 0,
      anomalyMedium: anomalyBy.get(client.id)?.medium ?? 0,
      unansweredHours: unansweredBy.get(client.id) ?? null,
      invoiceOverdueDays: oldestDue ? daysBetween(oldestDue, now) : null,
      effortMinutes90: timeBy.get(client.id) ?? 0,
      invoiced90Cents: inv90By.get(client.id) ?? 0,
      primaryUserId: primary?.userId ?? null,
      primaryName: primary?.name ?? null,
      history: historyBy.get(client.id) ?? [],
    } satisfies Facts;
  });
}

/* ========================================================================== */
/* The six dimensions                                                          */
/* ========================================================================== */

function monthName(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Every closed calendar month that started on or after activation and ended
 * before today. A month in this list with no `close_periods` row was skipped,
 * which §2 scores as red — it is the failure nobody notices until the year end.
 */
function expectedPeriodStarts(activatedAt: Date | null, now: Date): string[] {
  if (!activatedAt) return [];
  const out: string[] = [];
  let y = activatedAt.getUTCFullYear();
  let m = activatedAt.getUTCMonth();
  // The month of activation is only expected if the engagement began on the 1st.
  if (activatedAt.getUTCDate() > 1) m += 1;
  for (let i = 0; i < 24; i += 1) {
    const start = new Date(Date.UTC(y, m + i, 1));
    const end = new Date(Date.UTC(y, m + i + 1, 1));
    if (end.getTime() > now.getTime()) break;
    out.push(isoDay(start));
  }
  return out;
}

function scoreClose(f: Facts, t: Thresholds, now: Date): DimensionResult {
  const th = t['close_days_late']!;
  const base = { dimension: 'close' as const, label: DIMENSION_LABELS.close };

  const expected = expectedPeriodStarts(asDate(f.client.activatedAt), now);
  const haveStarts = new Set(f.periods.map((p) => String(p.periodStart)));
  const skipped = expected.filter((s) => !haveStarts.has(s));
  if (skipped.length > 0) {
    return {
      ...base,
      status: 'red',
      blockedBy: 'firm',
      reason: `The ${monthName(new Date(`${skipped[0]}T00:00:00Z`))} close was never opened${
        skipped.length > 1 ? `, and ${skipped.length - 1} more after it` : ''
      }. A skipped period is a red, not a backlog.`,
    };
  }

  const latest = f.periods[0];
  if (!latest) {
    return {
      ...base,
      status: 'green',
      blockedBy: 'none',
      reason: f.client.activatedAt
        ? 'No close is due yet — the engagement has not reached its first month end.'
        : 'Not activated, so no close target applies.',
    };
  }

  const target = asDate(latest.targetDate);
  const period = monthName(new Date(`${String(latest.periodStart)}T00:00:00Z`));
  if (!target) {
    return {
      ...base,
      status: 'green',
      blockedBy: 'none',
      reason: `The ${period} close is open with no target date set.`,
    };
  }

  if (latest.deliveredAt) {
    const late = daysBetween(target, latest.deliveredAt);
    if (late > th.redAt) {
      return {
        ...base,
        status: 'red',
        blockedBy: 'firm',
        reason: `The ${period} close was delivered ${plural(late, 'day')} past target.`,
      };
    }
    if (late >= th.yellowAt) {
      return {
        ...base,
        status: 'yellow',
        blockedBy: 'firm',
        reason: `The ${period} close was delivered ${plural(late, 'day')} past target.`,
      };
    }
    return {
      ...base,
      status: 'green',
      blockedBy: 'none',
      reason: `The ${period} close was delivered ${late === 0 ? 'on target' : `${plural(-late, 'day')} early`}.`,
    };
  }

  const late = daysBetween(target, now);
  if (late > th.redAt) {
    return {
      ...base,
      status: 'red',
      blockedBy: 'firm',
      reason: `The ${period} close is ${plural(late, 'day')} past target and still ${latest.status.replace('_', ' ')}.`,
    };
  }
  if (late >= th.yellowAt) {
    return {
      ...base,
      status: 'yellow',
      blockedBy: 'firm',
      reason: `The ${period} close is ${plural(late, 'day')} past target.`,
    };
  }
  return {
    ...base,
    status: 'green',
    blockedBy: 'none',
    reason:
      late === 0
        ? `The ${period} close is ${latest.status.replace('_', ' ')} and due today.`
        : `The ${period} close is ${latest.status.replace('_', ' ')}, due in ${plural(-late, 'day')}.`,
  };
}

function scoreResponsiveness(f: Facts, t: Thresholds, now: Date): DimensionResult {
  const age = t['responsiveness_request_age']!;
  const silence = t['responsiveness_silence']!;
  const base = { dimension: 'responsiveness' as const, label: DIMENSION_LABELS.responsiveness };

  const oldestDays = f.oldestOpenAskAt ? daysBetween(f.oldestOpenAskAt, now) : null;
  const silentDays = f.lastClientActivityAt
    ? daysBetween(f.lastClientActivityAt, now)
    : f.client.activatedAt
      ? daysBetween(asDate(f.client.activatedAt)!, now)
      : null;

  if (oldestDays !== null && oldestDays > age.redAt) {
    return {
      ...base,
      status: 'red',
      blockedBy: 'client',
      reason: `${plural(f.openAsks, 'thing')} outstanding with the client, the oldest for ${plural(oldestDays, 'day')}. We are blocked, not behind.`,
    };
  }
  if (silentDays !== null && silentDays > silence.redAt) {
    return {
      ...base,
      status: 'red',
      blockedBy: 'client',
      reason: `Nothing has arrived from the client in ${plural(silentDays, 'day')}.`,
    };
  }
  if (oldestDays !== null && oldestDays > age.yellowAt) {
    return {
      ...base,
      status: 'yellow',
      blockedBy: 'client',
      reason:
        oldestDays >= 14
          ? `${plural(f.openAsks, 'thing')} outstanding, the oldest for ${plural(oldestDays, 'day')} — past the point where chasing stops working and a phone call starts.`
          : `${plural(f.openAsks, 'thing')} outstanding, the oldest for ${plural(oldestDays, 'day')}.`,
    };
  }
  if (silentDays !== null && silentDays >= silence.yellowAt) {
    return {
      ...base,
      status: 'yellow',
      blockedBy: 'client',
      reason: `Quiet for ${plural(silentDays, 'day')} — worth a check-in before it becomes a problem.`,
    };
  }
  return {
    ...base,
    status: 'green',
    blockedBy: 'none',
    reason:
      f.openAsks === 0
        ? 'Nothing outstanding with the client.'
        : `${plural(f.openAsks, 'open item')}, none older than ${plural(age.yellowAt, 'day')}.`,
  };
}

function scoreBooks(f: Facts, t: Thresholds): DimensionResult {
  const stale = t['books_stale_txns']!;
  const behind = t['books_accounts_behind']!;
  const base = { dimension: 'books' as const, label: DIMENSION_LABELS.books };

  if (f.accountsBehind >= behind.redAt) {
    return {
      ...base,
      status: 'red',
      blockedBy: 'firm',
      reason: `${plural(f.accountsBehind, 'account')} carrying unreconciled activity from before this month — more than one period behind.`,
    };
  }
  if (f.staleTxns > stale.redAt) {
    return {
      ...base,
      status: 'red',
      blockedBy: 'firm',
      reason: `${plural(f.staleTxns, 'transaction')} over 30 days old with no category.`,
    };
  }
  if (f.accountsBehind >= behind.yellowAt) {
    return {
      ...base,
      status: 'yellow',
      blockedBy: 'firm',
      reason: `One account is behind on reconciliation${f.staleTxns > 0 ? `, and ${plural(f.staleTxns, 'transaction')} are stale` : ''}.`,
    };
  }
  if (f.staleTxns >= stale.yellowAt) {
    return {
      ...base,
      status: 'yellow',
      blockedBy: 'firm',
      reason: `${plural(f.staleTxns, 'transaction')} over 30 days old with no category.`,
    };
  }
  return {
    ...base,
    status: 'green',
    blockedBy: 'none',
    reason:
      f.staleTxns === 0
        ? 'Everything reconciled, nothing stale.'
        : `Reconciled, with ${plural(f.staleTxns, 'transaction')} still to categorise.`,
  };
}

function scoreRisk(f: Facts, t: Thresholds): DimensionResult {
  const th = t['risk_open_anomalies']!;
  const base = { dimension: 'risk' as const, label: DIMENSION_LABELS.risk };

  if (f.anomalyHigh >= th.redAt) {
    return {
      ...base,
      status: 'red',
      blockedBy: 'firm',
      reason: `${plural(f.anomalyHigh, 'unresolved high-severity anomaly', 'unresolved high-severity anomalies')} — duplicate payments and missing deposits do not wait.`,
    };
  }
  if (f.anomalyMedium >= th.yellowAt) {
    return {
      ...base,
      status: 'yellow',
      blockedBy: 'firm',
      reason: `${plural(f.anomalyMedium, 'unresolved medium anomaly', 'unresolved medium anomalies')} waiting on a decision.`,
    };
  }
  return { ...base, status: 'green', blockedBy: 'none', reason: 'No unresolved anomalies.' };
}

function scoreRelationship(f: Facts, t: Thresholds): DimensionResult {
  const th = t['relationship_reply_hours']!;
  const base = { dimension: 'relationship' as const, label: DIMENSION_LABELS.relationship };
  const hours = f.unansweredHours;

  if (hours === null) {
    return {
      ...base,
      status: 'green',
      blockedBy: 'none',
      reason: 'No message is waiting on us.',
    };
  }
  const rounded = Math.round(hours);
  if (hours >= th.redAt) {
    return {
      ...base,
      status: 'red',
      blockedBy: 'firm',
      reason: `A client message has gone ${plural(rounded, 'hour')} without a reply. At this point it is an escalation, not a delay.`,
    };
  }
  if (hours >= th.yellowAt) {
    return {
      ...base,
      status: 'yellow',
      blockedBy: 'firm',
      reason: `A client message has been waiting ${plural(rounded, 'hour')}, past the ${th.yellowAt}-hour internal target.`,
    };
  }
  return {
    ...base,
    status: 'green',
    blockedBy: 'none',
    reason: `Messages answered inside the ${th.yellowAt}-hour target.`,
  };
}

function scoreCommercial(
  f: Facts,
  t: Thresholds,
  effortPct: number | null,
): DimensionResult {
  const inv = t['commercial_invoice_overdue_days']!;
  const eff = t['commercial_effort_pct']!;
  const base = { dimension: 'commercial' as const, label: DIMENSION_LABELS.commercial };
  const overdue = f.invoiceOverdueDays;

  if (overdue !== null && overdue > inv.redAt) {
    return {
      ...base,
      status: 'red',
      blockedBy: 'client',
      reason: `An invoice is ${plural(overdue, 'day')} overdue. With payment on file this should not happen.`,
    };
  }
  if (effortPct !== null && effortPct >= eff.redAt) {
    return {
      ...base,
      status: 'red',
      blockedBy: 'firm',
      reason: `Effort is running at ${effortPct}% of the fee. This engagement needs repricing or rescoping, not more hours.`,
    };
  }
  if (overdue !== null && overdue >= inv.yellowAt) {
    return {
      ...base,
      status: 'yellow',
      blockedBy: 'client',
      reason: `An invoice is ${plural(overdue, 'day')} overdue.`,
    };
  }
  if (effortPct !== null && effortPct >= eff.yellowAt) {
    return {
      ...base,
      status: 'yellow',
      blockedBy: 'firm',
      reason: `Effort is running at ${effortPct}% of the fee — worth a scope conversation.`,
    };
  }
  return {
    ...base,
    status: 'green',
    blockedBy: 'none',
    reason:
      effortPct === null
        ? 'Invoices current; no fee on record yet to measure effort against.'
        : `Invoices current, effort at ${effortPct}% of the fee.`,
  };
}

/* ========================================================================== */
/* Rolling up                                                                  */
/* ========================================================================== */

export function worstOf(dims: readonly DimensionResult[]): Rag {
  return dims.reduce<Rag>((worst, d) => (RANK[d.status] > RANK[worst] ? d.status : worst), 'green');
}

function trendFrom(
  history: readonly (typeof clientStatusHistory.$inferSelect)[],
  current: Rag,
  now: Date,
): Trend {
  if (history.length === 0) return 'new';
  const cutoff = now.getTime() - 30 * MS_PER_DAY;
  // History is newest-first. The status 30 days ago is the newest row at or
  // before the cutoff; with nothing that old, the oldest row we have.
  const past = history.find((h) => h.computedAt.getTime() <= cutoff) ?? history[history.length - 1]!;
  const then = past.status as Rag;
  if (RANK[current] < RANK[then]) return 'improving';
  if (RANK[current] > RANK[then]) return 'degrading';
  return 'stable';
}

/**
 * Score one client from pre-loaded facts. Pure apart from the clock, which is
 * passed in — the same facts and the same `now` always produce the same colour.
 */
export function scoreFrom(f: Facts, t: Thresholds, now: Date): ClientHealth {
  const effortCents90 = Math.round((f.effortMinutes90 / 60) * STAFF_COST_PER_HOUR_CENTS);
  const feeCents90 = f.client.monthlyFeeCents ? f.client.monthlyFeeCents * 3 : f.invoiced90Cents;
  const effortPct = feeCents90 > 0 ? Math.round((effortCents90 / feeCents90) * 100) : null;

  const dimensions: DimensionResult[] = [
    scoreClose(f, t, now),
    scoreResponsiveness(f, t, now),
    scoreBooks(f, t),
    scoreRisk(f, t),
    scoreRelationship(f, t),
    scoreCommercial(f, t, effortPct),
  ];

  // Worst dimension wins. Where several tie at the worst colour, the first in
  // the documented order names the reason and owns `blockedBy` — so a firm-side
  // failure is never hidden behind a client-side one, or the reverse.
  const status = worstOf(dimensions);
  const driver = dimensions.find((d) => d.status === status)!;
  const alsoAtWorst = dimensions.filter((d) => d.status === status && d !== driver);

  const latest = f.periods[0];
  const target = latest ? asDate(latest.targetDate) : null;

  const lastHistory = f.history[0];
  const statusSince =
    lastHistory && (lastHistory.status as Rag) === status ? lastHistory.computedAt : null;

  return {
    clientId: f.client.id,
    businessName: f.client.businessName,
    clientStatus: f.client.status,
    status,
    blockedBy: status === 'green' ? 'none' : driver.blockedBy,
    reason:
      alsoAtWorst.length > 0
        ? `${driver.reason} Also ${status}: ${alsoAtWorst.map((d) => d.label.toLowerCase()).join(', ')}.`
        : driver.reason,
    dimensions,
    trend: trendFrom(f.history, status, now),
    timeInStatusDays: statusSince ? daysBetween(statusSince, now) : null,
    statusSince,
    daysToClose: target && !latest?.deliveredAt ? daysBetween(now, target) : null,
    closeTargetDate: target,
    primaryUserId: f.primaryUserId,
    primaryName: f.primaryName,
    plan: f.client.plan,
    monthlyFeeCents: f.client.monthlyFeeCents,
    effortMinutes90: f.effortMinutes90,
    effortCents90,
    feeCents90,
    effortPct,
  };
}

/** Health for every engaged client, in a bounded number of queries. */
export async function computeAll(now = new Date()): Promise<ClientHealth[]> {
  await ensureThresholds();
  const [facts, thresholds] = await Promise.all([loadFacts(now), loadThresholds()]);
  return facts.map((f) => scoreFrom(f, thresholds, now));
}

/** Health for one client. Null when the client is not an active engagement. */
export async function computeFor(clientId: string, now = new Date()): Promise<ClientHealth | null> {
  const all = await computeAll(now);
  return all.find((h) => h.clientId === clientId) ?? null;
}

/** Recorded transitions, newest first — the "what happened when" trail. */
export async function historyFor(clientId: string, limit = 50) {
  return db.query.clientStatusHistory.findMany({
    where: eq(clientStatusHistory.clientId, clientId),
    orderBy: [desc(clientStatusHistory.computedAt)],
    limit,
  });
}
