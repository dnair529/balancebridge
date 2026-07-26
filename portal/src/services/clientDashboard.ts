/**
 * The three numbers a business owner actually wants, and the capture feed.
 *
 * CLIENT-PLATFORM-STRATEGY.md §1 is blunt about this: "Owners don't want
 * reports — they want answers and confidence." So the mobile home is not a
 * dashboard of widgets. It is three facts in big type:
 *
 *   1. **Cash on hand** — derived from the ledger, not remembered.
 *   2. **13-week runway** — the rolling forecast behind "can I make payroll?"
 *   3. **What we need from you** — one number, and it should be zero.
 *
 * Everything here is a pure read, always scoped by an explicit `clientId` the
 * caller resolved from the session (never from a URL — see auth/guards.ts).
 *
 * ## Two rules this module enforces at the data layer
 *
 * - **No account numbers, ever.** `AccountBalance` carries `mask` (last four)
 *   and nothing else. The external feed ids on `accounts` are not selected, so
 *   they cannot leak into a view by accident.
 * - **Integers only.** Every figure is signed minor units, same as the ledger.
 */

import { and, desc, eq, gte, isNull, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  accounts,
  clientQuestions,
  documentRequests,
  intakeItems,
  outboundMessages,
  transactions,
} from '../db/schema.js';

/** Account kinds whose balance is spendable cash. Credit and loans are not. */
const CASH_KINDS = ['bank', 'cash'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const RUNWAY_WEEKS = 13;
const RUNWAY_DAYS = RUNWAY_WEEKS * 7;

export interface AccountBalance {
  readonly id: string;
  readonly name: string;
  /** Last four only. Never a full number — see accounts.mask in the schema. */
  readonly mask: string | null;
  readonly kind: string;
  readonly cents: number;
}

export interface CashPosition {
  readonly cents: number;
  readonly accounts: readonly AccountBalance[];
  /** Most recent posted date across cash accounts — how fresh the number is. */
  readonly lastActivityOn: string | null;
  readonly asOf: Date;
}

export interface Runway {
  /**
   * Whole weeks of cash left at the trailing burn rate. `null` means the
   * business is cash-flow positive over the window — there is no runway to
   * count down.
   */
  readonly weeks: number | null;
  /** Signed. Negative = burning cash. */
  readonly netWeeklyCents: number;
  readonly avgWeeklyInCents: number;
  readonly avgWeeklyOutCents: number;
  /** Cash projected at week 13 if the trailing pattern simply continues. */
  readonly projectedCents: number;
  /** Weeks of ledger history the estimate is built from (max 13). */
  readonly weeksObserved: number;
  /**
   * `measured` when there is enough history to mean anything; otherwise the
   * figure is shown with a caveat rather than hidden — an owner with six weeks
   * of history still wants the six-week answer.
   */
  readonly basis: 'measured' | 'thin_history';
}

export interface NeedsSummary {
  readonly openRequests: number;
  readonly openQuestions: number;
  readonly total: number;
}

export interface CaptureRow {
  readonly id: string;
  readonly channel: string;
  readonly status: string;
  readonly receivedAt: Date;
  readonly mime: string | null;
  readonly sizeBytes: number | null;
  /** The in-channel confirmation we sent back (OMNICHANNEL-CAPTURE.md §3). */
  readonly confirmation: string | null;
}

export interface MobileHome {
  readonly cash: CashPosition;
  readonly runway: Runway;
  readonly needs: NeedsSummary;
  readonly captures: readonly CaptureRow[];
}

/* ========================================================================== */
/* Cash                                                                        */
/* ========================================================================== */

/**
 * Cash on hand, summed from posted transactions rather than from a stored
 * balance column. There is no balance column on purpose: a number you derive
 * cannot drift away from the ledger it is supposed to describe.
 */
export async function cashPosition(clientId: string, asOf = new Date()): Promise<CashPosition> {
  const open = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      mask: accounts.mask,
      kind: accounts.kind,
    })
    .from(accounts)
    .where(and(eq(accounts.clientId, clientId), isNull(accounts.closedAt)));

  const cashAccounts = open.filter((a) => (CASH_KINDS as readonly string[]).includes(a.kind));
  if (cashAccounts.length === 0) {
    return { cents: 0, accounts: [], lastActivityOn: null, asOf };
  }

  const ids = cashAccounts.map((a) => a.id);
  const sums = await db
    .select({
      accountId: transactions.accountId,
      cents: sql<string>`coalesce(sum(${transactions.amountCents}), 0)`,
      lastPosted: sql<string | null>`max(${transactions.postedAt})`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.clientId, clientId),
        inArray(transactions.accountId, ids),
        lte(transactions.postedAt, isoDate(asOf)),
      ),
    )
    .groupBy(transactions.accountId);

  const byAccount = new Map(sums.map((r) => [r.accountId, r]));
  const balances: AccountBalance[] = cashAccounts.map((a) => ({
    id: a.id,
    name: a.name,
    mask: a.mask,
    kind: a.kind,
    cents: Number(byAccount.get(a.id)?.cents ?? 0),
  }));

  const lastActivityOn = sums
    .map((r) => r.lastPosted)
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
    .sort()
    .at(-1) ?? null;

  return {
    cents: balances.reduce((sum, b) => sum + b.cents, 0),
    accounts: balances,
    lastActivityOn,
    asOf,
  };
}

