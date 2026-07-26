/**
 * Alerts — raised on TRANSITION, delivered on the firm's terms.
 *
 * OVERSIGHT-AND-PERFORMANCE.md §4 and DECISIONS.md §8 between them fix three
 * rules that this module exists to enforce, and that nothing else in the system
 * is allowed to work around:
 *
 * 1. **Alerting on a state fires forever; alerting on a change fires once.**
 *    This module does not decide *when* something changed — `statusTransitions`
 *    does — but it does the deduplication that makes a repeated `raise()` from
 *    a nightly job idempotent: an open alert of the same kind, for the same
 *    client, for the same person, is the alert, not a second one.
 *
 * 2. **Nothing wakes anyone for bookkeeping.** Quiet hours are 7pm–7am CT and
 *    all weekend. Anything raised inside them is stamped with a `deliverAfter`
 *    of the next 8am CT *business* morning. Friday at 8pm and Saturday at 6am
 *    both land on Monday at 8am.
 *
 * 3. **Two exceptions, and they are not bookkeeping alerts.** A kind beginning
 *    `security.` or `fraud.` delivers immediately, at any hour, on any day.
 *    Those are time-sensitive and actionable; a red client at 2am is neither.
 *
 * The quiet-hours arithmetic is done against the IANA zone `America/Chicago`
 * rather than a fixed offset, so it stays correct across the DST boundary
 * without anybody remembering to change a constant in March.
 */

import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { alertPreferences, alerts, clients, users } from '../db/schema.js';
import { visibleClientIds } from '../auth/scope.js';
import type { SessionUser } from '../auth/session.js';

export type AlertMode = 'immediate' | 'digest' | 'off';
export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'open' | 'acknowledged' | 'resolved' | 'superseded';
export type AlertRow = typeof alerts.$inferSelect;

/* ========================================================================== */
/* Central time, computed properly                                             */
/* ========================================================================== */

export const CT_ZONE = 'America/Chicago';

/** Business day starts at 7am CT. Before it, nothing is delivered. */
export const BUSINESS_START_HOUR = 7;
/** Business day ends at 7pm CT. After it, nothing is delivered. */
export const BUSINESS_END_HOUR = 19;
/** Everything queued overnight lands at 8am CT (§4 "digest daily at 8am CT"). */
export const DIGEST_HOUR = 8;

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const CT_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: CT_ZONE,
  hourCycle: 'h23',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export interface CtParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 0 = Sunday. */
  readonly weekday: number;
}

/** The wall-clock reading in Chicago at this instant. */
export function ctParts(d: Date): CtParts {
  const out: Record<string, string> = {};
  for (const p of CT_FORMAT.formatToParts(d)) out[p.type] = p.value;
  return {
    year: Number(out['year']),
    month: Number(out['month']),
    day: Number(out['day']),
    hour: Number(out['hour']),
    minute: Number(out['minute']),
    second: Number(out['second']),
    weekday: WEEKDAY_INDEX[out['weekday'] ?? 'Mon'] ?? 1,
  };
}

/** Chicago's UTC offset at this instant, in milliseconds (negative). */
function ctOffsetMs(d: Date): number {
  const p = ctParts(d);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/**
 * The instant at which Chicago's wall clock reads the given date and time.
 * Two refinement passes settle the DST case, where the offset used to build the
 * guess differs from the offset that actually applies at the result.
 */
export function ctInstant(year: number, month: number, day: number, hour: number, minute = 0): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = new Date(wall);
  for (let i = 0; i < 3; i += 1) guess = new Date(wall - ctOffsetMs(guess));
  return guess;
}

export function isCtWeekend(d: Date): boolean {
  const w = ctParts(d).weekday;
  return w === 0 || w === 6;
}

/** 7pm–7am CT, plus the whole weekend (DECISIONS.md §8). */
export function isQuietHours(d: Date): boolean {
  if (isCtWeekend(d)) return true;
  const h = ctParts(d).hour;
  return h < BUSINESS_START_HOUR || h >= BUSINESS_END_HOUR;
}

