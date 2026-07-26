/**
 * Status transitions — the thing that turns a colour into a decision.
 *
 * OVERSIGHT-AND-PERFORMANCE.md §4 opens with the rule this module exists for:
 *
 * > **Triggered on transition, not on state.** Alerting on "is red" fires
 * > forever; alerting on "turned red" fires once and demands a decision.
 *
 * So the flow is: compute health for every engaged client, compare each to the
 * newest row in `client_status_history`, **write a row only when the colour
 * changed**, and raise alerts off the change rather than off the state.
 *
 * Writing only on change is what makes "time in status" honest. A row per night
 * would make every client look like it changed yesterday, which is precisely
 * the distinction §2 says matters: *"a client sitting in yellow for six weeks
 * is a different problem from one that turned yellow yesterday."*
 *
 * The two duration-based alerts — red for more than 7 days, and a client silent
 * for more than 21 days — are the deliberate exceptions. They are not state
 * alerts in disguise: crossing the duration boundary *is* the transition, and
 * `alerts.raise()` deduplicates against the open alert so they fire once and
 * then stay quiet until somebody resolves them.
 *
 * Everything is safe to run repeatedly. Two runs an hour apart with no
 * underlying change write nothing and raise nothing.
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  alerts,
  clientAssignments,
  clientStatusHistory,
  clients,
  intakeItems,
  users,
} from '../db/schema.js';
import { computeAll, type ClientHealth, type Rag } from './clientHealth.js';
import { raiseDetailed } from './alerts.js';
import { audit } from '../lib/audit.js';

const MS_PER_DAY = 86_400_000;

/** §4: a client red for longer than this escalates to the admin. */
export const RED_ESCALATION_DAYS = 7;
/** §2/§4: silence past this is a red and an immediate alert. */
export const SILENCE_ALERT_DAYS = 21;
/** §4: quarantined intake older than this reaches the bookkeeper by digest. */
export const QUARANTINE_ALERT_HOURS = 48;

export interface Transition {
  readonly clientId: string;
  readonly businessName: string;
  readonly from: Rag | null;
  readonly to: Rag;
  readonly blockedBy: string;
  readonly reason: string;
}

export interface SweepResult {
  readonly evaluated: number;
  readonly transitions: readonly Transition[];
  readonly alertsRaised: number;
  readonly at: Date;
}

/** Admin recipients — the people who get the firm-wide half of every alert. */
async function adminIds(): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.disabled, false)));
  return rows.map((r) => r.id);
}

/** Everyone with a live assignment to this client, in any capacity. */
async function assigneeIds(clientId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: clientAssignments.userId })
    .from(clientAssignments)
    .where(and(eq(clientAssignments.clientId, clientId), isNull(clientAssignments.endedAt)));
  return [...new Set(rows.map((r) => r.userId))];
}

/**
 * One sweep: recompute, record what changed, alert on the changes.
 *
 * `now` is injected so the nightly job and a manual recompute can be replayed
 * against a fixed clock without the results drifting underneath a test.
 */
export async function sweep(now = new Date()): Promise<SweepResult> {
  const health = await computeAll(now);
  const transitions: Transition[] = [];
  let alertsRaised = 0;

  const admins = await adminIds();

  for (const h of health) {
    const previous = await db.query.clientStatusHistory.findFirst({
      where: eq(clientStatusHistory.clientId, h.clientId),
      orderBy: [desc(clientStatusHistory.computedAt)],
    });
    const from = (previous?.status as Rag | undefined) ?? null;

    if (from !== h.status) {
      await db.insert(clientStatusHistory).values({
        clientId: h.clientId,
        status: h.status,
        previousStatus: from,
        dimensions: h.dimensions.map((d) => ({
          dimension: d.dimension,
          status: d.status,
          blockedBy: d.blockedBy,
        })),
        reasons: h.dimensions.map((d) => ({ dimension: d.dimension, reason: d.reason })),
        blockedBy: h.blockedBy,
        computedAt: now,
      });

      transitions.push({
        clientId: h.clientId,
        businessName: h.businessName,
        from,
        to: h.status,
        blockedBy: h.blockedBy,
        reason: h.reason,
      });

      await audit(null, {
        action: 'health.transition',
        clientId: h.clientId,
        entity: 'client',
        entityId: h.clientId,
        meta: { from, to: h.status, blockedBy: h.blockedBy, reason: h.reason },
      });

      alertsRaised += await alertOnTransition(h, from, admins, now);
    }

    alertsRaised += await alertOnDuration(h, previous ?? null, admins, now);
  }

  alertsRaised += await alertOnQuarantine(now);

  return { evaluated: health.length, transitions, alertsRaised, at: now };
}

