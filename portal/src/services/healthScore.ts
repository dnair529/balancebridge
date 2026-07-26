/**
 * The 20-point Books Health Score — the lead magnet, made live.
 *
 * `site/public/downloads/texas-financial-health-checklist.pdf` is the firm's
 * acquisition asset: twenty statements, four groups of five, "check every box
 * you can honestly say is true". CLIENT-PLATFORM-STRATEGY.md #14 turns it into
 * a retention asset by computing it continuously from the client's own ledger.
 *
 * **The wording of every check is verbatim from the PDF.** That is the point:
 * the thing they downloaded before they were a client is the same thing they
 * see after, now answered for them instead of by them.
 *
 * ## How honesty is preserved
 *
 * A checklist that grades itself is worthless if it awards points it cannot
 * justify. So every check carries a `detail` string stating what was actually
 * measured, and a check we cannot measure is *not* silently passed:
 *
 * - Where the ledger answers the question directly (reconciliation,
 *   uncategorised count, AR aging) the check is measured outright.
 * - Where it answers a close proxy (separation of personal spending, invoice
 *   turnaround) the proxy is named in `detail` so nobody mistakes it for proof.
 * - Where the answer lives on the compliance calendar and the calendar is
 *   empty, the check **fails** — "the deadline is not on the calendar" is the
 *   correct reading of an empty calendar, not an excuse to award the point.
 *
 * Nothing here is AI and nothing here is advice. It is arithmetic over the
 * client's own records, and the compliance checks are informational only —
 * Balance Bridge is not a CPA firm (see services/compliance.ts).
 */

import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  accounts,
  categories,
  clients,
  closePeriods,
  complianceEvents,
  documentRequests,
  healthScores,
  invoices,
  transactions,
} from '../db/schema.js';
import { cashPosition, isoDate, runway } from './clientDashboard.js';

export const HEALTH_GROUPS = [
  'Books & Reconciliation',
  'Cash & Receivables',
  'Compliance & Payroll',
  'Reports & Decisions',
] as const;

export type HealthGroup = (typeof HEALTH_GROUPS)[number];

export interface HealthCheck {
  readonly code: string;
  readonly group: HealthGroup;
  /** Verbatim from the checklist PDF. Do not paraphrase. */
  readonly label: string;
  readonly passed: boolean;
  /** What we measured, in plain English. Always populated. */
  readonly detail: string;
}

export interface HealthBand {
  readonly code: 'strong' | 'solid' | 'at_risk';
  readonly label: string;
  readonly blurb: string;
}

export interface HealthResult {
  readonly clientId: string;
  readonly computedAt: Date;
  readonly score: number;
  readonly maxScore: number;
  readonly checks: readonly HealthCheck[];
  readonly band: HealthBand;
}

const MAX_SCORE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/* ========================================================================== */
/* Facts                                                                       */
/* ========================================================================== */

interface Facts {
  readonly asOf: Date;
  readonly lastMonthEnd: string;
  readonly openAccounts: readonly { id: string; kind: string; name: string; mask: string | null }[];
  readonly bankAccountIds: readonly string[];
  readonly unreconciledStale: number;
  readonly undepositedCents: number;
  readonly hasUndepositedCategory: boolean;
  readonly usedCategoryCount: number;
  readonly personalHits: number;
  readonly uncategorized: number;
  readonly cashCents: number;
  readonly lastActivityOn: string | null;
  readonly runwayMeasured: boolean;
  readonly runwayWeeksObserved: number;
  readonly staleOpenInvoices: number;
  readonly staleDraftInvoices: number;
  readonly monthsWithIncomeAndExpense: number;
  readonly cogsCategories: number;
  readonly cogsTxns: number;
  readonly deliveredCloses: readonly { periodEnd: string; deliveredAt: Date | null }[];
  /** Closed months we could reasonably expect a close for, capped at three. */
  readonly closableMonths: number;
  readonly approvedNarrativeAt: Date | null;
  readonly compliance: readonly { code: string; dueOn: string; status: string }[];
  readonly openW9Requests: number;
  readonly staleOpenRequests: number;
}