/** True while Chicago is inside a working weekday, 7am–7pm. */
export function isBusinessHours(d: Date): boolean {
  return !isQuietHours(d);
}

function ctDayShift(d: Date, days: number, hour: number): Date {
  const p = ctParts(d);
  // Date.UTC normalises day overflow, so month and year roll on their own.
  return ctInstant(p.year, p.month, p.day + days, hour, 0);
}

/**
 * The next 8am CT that is a business morning.
 *
 * 2am Tuesday → Tuesday 8am. 8pm Tuesday → Wednesday 8am. Any time Saturday or
 * Sunday → Monday 8am. Friday evening → Monday 8am.
 */
export function nextBusinessMorning(now: Date): Date {
  let candidate = ctDayShift(now, 0, DIGEST_HOUR);
  if (candidate.getTime() <= now.getTime()) candidate = ctDayShift(candidate, 1, DIGEST_HOUR);
  let guard = 0;
  while (isCtWeekend(candidate) && guard < 8) {
    candidate = ctDayShift(candidate, 1, DIGEST_HOUR);
    guard += 1;
  }
  return candidate;
}

/* ========================================================================== */
/* Routing                                                                     */
/* ========================================================================== */

/**
 * The only two families that may interrupt a human out of hours, and neither is
 * a bookkeeping alert (DECISIONS.md §8): a security event, or a fraud/payment
 * signal on the firm's own Stripe account.
 */
export function isImmediateKind(kind: string): boolean {
  return kind.startsWith('security.') || kind.startsWith('fraud.');
}

/**
 * Defaults when the user has expressed no preference: digest, except for the
 * handful of kinds §4 names as immediate — red transitions and missed closes.
 */
const IMMEDIATE_BY_DEFAULT = new Set([
  'health.red',
  'health.red_7d',
  'close.missed',
  'client.silent',
]);

export function defaultModeFor(kind: string): AlertMode {
  if (isImmediateKind(kind)) return 'immediate';
  return IMMEDIATE_BY_DEFAULT.has(kind) ? 'immediate' : 'digest';
}

/** A user's routing choice for a kind: exact row, then `*`, then the default. */
export async function modeFor(userId: string, kind: string): Promise<AlertMode> {
  const rows = await db
    .select({ kind: alertPreferences.kind, mode: alertPreferences.mode })
    .from(alertPreferences)
    .where(and(eq(alertPreferences.userId, userId), inArray(alertPreferences.kind, [kind, '*'])));
  const exact = rows.find((r) => r.kind === kind);
  const wildcard = rows.find((r) => r.kind === '*');
  return (exact?.mode ?? wildcard?.mode ?? defaultModeFor(kind)) as AlertMode;
}

/**
 * When this alert may be shown to a human.
 *
 * Immediate kinds: now, whatever the clock says. Immediate mode inside business
 * hours: now. Everything else — digest mode, or immediate mode during quiet
 * hours — the next 8am CT business morning.
 */
export function deliverAfterFor(kind: string, mode: AlertMode, now: Date): Date {
  if (isImmediateKind(kind)) return now;
  if (mode === 'immediate' && isBusinessHours(now)) return now;
  return nextBusinessMorning(now);
}

/* ========================================================================== */
/* raise / acknowledge / resolve                                               */
/* ========================================================================== */

export interface RaiseInput {
  readonly kind: string;
  readonly severity?: AlertSeverity;
  readonly clientId?: string | null;
  /** Who should act. Null means firm-wide, which in practice means the admin. */
  readonly userId?: string | null;
  readonly title: string;
  readonly detail?: string | null;
  readonly actionUrl?: string | null;
  /** Test/job seam. Defaults to the wall clock. */
  readonly now?: Date;
}