/**
 * The alert table from §4, transcribed.
 *
 * | Event | Who is told | How |
 * |---|---|---|
 * | Green → Yellow | bookkeeper + admin | digest |
 * | Yellow → Red (any → red) | bookkeeper **and** admin | immediate |
 * | Any → Green | both | digest — recoveries deserve visibility too |
 * | Close target missed | bookkeeper + admin | immediate |
 * | Client silent >21 days | bookkeeper + admin | immediate |
 * | Invoice >30 days overdue | admin only | digest |
 *
 * "How" is expressed as the alert *kind*, because routing is the alert
 * service's decision and honours each recipient's own preference. The kinds
 * §4 marks immediate are the ones `alerts.defaultModeFor` treats as immediate.
 */
async function alertOnTransition(
  h: ClientHealth,
  from: Rag | null,
  admins: readonly string[],
  now: Date,
): Promise<number> {
  const assignees = await assigneeIds(h.clientId);
  const both = [...new Set([...assignees, ...admins])];
  const actionUrl = `/workspace/client/${h.clientId}`;
  let n = 0;

  const fanOut = async (
    recipients: readonly string[],
    kind: string,
    severity: 'info' | 'warning' | 'critical',
    title: string,
  ) => {
    for (const userId of recipients) {
      const { created } = await raiseDetailed({
        kind,
        severity,
        clientId: h.clientId,
        userId,
        title,
        detail: `${h.reason} Blocked by: ${h.blockedBy}.`,
        actionUrl,
        now,
      });
      if (created) n += 1;
    }
  };

  if (h.status === 'red') {
    await fanOut(both, 'health.red', 'critical', `${h.businessName} turned red`);
    // A red client gets a reviewer on principle (DECISIONS.md §4); flag it to
    // the admin as an action rather than leaving it to be noticed.
    for (const admin of admins) {
      const { created } = await raiseDetailed({
        kind: 'health.red_needs_reviewer',
        severity: 'warning',
        clientId: h.clientId,
        userId: admin,
        title: `${h.businessName} is red — add a reviewer`,
        detail: 'Every client in red gets a reviewer on the close until it recovers.',
        actionUrl: `/admin/portfolio?client=${h.clientId}`,
        now,
      });
      if (created) n += 1;
    }
  } else if (h.status === 'yellow') {
    await fanOut(both, 'health.yellow', 'warning', `${h.businessName} turned yellow`);
  } else if (from !== null) {
    await fanOut(both, 'health.recovered', 'info', `${h.businessName} is back to green`);
    // The recovery is the resolution of whatever red or yellow raised before.
    await db
      .update(alerts)
      .set({ status: 'resolved', resolvedAt: now })
      .where(
        and(
          eq(alerts.clientId, h.clientId),
          inArray(alerts.kind, ['health.red', 'health.yellow', 'health.red_7d', 'health.red_needs_reviewer']),
          inArray(alerts.status, ['open', 'acknowledged']),
        ),
      );
  }

  // Close target missed — its own alert, because it is actionable in a way the
  // aggregate colour is not.
  const closeDim = h.dimensions.find((d) => d.dimension === 'close');
  if (closeDim && closeDim.status !== 'green') {
    await fanOut(both, 'close.missed', 'critical', `${h.businessName}: close target missed`);
  }

  return n;
}

/**
 * The duration-based rows of the table. Crossing the boundary is the event;
 * `raise()`'s dedupe is what stops it becoming a state alert.
 */
