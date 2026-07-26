/**
 * The compliance calendar — CLIENT-PLATFORM-STRATEGY.md #10.
 *
 * A per-entity countdown to the dates a Texas small business cannot afford to
 * miss: franchise tax, sales tax at whatever frequency the Comptroller assigned
 * them, 1099s, payroll deposits and returns, licence renewals.
 *
 * ============================================================================
 * INFORMATIONAL ONLY — NOT TAX ADVICE
 * ============================================================================
 *
 * This module seeds *standard, publicly published* deadlines so nothing is
 * forgotten. It does not determine which of them apply to a given entity, and
 * it is emphatically not advice.
 *
 * The strategy doc draws this line explicitly and calls it "a licensure and
 * liability line, not a style preference": Balance Bridge is a bookkeeping
 * firm, not a CPA firm. We track dates; the client's CPA advises on them.
 * Filing frequencies, entity-type applicability, extensions and no-tax-due
 * thresholds all vary — every generated event therefore carries
 * {@link INFORMATIONAL_NOTICE} in its notes, and every client-facing view of
 * this data must show that disclaimer.
 *
 * Dates that fall on a weekend are rolled forward to the next weekday, which is
 * the general federal and Texas convention. Federal holidays are *not* modelled
 * — another reason a date here is a prompt to confirm, never an authority.
 */

import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { complianceEvents } from '../db/schema.js';
import { isoDate } from './clientDashboard.js';

export const INFORMATIONAL_NOTICE =
  'Informational only — not tax advice. Balance Bridge is a bookkeeping firm, not a CPA firm. ' +
  'Confirm applicability, filing frequency and any extension with your CPA or the taxing authority.';

/** How often the Comptroller has told this client to file sales tax. */
export type SalesTaxFrequency = 'monthly' | 'quarterly' | 'annual' | 'none';

/** How often payroll tax deposits are due, per the client's IRS deposit schedule. */
export type PayrollSchedule = 'semiweekly' | 'monthly' | 'none';

export interface CalendarProfile {
  readonly salesTax: SalesTaxFrequency;
  readonly payroll: PayrollSchedule;
  /** Does the client pay contractors? Drives the 1099 dates. */
  readonly pays1099Contractors: boolean;
  /** Anniversary date for licence/registration/insurance renewals, MM-DD. */
  readonly renewalMonthDay: string | null;
}

export const DEFAULT_PROFILE: CalendarProfile = {
  salesTax: 'quarterly',
  payroll: 'monthly',
  pays1099Contractors: true,
  renewalMonthDay: null,
};

export interface SeededEvent {
  readonly code: string;
  readonly label: string;
  readonly dueOn: string;
  readonly notes: string;
}

export interface SeedResult {
  readonly created: number;
  readonly alreadyPresent: number;
  readonly events: readonly SeededEvent[];
}