/* ========================================================================== */
/* Runway                                                                      */
/* ========================================================================== */

/**
 * A rolling 13-week runway estimate.
 *
 * Deliberately simple and explainable: average weekly money-in and money-out
 * across cash accounts over the trailing 13 weeks, projected forward flat. It
 * is not a model — it is arithmetic the owner can check, which is the whole
 * point of guardrail #1 in the strategy doc ("every AI number links to the
 * source"). Nothing here is AI; it is the ledger divided by thirteen.
 */
export async function runway(
  clientId: string,
  cash: CashPosition,
  asOf = new Date(),
): Promise<Runway> {
  const ids = cash.accounts.map((a) => a.id);
  const empty: Runway = {
    weeks: null,
    netWeeklyCents: 0,
    avgWeeklyInCents: 0,
    avgWeeklyOutCents: 0,
    projectedCents: cash.cents,
    weeksObserved: 0,
    basis: 'thin_history',
  };
  if (ids.length === 0) return empty;

  const from = new Date(asOf.getTime() - RUNWAY_DAYS * DAY_MS);
  const [row] = await db
    .select({
      inCents: sql<string>`coalesce(sum(${transactions.amountCents}) filter (where ${transactions.amountCents} > 0), 0)`,
      outCents: sql<string>`coalesce(sum(-${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)`,
      firstPosted: sql<string | null>`min(${transactions.postedAt})`,
      n: sql<string>`count(*)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.clientId, clientId),
        inArray(transactions.accountId, ids),
        gte(transactions.postedAt, isoDate(from)),
        lte(transactions.postedAt, isoDate(asOf)),
      ),
    );

  if (!row || Number(row.n) === 0) return empty;

  // Weeks actually covered by data — a client onboarded three weeks ago should
  // not have their burn divided by thirteen and flattered by a factor of four.
  const firstMs = row.firstPosted ? Date.parse(`${row.firstPosted}T00:00:00Z`) : from.getTime();
  const observedDays = Math.max(7, Math.round((asOf.getTime() - firstMs) / DAY_MS));
  const weeksObserved = Math.min(RUNWAY_WEEKS, Math.max(1, Math.round(observedDays / 7)));

  const avgWeeklyInCents = Math.round(Number(row.inCents) / weeksObserved);
  const avgWeeklyOutCents = Math.round(Number(row.outCents) / weeksObserved);
  const netWeeklyCents = avgWeeklyInCents - avgWeeklyOutCents;

  // Cash-flow positive → null (there is no runway to count down). Burning with
  // nothing left → zero weeks, said plainly. Otherwise: cash over weekly burn.
  let weeks: number | null;
  if (netWeeklyCents >= 0) weeks = null;
  else if (cash.cents <= 0) weeks = 0;
  else weeks = Math.floor(cash.cents / -netWeeklyCents);

  return {
    weeks,
    netWeeklyCents,
    avgWeeklyInCents,
    avgWeeklyOutCents,
    projectedCents: cash.cents + netWeeklyCents * RUNWAY_WEEKS,
    weeksObserved,
    basis: weeksObserved >= 6 ? 'measured' : 'thin_history',
  };
}

/* ========================================================================== */
/* What we need from you                                                       */
/* ========================================================================== */

/** One number, and the goal is zero. Open requests plus unanswered questions. */
export async function needsSummary(clientId: string): Promise<NeedsSummary> {
  const [requests, questions] = await Promise.all([
    db
      .select({ n: sql<string>`count(*)` })
      .from(documentRequests)
      .where(and(eq(documentRequests.clientId, clientId), eq(documentRequests.status, 'open'))),
    db
      .select({ n: sql<string>`count(*)` })
      .from(clientQuestions)
      .where(and(eq(clientQuestions.clientId, clientId), isNull(clientQuestions.answeredAt))),
  ]);

  const openRequests = Number(requests[0]?.n ?? 0);
  const openQuestions = Number(questions[0]?.n ?? 0);
  return { openRequests, openQuestions, total: openRequests + openQuestions };
}

/* ========================================================================== */
/* Recent captures                                                             */
/* ========================================================================== */

/**
 * The capture feed, with the confirmation we sent back attached.
 *
 * "The reason clients abandon capture tools is silence" (OMNICHANNEL-CAPTURE.md
 * §3). The PWA cannot push an SMS, so the confirmation that would have gone out
 * over a carrier is rendered here instead — same message, same job: confirm
 * receipt, show the extraction so errors surface immediately.
 */
export async function recentCaptures(clientId: string, limit = 8): Promise<CaptureRow[]> {
  const items = await db
    .select({
      id: intakeItems.id,
      channel: intakeItems.channel,
      status: intakeItems.status,
      receivedAt: intakeItems.receivedAt,
      mime: intakeItems.mime,
      sizeBytes: intakeItems.sizeBytes,
    })
    .from(intakeItems)
    .where(eq(intakeItems.clientId, clientId))
    .orderBy(desc(intakeItems.receivedAt))
    .limit(limit);

  if (items.length === 0) return [];

  const confirmations = await db
    .select({
      relatedId: outboundMessages.relatedId,
      body: outboundMessages.body,
      createdAt: outboundMessages.createdAt,
    })
    .from(outboundMessages)
    .where(
      and(
        eq(outboundMessages.clientId, clientId),
        eq(outboundMessages.purpose, 'capture_confirmation'),
        eq(outboundMessages.relatedEntity, 'intake_items'),
        inArray(
          outboundMessages.relatedId,
          items.map((i) => i.id),
        ),
      ),
    )
    .orderBy(desc(outboundMessages.createdAt));

  const byItem = new Map<string, string>();
  for (const c of confirmations) {
    if (c.relatedId && !byItem.has(c.relatedId)) byItem.set(c.relatedId, c.body);
  }

  return items.map((i) => ({ ...i, confirmation: byItem.get(i.id) ?? null }));
}

/* ========================================================================== */
/* The whole page                                                              */
/* ========================================================================== */

/** Everything GET /m renders, in one round of parallel reads. */
export async function mobileHome(clientId: string, asOf = new Date()): Promise<MobileHome> {
  const [cash, needs, captures] = await Promise.all([
    cashPosition(clientId, asOf),
    needsSummary(clientId),
    recentCaptures(clientId),
  ]);
  return { cash, runway: await runway(clientId, cash, asOf), needs, captures };
}

/* ========================================================================== */
/* Helpers                                                                     */
/* ========================================================================== */

/** `postedAt` is a DATE column; compare against `YYYY-MM-DD`, never a Date. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Human label for an intake channel, for the capture feed. */
export function channelLabel(channel: string): string {
  switch (channel) {
    case 'pwa':
      return 'Camera';
    case 'sms':
      return 'Text';
    case 'whatsapp':
      return 'WhatsApp';
    case 'email':
      return 'Email';
    case 'portal':
      return 'Portal upload';
    case 'voice':
      return 'Voice note';
    case 'cloud_folder':
      return 'Cloud folder';
    case 'bank_feed':
      return 'Bank feed';
    default:
      return channel;
  }
}

/** What a capture's status means to the person who took the photo. */
export function captureStatusLabel(status: string): string {
  switch (status) {
    case 'received':
      return 'Received';
    case 'processing':
      return 'Reading it';
    case 'needs_review':
      return 'We’re checking it';
    case 'filed':
      return 'Filed';
    case 'quarantined':
      return 'Held for review';
    case 'discarded':
      return 'Discarded';
    default:
      return status;
  }
}