async function alertOnDuration(
  h: ClientHealth,
  previous: typeof clientStatusHistory.$inferSelect | null,
  admins: readonly string[],
  now: Date,
): Promise<number> {
  let n = 0;

  if (h.status === 'red' && previous && previous.status === 'red') {
    const days = Math.floor((now.getTime() - previous.computedAt.getTime()) / MS_PER_DAY);
    if (days >= RED_ESCALATION_DAYS) {
      for (const admin of admins) {
        const { created } = await raiseDetailed({
          kind: 'health.red_7d',
          severity: 'critical',
          clientId: h.clientId,
          userId: admin,
          title: `${h.businessName} has been red for ${days} days`,
          detail: `${h.reason} Blocked by: ${h.blockedBy}. This is no longer a bookkeeping problem — it needs a decision.`,
          actionUrl: `/admin/portfolio?client=${h.clientId}`,
          now,
        });
        if (created) n += 1;
      }
    }
  }

  const responsiveness = h.dimensions.find((d) => d.dimension === 'responsiveness');
  if (responsiveness?.status === 'red' && /arrived from the client/.test(responsiveness.reason)) {
    const both = [...new Set([...(await assigneeIds(h.clientId)), ...admins])];
    for (const userId of both) {
      const { created } = await raiseDetailed({
        kind: 'client.silent',
        severity: 'critical',
        clientId: h.clientId,
        userId,
        title: `${h.businessName} has gone quiet`,
        detail: responsiveness.reason,
        actionUrl: `/workspace/client/${h.clientId}`,
        now,
      });
      if (created) n += 1;
    }
  }

  const commercial = h.dimensions.find((d) => d.dimension === 'commercial');
  if (commercial?.status === 'red' && commercial.blockedBy === 'client') {
    // Admin only, by digest. A bookkeeper cannot collect a debt and should not
    // be asked to carry the knowledge that their client has not paid.
    for (const admin of admins) {
      const { created } = await raiseDetailed({
        kind: 'invoice.overdue',
        severity: 'warning',
        clientId: h.clientId,
        userId: admin,
        title: `${h.businessName}: invoice more than 30 days overdue`,
        detail: commercial.reason,
        actionUrl: `/admin/clients/${h.clientId}`,
        now,
      });
      if (created) n += 1;
    }
  }

  return n;
}

/** Quarantined intake older than 48h reaches the bookkeeper by digest (§4). */
async function alertOnQuarantine(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - QUARANTINE_ALERT_HOURS * 3_600_000);
  const [row] = await db
    .select({ n: sql<string>`count(*)` })
    .from(intakeItems)
    .where(
      and(
        eq(intakeItems.status, 'quarantined'),
        isNull(intakeItems.clientId),
        sql`${intakeItems.receivedAt} < ${cutoff}`,
      ),
    );
  const count = Number(row?.n ?? 0);
  if (count === 0) return 0;

  // Nobody owns an unidentified sender, so it goes to everyone firm-side who
  // could place it. No client id: there is no client to leak.
  const staff = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.role, ['staff', 'admin']), eq(users.disabled, false)));

  let n = 0;
  for (const s of staff) {
    const { created } = await raiseDetailed({
      kind: 'intake.quarantine',
      severity: 'warning',
      clientId: null,
      userId: s.id,
      title: `${count} quarantined item${count === 1 ? '' : 's'} older than 48 hours`,
      detail: 'Something arrived from a sender we could not name. Nothing is guessed onto a client.',
      actionUrl: '/admin/quarantine',
      now,
    });
    if (created) n += 1;
  }
  return n;
}

/* ========================================================================== */
/* Read models                                                                 */
/* ========================================================================== */

export interface StatusHistoryRow {
  readonly id: string;
  readonly clientId: string;
  readonly businessName: string;
  readonly status: Rag;
  readonly previousStatus: Rag | null;
  readonly blockedBy: string;
  readonly computedAt: Date;
  readonly reasons: readonly { dimension: string; reason: string }[];
}

/** Recent transitions across the firm — "who knew what, when". */
export async function recentTransitions(limit = 50): Promise<StatusHistoryRow[]> {
  const rows = await db
    .select({ h: clientStatusHistory, businessName: clients.businessName })
    .from(clientStatusHistory)
    .innerJoin(clients, eq(clients.id, clientStatusHistory.clientId))
    .orderBy(desc(clientStatusHistory.computedAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.h.id,
    clientId: r.h.clientId,
    businessName: r.businessName,
    status: r.h.status as Rag,
    previousStatus: r.h.previousStatus as Rag | null,
    blockedBy: r.h.blockedBy,
    computedAt: r.h.computedAt,
    reasons: Array.isArray(r.h.reasons)
      ? (r.h.reasons as { dimension: string; reason: string }[])
      : [],
  }));
}