export interface CountdownEvent {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly dueOn: string;
  readonly notes: string | null;
  readonly status: string;
  /** Negative when the date has passed. */
  readonly daysAway: number;
  readonly overdue: boolean;
  /** "in 12 days", "today", "18 days ago". */
  readonly countdown: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/* ========================================================================== */
/* Building the standard year                                                  */
/* ========================================================================== */

/**
 * The standard Texas + federal deadlines for one calendar year. Pure — build
 * it, inspect it, then decide whether to persist it.
 */
export function standardEvents(year: number, profile: CalendarProfile = DEFAULT_PROFILE): SeededEvent[] {
  const out: SeededEvent[] = [];
  const push = (code: string, label: string, dueOn: string, notes: string): void => {
    out.push({ code, label, dueOn, notes: `${notes} ${INFORMATIONAL_NOTICE}` });
  };

  /* ---- Texas franchise tax --------------------------------------------- */
  // Report and Public Information Report are due May 15 each year. Entities
  // below the no-tax-due threshold may still owe the informational report.
  push(
    'tx_franchise_report',
    `Texas franchise tax report — ${year}`,
    businessDay(`${year}-05-15`),
    'Annual Texas franchise tax report and Public Information Report are generally due May 15.',
  );

  /* ---- Texas sales and use tax ----------------------------------------- */
  // Texas returns are due the 20th of the month following the period.
  if (profile.salesTax === 'monthly') {
    for (let m = 1; m <= 12; m += 1) {
      const period = new Date(Date.UTC(year, m - 2, 1)); // period covered
      push(
        `tx_sales_tax_monthly_${String(m).padStart(2, '0')}`,
        `Texas sales tax — ${period.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`,
        businessDay(`${year}-${String(m).padStart(2, '0')}-20`),
        'Monthly Texas sales and use tax return and payment are generally due the 20th of the following month.',
      );
    }
  } else if (profile.salesTax === 'quarterly') {
    const quarters: readonly [string, number, number][] = [
      ['q4_prior', year, 1],
      ['q1', year, 4],
      ['q2', year, 7],
      ['q3', year, 10],
    ];
    for (const [key, y, month] of quarters) {
      push(
        `tx_sales_tax_quarterly_${key}`,
        `Texas sales tax — ${quarterLabel(key, year)}`,
        businessDay(`${y}-${String(month).padStart(2, '0')}-20`),
        'Quarterly Texas sales and use tax return and payment are generally due the 20th of the month after the quarter ends.',
      );
    }
  } else if (profile.salesTax === 'annual') {
    push(
      'tx_sales_tax_annual',
      `Texas sales tax — ${year - 1} annual return`,
      businessDay(`${year}-01-20`),
      'Annual Texas sales and use tax return and payment are generally due January 20.',
    );
  }

  /* ---- Payroll --------------------------------------------------------- */
  if (profile.payroll === 'monthly') {
    for (let m = 1; m <= 12; m += 1) {
      const period = new Date(Date.UTC(year, m - 2, 1));
      push(
        `payroll_deposit_monthly_${String(m).padStart(2, '0')}`,
        `Federal payroll tax deposit — ${period.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`,
        businessDay(`${year}-${String(m).padStart(2, '0')}-15`),
        'Monthly depositors generally deposit federal employment taxes by the 15th of the following month.',
      );
    }
  } else if (profile.payroll === 'semiweekly') {
    push(
      'payroll_deposit_semiweekly',
      'Federal payroll tax deposits — semi-weekly schedule',
      businessDay(`${year}-01-15`),
      'Semi-weekly depositors deposit on a Wednesday or Friday schedule tied to each pay date; individual dates are driven by your payroll calendar, not this one.',
    );
  }

  if (profile.payroll !== 'none') {
    const form941: readonly [string, string][] = [
      [`${year}-01-31`, `Form 941 — Q4 ${year - 1}`],
      [`${year}-04-30`, `Form 941 — Q1 ${year}`],
      [`${year}-07-31`, `Form 941 — Q2 ${year}`],
      [`${year}-10-31`, `Form 941 — Q3 ${year}`],
    ];
    form941.forEach(([due, label], i) => {
      push(
        `payroll_941_q${i}`,
        label,
        businessDay(due),
        'Quarterly federal employment tax return is generally due the last day of the month following the quarter.',
      );
    });
    push(
      'payroll_940_annual',
      `Form 940 (FUTA) — ${year - 1}`,
      businessDay(`${year}-01-31`),
      'Annual federal unemployment tax return is generally due January 31.',
    );
    push(
      'payroll_w2_filing',
      `Form W-2 to employees and SSA — ${year - 1}`,
      businessDay(`${year}-01-31`),
      'W-2s to employees and to the Social Security Administration are generally due January 31.',
    );
    push(
      'payroll_tx_c3_q1',
      `Texas Workforce Commission wage report — Q4 ${year - 1}`,
      businessDay(`${year}-01-31`),
      'Texas unemployment tax (Form C-3/C-4) wage reports are generally due the last day of the month following the quarter.',
    );
  }

  /* ---- 1099s ------------------------------------------------------------ */
  if (profile.pays1099Contractors) {
    push(
      'form_1099_nec_recipients',
      `1099-NEC to contractors — ${year - 1}`,
      businessDay(`${year}-01-31`),
      'Copies of 1099-NEC go to recipients and to the IRS by January 31.',
    );
    push(
      'form_1099_misc_recipients',
      `1099-MISC to recipients — ${year - 1}`,
      businessDay(`${year}-01-31`),
      'Recipient copies of 1099-MISC are generally due January 31; the IRS filing deadline differs by form and filing method.',
    );
    push(
      'form_1099_w9_sweep',
      `Collect missing contractor W-9s — ${year}`,
      businessDay(`${year}-07-15`),
      'A mid-year sweep so January is paperwork, not archaeology. Not a statutory deadline.',
    );
  }

  /* ---- Licences, registrations, insurance -------------------------------- */
  const renewal = profile.renewalMonthDay ?? '01-31';
  push(
    'licenses_renewals',
    `Business licenses, registrations and insurance renewals — ${year}`,
    businessDay(`${year}-${renewal}`),
    profile.renewalMonthDay
      ? 'Renewal anniversary on file for this client.'
      : 'No renewal anniversary on file — this is a placeholder date to review, not a filing deadline.',
  );

  return out.sort((a, b) => a.dueOn.localeCompare(b.dueOn));
}

/* ========================================================================== */
/* Persisting                                                                  */
/* ========================================================================== */

export interface SeedOptions {
  /**
   * Only seed deadlines on or after this date (default: today). Seeding a
   * deadline that has already passed would immediately render as "overdue" for
   * a client we have no evidence actually missed it — inventing a compliance
   * failure is worse than showing nothing. Set `includePast` to override for a
   * deliberate historical backfill.
   */
  readonly from?: string;
  readonly includePast?: boolean;
}

/**
 * Seed a client's calendar for a year. Idempotent on (client, code, due date):
 * running it twice, or re-running after the profile changed, adds what is
 * missing and never duplicates what is there. Existing rows are left alone —
 * a staff member who marked something `done` or `na` keeps that decision.
 */
export async function seedStandardEvents(
  clientId: string,
  year: number = new Date().getUTCFullYear(),
  profile: CalendarProfile = DEFAULT_PROFILE,
  opts: SeedOptions = {},
): Promise<SeedResult> {
  const cutoff = opts.from ?? isoDate(new Date());
  const events = opts.includePast
    ? standardEvents(year, profile)
    : standardEvents(year, profile).filter((e) => e.dueOn >= cutoff);
  if (events.length === 0) return { created: 0, alreadyPresent: 0, events };

  const existing = await db
    .select({ code: complianceEvents.code, dueOn: complianceEvents.dueOn })
    .from(complianceEvents)
    .where(
      and(
        eq(complianceEvents.clientId, clientId),
        inArray(
          complianceEvents.code,
          events.map((e) => e.code),
        ),
      ),
    );
  const have = new Set(existing.map((e) => `${e.code}|${e.dueOn}`));

  const toInsert = events.filter((e) => !have.has(`${e.code}|${e.dueOn}`));
  if (toInsert.length > 0) {
    await db.insert(complianceEvents).values(
      toInsert.map((e) => ({
        clientId,
        code: e.code,
        label: e.label,
        dueOn: e.dueOn,
        notes: e.notes,
        status: 'upcoming' as const,
      })),
    );
  }

  return { created: toInsert.length, alreadyPresent: events.length - toInsert.length, events };
}

/**
 * Seed this year and next, keeping only what is still ahead. Both years are
 * always seeded so that a date which has already gone by this year — the
 * franchise tax report in July, say — still appears with next year's date
 * rather than dropping off the calendar entirely.
 *
 * Called lazily the first time a client opens the calendar, so it is never
 * empty, and idempotent so opening it twice changes nothing.
 */
export async function ensureCalendar(
  clientId: string,
  profile: CalendarProfile = DEFAULT_PROFILE,
  asOf = new Date(),
): Promise<SeedResult> {
  const year = asOf.getUTCFullYear();
  const opts = { from: isoDate(asOf) };
  const first = await seedStandardEvents(clientId, year, profile, opts);
  const second = await seedStandardEvents(clientId, year + 1, profile, opts);
  return {
    created: first.created + second.created,
    alreadyPresent: first.alreadyPresent + second.alreadyPresent,
    events: [...first.events, ...second.events],
  };
}

/* ========================================================================== */
/* Reading                                                                     */
/* ========================================================================== */

/**
 * The client-facing calendar: what is coming, how long there is, and anything
 * already past due. Scoped by an explicit clientId resolved from the session.
 */
export async function upcomingEvents(
  clientId: string,
  opts: { readonly limit?: number; readonly asOf?: Date; readonly lookbackDays?: number } = {},
): Promise<CountdownEvent[]> {
  const asOf = opts.asOf ?? new Date();
  const from = isoDate(new Date(asOf.getTime() - (opts.lookbackDays ?? 60) * DAY_MS));

  const rows = await db
    .select()
    .from(complianceEvents)
    .where(
      and(
        eq(complianceEvents.clientId, clientId),
        gte(complianceEvents.dueOn, from),
        inArray(complianceEvents.status, ['upcoming', 'in_progress']),
      ),
    )
    .orderBy(asc(complianceEvents.dueOn))
    .limit(opts.limit ?? 12);

  const today = Date.parse(`${isoDate(asOf)}T00:00:00Z`);
  return rows.map((r) => {
    const daysAway = Math.round((Date.parse(`${r.dueOn}T00:00:00Z`) - today) / DAY_MS);
    return {
      id: r.id,
      code: r.code,
      label: r.label,
      dueOn: r.dueOn,
      notes: r.notes,
      status: r.status,
      daysAway,
      overdue: daysAway < 0,
      countdown: countdownLabel(daysAway),
    };
  });
}

export function countdownLabel(daysAway: number): string {
  if (daysAway === 0) return 'due today';
  if (daysAway === 1) return 'due tomorrow';
  if (daysAway === -1) return '1 day overdue';
  if (daysAway < 0) return `${-daysAway} days overdue`;
  if (daysAway < 14) return `in ${daysAway} days`;
  if (daysAway < 60) return `in ${Math.round(daysAway / 7)} weeks`;
  return `in ${Math.round(daysAway / 30)} months`;
}

/* ========================================================================== */
/* Helpers                                                                     */
/* ========================================================================== */

/**
 * Roll a weekend date forward to the next weekday. Federal holidays are not
 * modelled — see the module header. A date here is a prompt to confirm.
 */
export function businessDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDay();
  if (day === 6) d.setUTCDate(d.getUTCDate() + 2); // Saturday → Monday
  if (day === 0) d.setUTCDate(d.getUTCDate() + 1); // Sunday → Monday
  return isoDate(d);
}

function quarterLabel(key: string, year: number): string {
  switch (key) {
    case 'q4_prior':
      return `Q4 ${year - 1}`;
    case 'q1':
      return `Q1 ${year}`;
    case 'q2':
      return `Q2 ${year}`;
    default:
      return `Q3 ${year}`;
  }
}