/**
 * Raise an alert, or return the open one that already says this.
 *
 * Deduplication is on **kind + client + recipient**, not on kind + client
 * alone. The alert table routes the same event to a bookkeeper *and* to the
 * admin as two rows precisely so each can acknowledge their own; collapsing
 * them would mean whichever row was written second silently vanished. Within
 * one recipient, a second open alert of the same kind about the same client is
 * noise, and noise is the documented failure mode.
 *
 * An **acknowledged** alert suppresses a re-raise just as an open one does.
 * Acknowledging means "seen, and mine" — if a nightly sweep produced a fresh
 * copy of everything already owned, the inbox would refill every morning with
 * things somebody had explicitly picked up, which is exactly the fatigue §4
 * says is the failure mode. `resolve()` is the action that says "done — tell
 * me again if it comes back".
 *
 * Returns null when the recipient has this kind switched off.
 */
export async function raise(input: RaiseInput): Promise<AlertRow | null> {
  return (await raiseDetailed(input)).alert;
}

export interface RaiseOutcome {
  /** The alert that now stands — freshly written, or the one already open. */
  readonly alert: AlertRow | null;
  /** False when this call deduplicated onto an existing alert. */
  readonly created: boolean;
}

/**
 * {@link raise}, but saying whether a row was actually written.
 *
 * Callers that report "N alerts raised" need this: a deduplicated call still
 * returns the alert, and counting it would make an idempotent nightly run look
 * like it had produced new work every time it ran.
 */
export async function raiseDetailed(input: RaiseInput): Promise<RaiseOutcome> {
  const now = input.now ?? new Date();
  const userId = input.userId ?? null;
  const clientId = input.clientId ?? null;

  const mode = userId ? await modeFor(userId, input.kind) : defaultModeFor(input.kind);
  if (mode === 'off') return { alert: null, created: false };

  const existing = await db.query.alerts.findFirst({
    where: and(
      eq(alerts.kind, input.kind),
      inArray(alerts.status, ['open', 'acknowledged']),
      clientId === null ? isNull(alerts.clientId) : eq(alerts.clientId, clientId),
      userId === null ? isNull(alerts.userId) : eq(alerts.userId, userId),
    ),
  });
  if (existing) return { alert: existing, created: false };

  const [row] = await db
    .insert(alerts)
    .values({
      kind: input.kind,
      severity: input.severity ?? 'warning',
      clientId,
      userId,
      title: input.title.slice(0, 200),
      detail: input.detail ?? null,
      actionUrl: input.actionUrl ?? null,
      status: 'open',
      deliverAfter: deliverAfterFor(input.kind, mode, now),
      createdAt: now,
    })
    .returning();
  return { alert: row ?? null, created: Boolean(row) };
}

/** Someone has seen it and owns it. Returns null when it is not theirs to take. */
export async function acknowledge(id: string, userId: string): Promise<AlertRow | null> {
  const [row] = await db
    .update(alerts)
    .set({ status: 'acknowledged', acknowledgedBy: userId, acknowledgedAt: new Date() })
    .where(and(eq(alerts.id, id), inArray(alerts.status, ['open', 'acknowledged'])))
    .returning();
  return row ?? null;
}

/** The underlying problem is gone. */
export async function resolve(id: string): Promise<AlertRow | null> {
  const [row] = await db
    .update(alerts)
    .set({ status: 'resolved', resolvedAt: new Date() })
    .where(and(eq(alerts.id, id), inArray(alerts.status, ['open', 'acknowledged'])))
    .returning();
  return row ?? null;
}

/** Stamp alerts as delivered — the nightly digest's record of what it sent. */
export async function markDelivered(ids: readonly string[], now = new Date()): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(alerts)
    .set({ deliveredAt: now })
    .where(and(inArray(alerts.id, [...ids]), isNull(alerts.deliveredAt)))
    .returning({ id: alerts.id });
  return rows.length;
}

/* ========================================================================== */
/* Reading — always through the scope helpers                                  */
/* ========================================================================== */