async function gatherFacts(clientId: string, asOf: Date): Promise<Facts> {
  const lastMonthEndDate = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 0));
  const lastMonthEnd = isoDate(lastMonthEndDate);
  const yearAgo = isoDate(new Date(asOf.getTime() - 365 * DAY_MS));
  const sixMonthsAgo = isoDate(new Date(asOf.getTime() - 183 * DAY_MS));
  const ninetyDaysAgo = isoDate(new Date(asOf.getTime() - 90 * DAY_MS));

  const openAccounts = await db
    .select({ id: accounts.id, kind: accounts.kind, name: accounts.name, mask: accounts.mask })
    .from(accounts)
    .where(and(eq(accounts.clientId, clientId), isNull(accounts.closedAt)));

  const bankAccountIds = openAccounts
    .filter((a) => a.kind === 'bank' || a.kind === 'credit_card')
    .map((a) => a.id);

  const cash = await cashPosition(clientId, asOf);
  const rw = await runway(clientId, cash, asOf);

  const [
    unreconciled,
    undeposited,
    usedCats,
    personal,
    uncat,
    invoiceAging,
    draftInvoices,
    monthly,
    cogsCats,
    cogsTxns,
    closes,
    approved,
    compliance,
    w9Requests,
    staleRequests,
    firstTxn,
  ] = await Promise.all([
    // 1 — anything posted on or before last month-end that is still unreconciled.
    bankAccountIds.length === 0
      ? Promise.resolve([{ n: '0' }])
      : db
          .select({ n: sql<string>`count(*)` })
          .from(transactions)
          .where(
            and(
              eq(transactions.clientId, clientId),
              inArray(transactions.accountId, bankAccountIds),
              lte(transactions.postedAt, lastMonthEnd),
              isNull(transactions.reconciledAt),
            ),
          ),

    // 2 — money parked in an Undeposited Funds style holding account.
    db
      .select({
        cents: sql<string>`coalesce(sum(${transactions.amountCents}), 0)`,
        n: sql<string>`count(*)`,
      })
      .from(transactions)
      .innerJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(eq(transactions.clientId, clientId), ilike(categories.name, '%undeposited%'))),

    // 3 — a chart of accounts is only real if transactions actually land in it.
    db
      .select({ n: sql<string>`count(distinct ${transactions.categoryId})` })
      .from(transactions)
      .where(
        and(
          eq(transactions.clientId, clientId),
          gte(transactions.postedAt, yearAgo),
          isNotNull(transactions.categoryId),
        ),
      ),

    // 4 — business spend landing in a personal bucket.
    db
      .select({ n: sql<string>`count(*)` })
      .from(transactions)
      .innerJoin(categories, eq(transactions.categoryId, categories.id))
      .where(
        and(
          eq(transactions.clientId, clientId),
          gte(transactions.postedAt, yearAgo),
          ilike(categories.name, '%personal%'),
        ),
      ),

    // Uncategorised backlog — feeds checks 19 and 20.
    db
      .select({ n: sql<string>`count(*)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.clientId, clientId),
          gte(transactions.postedAt, yearAgo),
          isNull(transactions.categoryId),
        ),
      ),

    // 7 — receivables older than 60 days still open.
    db
      .select({ n: sql<string>`count(*)` })
      .from(invoices)
      .where(
        and(
          eq(invoices.clientId, clientId),
          inArray(invoices.status, ['open', 'past_due']),
          lte(invoices.issuedAt, new Date(asOf.getTime() - 60 * DAY_MS)),
        ),
      ),

    // 8 — invoices written but never sent.
    db
      .select({ n: sql<string>`count(*)` })
      .from(invoices)
      .where(
        and(
          eq(invoices.clientId, clientId),
          eq(invoices.status, 'draft'),
          lte(invoices.issuedAt, new Date(asOf.getTime() - 3 * DAY_MS)),
        ),
      ),

    // 10 — months where both sides of the P&L are categorised, so break-even
    // is a number you can actually compute rather than a feeling.
    db
      .select({ n: sql<string>`count(*)` })
      .from(
        db
          .select({ month: sql<string>`to_char(${transactions.postedAt}, 'YYYY-MM')`.as('month') })
          .from(transactions)
          .innerJoin(categories, eq(transactions.categoryId, categories.id))
          .where(
            and(
              eq(transactions.clientId, clientId),
              gte(transactions.postedAt, sixMonthsAgo),
              inArray(categories.kind, ['income', 'cogs', 'expense']),
            ),
          )
          .groupBy(sql`1`)
          .having(
            sql`count(*) filter (where ${categories.kind} = 'income') > 0
                and count(*) filter (where ${categories.kind} in ('cogs','expense')) > 0`,
          )
          .as('m'),
      ),

    // 17 — gross margin needs a COGS side to the chart of accounts…
    db
      .select({ n: sql<string>`count(*)` })
      .from(categories)
      .where(
        and(eq(categories.clientId, clientId), eq(categories.kind, 'cogs'), isNull(categories.archivedAt)),
      ),

    // …and transactions actually landing in it.
    db
      .select({ n: sql<string>`count(*)` })
      .from(transactions)
      .innerJoin(categories, eq(transactions.categoryId, categories.id))
      .where(
        and(
          eq(transactions.clientId, clientId),
          gte(transactions.postedAt, ninetyDaysAgo),
          eq(categories.kind, 'cogs'),
        ),
      ),

    // 5 and 16 — delivered closes.
    db
      .select({ periodEnd: closePeriods.periodEnd, deliveredAt: closePeriods.deliveredAt })
      .from(closePeriods)
      .where(and(eq(closePeriods.clientId, clientId), eq(closePeriods.status, 'delivered')))
      .orderBy(desc(closePeriods.periodEnd))
      .limit(6),

    // 18 — an approved narrative is the budget-vs-actual conversation.
    db
      .select({ approvedAt: closePeriods.narrativeApprovedAt })
      .from(closePeriods)
      .where(and(eq(closePeriods.clientId, clientId), isNotNull(closePeriods.narrativeApprovedAt)))
      .orderBy(desc(closePeriods.narrativeApprovedAt))
      .limit(1),

    // 11–15 — the compliance calendar.
    db
      .select({
        code: complianceEvents.code,
        dueOn: complianceEvents.dueOn,
        status: complianceEvents.status,
      })
      .from(complianceEvents)
      .where(and(eq(complianceEvents.clientId, clientId), ne(complianceEvents.status, 'na'))),

    // 13 — W-9s we are still chasing.
    db
      .select({ n: sql<string>`count(*)` })
      .from(documentRequests)
      .where(
        and(
          eq(documentRequests.clientId, clientId),
          eq(documentRequests.status, 'open'),
          ilike(documentRequests.label, 'W-9%'),
        ),
      ),

    // 20 — anything we asked for more than a month ago and never got.
    db
      .select({ n: sql<string>`count(*)` })
      .from(documentRequests)
      .where(
        and(
          eq(documentRequests.clientId, clientId),
          eq(documentRequests.status, 'open'),
          lte(documentRequests.createdAt, new Date(asOf.getTime() - 30 * DAY_MS)),
        ),
      ),

    // 16 — how long we have had books to close at all.
    db
      .select({ first: sql<string | null>`min(${transactions.postedAt})` })
      .from(transactions)
      .where(eq(transactions.clientId, clientId)),
  ]);

  return {
    asOf,
    lastMonthEnd,
    openAccounts,
    bankAccountIds,
    unreconciledStale: Number(unreconciled[0]?.n ?? 0),
    undepositedCents: Number(undeposited[0]?.cents ?? 0),
    hasUndepositedCategory: Number(undeposited[0]?.n ?? 0) > 0,
    usedCategoryCount: Number(usedCats[0]?.n ?? 0),
    personalHits: Number(personal[0]?.n ?? 0),
    uncategorized: Number(uncat[0]?.n ?? 0),
    cashCents: cash.cents,
    lastActivityOn: cash.lastActivityOn,
    runwayMeasured: rw.basis === 'measured',
    runwayWeeksObserved: rw.weeksObserved,
    staleOpenInvoices: Number(invoiceAging[0]?.n ?? 0),
    staleDraftInvoices: Number(draftInvoices[0]?.n ?? 0),
    monthsWithIncomeAndExpense: Number(monthly[0]?.n ?? 0),
    cogsCategories: Number(cogsCats[0]?.n ?? 0),
    cogsTxns: Number(cogsTxns[0]?.n ?? 0),
    deliveredCloses: closes,
    closableMonths: closableMonths(firstTxn[0]?.first ?? null, asOf),
    approvedNarrativeAt: approved[0]?.approvedAt ?? null,
    compliance,
    openW9Requests: Number(w9Requests[0]?.n ?? 0),
    staleOpenRequests: Number(staleRequests[0]?.n ?? 0),
  };
}

/**
 * How many closed months we could reasonably expect a delivered close for.
 * Capped at three: check 16 asks about a monthly rhythm, not about history. A
 * client onboarded six weeks ago is not marked down for the year before that.
 */
function closableMonths(firstPosted: string | null, asOf: Date): number {
  if (!firstPosted) return 1;
  const first = new Date(`${firstPosted}T00:00:00Z`);
  const elapsed =
    (asOf.getUTCFullYear() - first.getUTCFullYear()) * 12 +
    (asOf.getUTCMonth() - first.getUTCMonth());
  return Math.max(1, Math.min(3, elapsed));
}

/* ========================================================================== */
/* The twenty checks                                                           */
/* ========================================================================== */

function evaluate(f: Facts): HealthCheck[] {
  const overdue = (prefix: string) =>
    f.compliance.filter(
      (e) => e.code.startsWith(prefix) && e.status !== 'done' && e.dueOn < isoDate(f.asOf),
    );
  const onCalendar = (prefix: string) => f.compliance.filter((e) => e.code.startsWith(prefix));

  const checks: HealthCheck[] = [];
  const add = (
    code: string,
    group: HealthGroup,
    label: string,
    passed: boolean,
    detail: string,
  ): void => {
    checks.push({ code, group, label, passed, detail });
  };

  /* ---- 01 Books & Reconciliation ---------------------------------------- */

  add(
    'reconciled_accounts',
    'Books & Reconciliation',
    'Every bank and credit card account is reconciled through last month',
    f.bankAccountIds.length > 0 && f.unreconciledStale === 0,
    f.bankAccountIds.length === 0
      ? 'No bank or credit card account is connected yet, so there is nothing to reconcile against.'
      : f.unreconciledStale === 0
        ? `All ${f.bankAccountIds.length} account${f.bankAccountIds.length === 1 ? '' : 's'} are reconciled through ${f.lastMonthEnd}.`
        : `${f.unreconciledStale} transaction${f.unreconciledStale === 1 ? '' : 's'} posted on or before ${f.lastMonthEnd} are still unreconciled.`,
  );

  add(
    'undeposited_funds',
    'Books & Reconciliation',
    'No unexplained balance sitting in Undeposited Funds',
    f.undepositedCents === 0,
    !f.hasUndepositedCategory
      ? 'Nothing is posted to an Undeposited Funds account.'
      : f.undepositedCents === 0
        ? 'The Undeposited Funds account nets to zero.'
        : `${formatCents(f.undepositedCents)} is sitting in Undeposited Funds.`,
  );

  add(
    'chart_of_accounts',
    'Books & Reconciliation',
    'The chart of accounts matches how the business actually operates',
    f.usedCategoryCount >= 8,
    `${f.usedCategoryCount} categor${f.usedCategoryCount === 1 ? 'y is' : 'ies are'} actually in use across the last 12 months. ` +
      'Proxy measure: a chart of accounts nobody posts to is not describing the business.',
  );

  add(
    'separation',
    'Books & Reconciliation',
    'Personal and business spending are fully separated',
    f.personalHits === 0,
    f.personalHits === 0
      ? 'No transaction in the last 12 months landed in a personal category. Proxy measure — it cannot see a personal card we do not have.'
      : `${f.personalHits} transaction${f.personalHits === 1 ? '' : 's'} in the last 12 months landed in a personal category.`,
  );

  const latestClose = f.deliveredCloses[0];
  const closeLagDays =
    latestClose?.deliveredAt != null
      ? Math.round(
          (latestClose.deliveredAt.getTime() - Date.parse(`${latestClose.periodEnd}T00:00:00Z`)) /
            DAY_MS,
        )
      : null;
  add(
    'close_within_15',
    'Books & Reconciliation',
    'Books are closed within 15 days of month-end, every month',
    closeLagDays !== null && closeLagDays <= 15,
    closeLagDays === null
      ? 'No month-end close has been delivered yet.'
      : `The last close (${latestClose?.periodEnd}) was delivered ${closeLagDays} day${closeLagDays === 1 ? '' : 's'} after month-end.`,
  );

  /* ---- 02 Cash & Receivables -------------------------------------------- */

  const staleDays =
    f.lastActivityOn == null
      ? null
      : Math.round((f.asOf.getTime() - Date.parse(`${f.lastActivityOn}T00:00:00Z`)) / DAY_MS);
  add(
    'cash_position',
    'Cash & Receivables',
    'You know today’s real cash position without calling the bank',
    staleDays !== null && staleDays <= 7,
    staleDays === null
      ? 'No cash account activity has been imported, so the portal cannot show a live balance.'
      : staleDays <= 7
        ? `Cash on hand is ${formatCents(f.cashCents)}, current as of ${f.lastActivityOn}.`
        : `The newest cash transaction is ${staleDays} days old — the balance shown is stale.`,
  );

  add(
    'ar_aging',
    'Cash & Receivables',
    'AR aging is reviewed monthly — you know who owes you and how long',
    f.staleOpenInvoices === 0,
    f.staleOpenInvoices === 0
      ? 'Nothing receivable has been outstanding more than 60 days.'
      : `${f.staleOpenInvoices} invoice${f.staleOpenInvoices === 1 ? ' has' : 's have'} been open more than 60 days.`,
  );

  add(
    'invoice_speed',
    'Cash & Receivables',
    'Invoices go out within 3 days of work delivered',
    f.staleDraftInvoices === 0,
    f.staleDraftInvoices === 0
      ? 'No invoice has been sitting in draft for more than 3 days. Proxy measure — we can see when an invoice was raised, not when the work was finished.'
      : `${f.staleDraftInvoices} invoice${f.staleDraftInvoices === 1 ? '' : 's'} have been in draft for more than 3 days.`,
  );

  add(
    'cash_forecast',
    'Cash & Receivables',
    'A 13-week cash flow forecast exists and gets updated',
    f.runwayMeasured && staleDays !== null && staleDays <= 14,
    f.runwayMeasured
      ? staleDays !== null && staleDays <= 14
        ? `Built from ${f.runwayWeeksObserved} weeks of live ledger data and refreshed on every visit.`
        : 'The forecast exists but the ledger feeding it has gone stale.'
      : `Only ${f.runwayWeeksObserved} week${f.runwayWeeksObserved === 1 ? '' : 's'} of history — not enough to project 13 weeks yet.`,
  );

  add(
    'break_even',
    'Cash & Receivables',
    'You know your true monthly break-even number',
    f.monthsWithIncomeAndExpense >= 3,
    `${f.monthsWithIncomeAndExpense} of the last 6 months have both income and cost fully categorised. ` +
      'Break-even is only knowable once both sides of the P&L are complete.',
  );

  /* ---- 03 Compliance & Payroll ------------------------------------------ */

  const salesTax = onCalendar('tx_sales_tax');
  add(
    'sales_tax',
    'Compliance & Payroll',
    'Sales tax is collected, filed, and paid on schedule (state + local)',
    salesTax.length > 0 && overdue('tx_sales_tax').length === 0,
    salesTax.length === 0
      ? 'No sales tax deadlines are on the compliance calendar yet.'
      : overdue('tx_sales_tax').length === 0
        ? `${salesTax.length} sales tax deadline${salesTax.length === 1 ? '' : 's'} tracked, none overdue.`
        : `${overdue('tx_sales_tax').length} sales tax deadline${overdue('tx_sales_tax').length === 1 ? ' is' : 's are'} past due.`,
  );

  const payroll = onCalendar('payroll_');
  add(
    'payroll_deposits',
    'Compliance & Payroll',
    'Payroll tax deposits match filed returns — no surprises',
    payroll.length > 0 && overdue('payroll_').length === 0,
    payroll.length === 0
      ? 'No payroll deposit or return deadlines are on the compliance calendar yet.'
      : overdue('payroll_').length === 0
        ? `${payroll.length} payroll deadline${payroll.length === 1 ? '' : 's'} tracked, none overdue.`
        : `${overdue('payroll_').length} payroll deadline${overdue('payroll_').length === 1 ? ' is' : 's are'} past due.`,
  );

  const tenNinetyNine = onCalendar('form_1099');
  add(
    'w9_1099',
    'Compliance & Payroll',
    'Contractors have W-9s on file; 1099s go out on time',
    f.openW9Requests === 0 && tenNinetyNine.length > 0 && overdue('form_1099').length === 0,
    f.openW9Requests > 0
      ? `${f.openW9Requests} W-9 request${f.openW9Requests === 1 ? ' is' : 's are'} still outstanding.`
      : tenNinetyNine.length === 0
        ? 'No W-9s outstanding, but the 1099 deadlines are not on the compliance calendar yet.'
        : overdue('form_1099').length === 0
          ? 'No W-9s outstanding and the 1099 deadlines are on the calendar.'
          : 'A 1099 deadline is past due.',
  );

  const franchise = onCalendar('tx_franchise');
  add(
    'franchise_tax',
    'Compliance & Payroll',
    'Texas franchise tax report deadline (May 15) is on the calendar',
    franchise.length > 0 && overdue('tx_franchise').length === 0,
    franchise.length === 0
      ? 'The Texas franchise tax report deadline is not on the compliance calendar yet.'
      : overdue('tx_franchise').length === 0
        ? `Tracked — next due ${nextDue(franchise, f.asOf) ?? franchise[0]?.dueOn}.`
        : 'The Texas franchise tax report deadline has passed without being marked done.',
  );

  const licences = onCalendar('licenses_');
  add(
    'licenses_current',
    'Compliance & Payroll',
    'Business licenses, registrations, and insurance are current',
    licences.length > 0 && overdue('licenses_').length === 0,
    licences.length === 0
      ? 'No license, registration, or insurance renewal dates are on the compliance calendar yet.'
      : overdue('licenses_').length === 0
        ? 'Renewal dates are tracked and none have lapsed.'
        : 'A license, registration, or insurance renewal date has passed.',
  );

  /* ---- 04 Reports & Decisions ------------------------------------------- */

  const recentCloses = f.deliveredCloses.length;
  add(
    'monthly_reports',
    'Reports & Decisions',
    'You review a P&L and balance sheet every month — and they make sense',
    recentCloses >= f.closableMonths,
    recentCloses >= f.closableMonths
      ? `${recentCloses} month-end close${recentCloses === 1 ? ' has' : 's have'} been delivered.`
      : `${recentCloses} of the last ${f.closableMonths} closeable month${f.closableMonths === 1 ? '' : 's'} have a delivered close.`,
  );

  add(
    'gross_margin',
    'Reports & Decisions',
    'You know your gross margin by product, service, or job',
    f.cogsCategories > 0 && f.cogsTxns > 0,
    f.cogsCategories === 0
      ? 'The chart of accounts has no cost-of-goods categories, so gross margin cannot be split out.'
      : f.cogsTxns === 0
        ? 'Cost-of-goods categories exist but nothing has been posted to them in 90 days.'
        : `${f.cogsTxns} transaction${f.cogsTxns === 1 ? '' : 's'} categorised to cost of goods in the last 90 days.`,
  );

  const narrativeAgeDays =
    f.approvedNarrativeAt == null
      ? null
      : Math.round((f.asOf.getTime() - f.approvedNarrativeAt.getTime()) / DAY_MS);
  add(
    'budget_vs_actual',
    'Reports & Decisions',
    'Budget vs. actual gets compared at least quarterly',
    narrativeAgeDays !== null && narrativeAgeDays <= 92,
    narrativeAgeDays === null
      ? 'No approved close summary has been published yet.'
      : narrativeAgeDays <= 92
        ? `The last approved close summary was published ${narrativeAgeDays} day${narrativeAgeDays === 1 ? '' : 's'} ago.`
        : `The last approved close summary is ${narrativeAgeDays} days old — more than a quarter.`,
  );

  const loanReady = f.uncategorized === 0 && f.unreconciledStale === 0 && recentCloses > 0;
  add(
    'loan_ready',
    'Reports & Decisions',
    'Your books could survive a bank loan application this week',
    loanReady,
    loanReady
      ? 'Reconciled through last month, nothing uncategorised, and a delivered close to hand over.'
      : `Blocked by: ${[
          f.unreconciledStale > 0 ? `${f.unreconciledStale} unreconciled transactions` : null,
          f.uncategorized > 0 ? `${f.uncategorized} uncategorised transactions` : null,
          recentCloses === 0 ? 'no delivered close' : null,
        ]
          .filter(Boolean)
          .join(', ')}.`,
  );

  const cpaReady = f.staleOpenRequests === 0 && f.uncategorized === 0;
  add(
    'cpa_ready',
    'Reports & Decisions',
    'Your CPA gets clean, complete records at tax time — no shoebox',
    cpaReady,
    cpaReady
      ? 'Nothing outstanding for more than 30 days and no uncategorised transactions.'
      : `${f.staleOpenRequests} request${f.staleOpenRequests === 1 ? '' : 's'} outstanding over 30 days and ${f.uncategorized} uncategorised transaction${f.uncategorized === 1 ? '' : 's'}.`,
  );

  return checks;
}

/* ========================================================================== */
/* Score, band, persistence                                                    */
/* ========================================================================== */

/** The bands, verbatim from the checklist PDF. */
export function bandFor(score: number): HealthBand {
  if (score >= 18) {
    return { code: 'strong', label: '18–20 checked', blurb: 'Your books are an asset. Keep the rhythm.' };
  }
  if (score >= 14) {
    return {
      code: 'solid',
      label: '14–17 checked',
      blurb: 'Solid foundation with expensive blind spots — tighten the misses.',
    };
  }
  return {
    code: 'at_risk',
    label: 'Under 14',
    blurb: 'Your books are running the business instead of you. Time to fix that.',
  };
}

/** Compute without writing. Useful for previews and tests. */
export async function computeHealthScore(clientId: string, asOf = new Date()): Promise<HealthResult> {
  const facts = await gatherFacts(clientId, asOf);
  const checks = evaluate(facts);
  const score = checks.filter((c) => c.passed).length;
  return { clientId, computedAt: asOf, score, maxScore: MAX_SCORE, checks, band: bandFor(score) };
}

/** Compute and persist a `health_scores` row. Append-only: history is the point. */
export async function computeAndStore(clientId: string, asOf = new Date()): Promise<HealthResult> {
  const result = await computeHealthScore(clientId, asOf);
  await db.insert(healthScores).values({
    clientId,
    computedAt: result.computedAt,
    score: result.score,
    maxScore: result.maxScore,
    checks: result.checks,
  });
  return result;
}

const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * What the client-facing page uses: the stored score if it is fresh, otherwise
 * a fresh computation persisted as a new row. Recomputing on every page view
 * would write a row per refresh; never recomputing would show a stale grade
 * after the very fix that improved it.
 */
export async function latestHealthScore(clientId: string, asOf = new Date()): Promise<HealthResult> {
  const [row] = await db
    .select()
    .from(healthScores)
    .where(eq(healthScores.clientId, clientId))
    .orderBy(desc(healthScores.computedAt))
    .limit(1);

  if (row && asOf.getTime() - row.computedAt.getTime() < STALE_AFTER_MS) {
    return {
      clientId,
      computedAt: row.computedAt,
      score: row.score,
      maxScore: row.maxScore,
      checks: (row.checks as HealthCheck[]) ?? [],
      band: bandFor(row.score),
    };
  }
  return computeAndStore(clientId, asOf);
}

/** Recompute for every active client. For a nightly job. */
export async function recomputeAll(asOf = new Date()): Promise<readonly HealthResult[]> {
  const rows = await db.select({ id: clients.id }).from(clients).where(eq(clients.status, 'active'));
  const out: HealthResult[] = [];
  for (const r of rows) out.push(await computeAndStore(r.id, asOf));
  return out;
}

/** Group the checks for rendering, in the order the printed checklist uses. */
export function groupChecks(
  checks: readonly HealthCheck[],
): readonly { group: HealthGroup; checks: readonly HealthCheck[] }[] {
  return HEALTH_GROUPS.map((group) => ({ group, checks: checks.filter((c) => c.group === group) }));
}

function nextDue(
  events: readonly { dueOn: string }[],
  asOf: Date,
): string | null {
  const today = isoDate(asOf);
  return events
    .map((e) => e.dueOn)
    .filter((d) => d >= today)
    .sort()
    .at(0) ?? null;
}

function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}