export interface AlertView extends AlertRow {
  readonly clientName: string | null;
  readonly ownerName: string | null;
  /** False while the alert is still held behind quiet hours. */
  readonly deliverable: boolean;
}

function decorate(
  rows: readonly { alert: AlertRow; clientName: string | null; ownerName: string | null }[],
  now: Date,
): AlertView[] {
  return rows.map((r) => ({
    ...r.alert,
    clientName: r.clientName,
    ownerName: r.ownerName,
    deliverable: !r.alert.deliverAfter || r.alert.deliverAfter.getTime() <= now.getTime(),
  }));
}

/**
 * The alert inbox for one person.
 *
 * **A staff user never sees an alert about a client they are not assigned to.**
 * The client set comes from `auth/scope.ts` — this module does not build its
 * own filter — and a staff user with no assignments sees nothing rather than
 * everything. An admin sees the firm's alerts, including firm-wide rows with no
 * named owner.
 */
export async function inboxFor(
  user: SessionUser,
  opts: { statuses?: readonly AlertStatus[]; limit?: number; now?: Date } = {},
): Promise<AlertView[]> {
  const now = opts.now ?? new Date();
  const statuses = opts.statuses ?? (['open', 'acknowledged'] as const);

  const base = db
    .select({ alert: alerts, clientName: clients.businessName, ownerName: users.name })
    .from(alerts)
    .leftJoin(clients, eq(clients.id, alerts.clientId))
    .leftJoin(users, eq(users.id, alerts.userId))
    .$dynamic();

  if (user.role === 'admin') {
    const rows = await base
      .where(inArray(alerts.status, [...statuses]))
      .orderBy(desc(alerts.severity), desc(alerts.createdAt))
      .limit(opts.limit ?? 200);
    return decorate(rows, now);
  }

  const ids = await visibleClientIds(user);
  // ids === null cannot happen for staff, but fail closed rather than assume.
  const scoped =
    ids === null || ids.length === 0
      ? (sql`false` as never)
      : or(isNull(alerts.clientId), inArray(alerts.clientId, ids))!;

  const rows = await base
    .where(and(eq(alerts.userId, user.id), inArray(alerts.status, [...statuses]), scoped))
    .orderBy(desc(alerts.createdAt))
    .limit(opts.limit ?? 200);
  return decorate(rows, now);
}

export interface Digest {
  readonly userId: string;
  /** Past their `deliver_after` — these are the ones an 8am email would carry. */
  readonly due: readonly AlertView[];
  /** Still held behind quiet hours. */
  readonly held: readonly AlertView[];
}

/**
 * What this user's next digest contains.
 *
 * Scoped exactly like {@link inboxFor}: a bookkeeper's digest cannot mention a
 * client they are not assigned to, because the client set is resolved through
 * `visibleClientIds` and not through anything this module invents.
 */
export async function digestFor(userId: string, now = new Date()): Promise<Digest> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return { userId, due: [], held: [] };

  const all = await inboxFor(user, { statuses: ['open'], now });
  return {
    userId,
    due: all.filter((a) => a.deliverable),
    held: all.filter((a) => !a.deliverable),
  };
}

/** Everything past its hold time and never delivered — the job's work list. */
export async function pendingDelivery(now = new Date()): Promise<AlertRow[]> {
  return db.query.alerts.findMany({
    where: and(
      eq(alerts.status, 'open'),
      isNull(alerts.deliveredAt),
      or(isNull(alerts.deliverAfter), lte(alerts.deliverAfter, now)),
    ),
    orderBy: [desc(alerts.createdAt)],
    limit: 1000,
  });
}

/** Counts for the inbox header, computed from the same scoped read. */
export function summarise(rows: readonly AlertView[]) {
  return {
    total: rows.length,
    critical: rows.filter((r) => r.severity === 'critical').length,
    open: rows.filter((r) => r.status === 'open').length,
    acknowledged: rows.filter((r) => r.status === 'acknowledged').length,
    held: rows.filter((r) => !r.deliverable).length,
  };
}
