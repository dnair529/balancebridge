/**
 * Extraction → transaction matching. **Deterministic. No AI.**
 *
 * A receipt is matched to a bank line by arithmetic and dates, not by
 * inference: the amount either equals the charge or it does not. Keeping this
 * out of the model is what makes it explainable to a bookkeeper ("$412.83 on
 * the 14th, Home Depot, one candidate") and reproducible a year later in an
 * audit.
 *
 * Scoring, out of 100:
 *
 * | Signal   | Weight | Rule                                                  |
 * |----------|--------|-------------------------------------------------------|
 * | amount   | 0-55   | exact cents 55 · ≤2¢ 48 · within tolerance 38 · else ✗ |
 * | date     | 0-25   | same day 25 · ≤2 days 20 · within window 12 · else ✗   |
 * | vendor   | 0-20   | normalised equal 20 · token overlap ×20 · unknown 4    |
 *
 * Amount and date are **gates**, not just weights: outside tolerance or
 * outside the window is not a weak match, it is not a match. A wrong match is
 * far more expensive than no match.
 */

import { and, between, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { transactions, txnMatches } from '../db/schema.js';
import { normalizeVendor } from '../ai/format.js';
import { intakeConfig } from './config.js';

export interface MatchInput {
  readonly clientId: string;
  /** Positive magnitude in cents. Receipts are money out; sign is ignored. */
  readonly amountCents: number | null;
  /** YYYY-MM-DD from the document, or null. */
  readonly date: string | null;
  readonly vendor: string | null;
  /** Overrides for a caller that wants a wider or narrower sweep. */
  readonly dateWindowDays?: number;
  readonly amountToleranceCents?: number;
  /** Exclude transactions that already carry a live match. Default true. */
  readonly excludeAlreadyMatched?: boolean;
}

export interface MatchCandidate {
  readonly transactionId: string;
  readonly postedAt: string;
  readonly description: string;
  readonly counterparty: string | null;
  readonly amountCents: number;
  readonly accountId: string;
  readonly categoryId: string | null;
  /** 0-100. */
  readonly confidence: number;
  readonly amountScore: number;
  readonly dateScore: number;
  readonly vendorScore: number;
  /** Human-readable, in the bookkeeper's language. */
  readonly why: string;
}

export interface MatchResult {
  readonly candidates: readonly MatchCandidate[];
  readonly best: MatchCandidate | null;
  /** True when the top candidate clears the auto-file bar and is unambiguous. */
  readonly confident: boolean;
  readonly reasoning: string;
}

const AMOUNT_EXACT = 55;
const AMOUNT_NEAR = 48;
const AMOUNT_TOLERANT = 38;
const DATE_SAME = 25;
const DATE_CLOSE = 20;
const DATE_WINDOW = 12;
const VENDOR_EXACT = 20;
const VENDOR_UNKNOWN = 4;

/** A second candidate this close to the winner means "ask a human". */
const AMBIGUITY_MARGIN = 8;

/**
 * Rank the transactions an extraction could belong to.
 *
 * Only reads. Persisting the winner is the pipeline's job, and only after the
 * confidence gate.
 */
export async function matchExtraction(input: MatchInput): Promise<MatchResult> {
  const windowDays = input.dateWindowDays ?? intakeConfig.match.dateWindowDays;
  const tolerance = input.amountToleranceCents ?? intakeConfig.match.amountToleranceCents;
  const amount = input.amountCents === null ? null : Math.abs(input.amountCents);

  if (amount === null || amount === 0) {
    return {
      candidates: [],
      best: null,
      confident: false,
      reasoning:
        'No total could be read from the document, so there is nothing to match on. ' +
        'Amount is a gate, not a hint — matching on vendor and date alone would be a guess.',
    };
  }

  // Without a date we still match, but only inside the client's whole ledger on
  // amount + vendor, and the missing date costs the full date weight.
  const window = input.date ? dateWindow(input.date, windowDays) : null;

  const rows = await db.query.transactions.findMany({
    where: window
      ? and(
          eq(transactions.clientId, input.clientId),
          between(transactions.postedAt, window.from, window.to),
        )
      : eq(transactions.clientId, input.clientId),
    limit: 500,
  });

  const excluded = input.excludeAlreadyMatched === false ? new Set<string>() : await matchedTxnIds();

  const docVendor = normalizeVendor(input.vendor);
  const candidates: MatchCandidate[] = [];

  for (const t of rows) {
    if (excluded.has(t.id)) continue;

    const amountScore = scoreAmount(amount, Math.abs(t.amountCents), tolerance);
    if (amountScore === null) continue; // gate

    const dateScore = input.date ? scoreDate(input.date, t.postedAt, windowDays) : 0;
    if (input.date && dateScore === null) continue; // gate

    const vendor = scoreVendor(docVendor, t.counterparty, t.description);
    const confidence = Math.min(100, amountScore + (dateScore ?? 0) + vendor.score);

    candidates.push({
      transactionId: t.id,
      postedAt: t.postedAt,
      description: t.description,
      counterparty: t.counterparty,
      amountCents: t.amountCents,
      accountId: t.accountId,
      categoryId: t.categoryId,
      confidence,
      amountScore,
      dateScore: dateScore ?? 0,
      vendorScore: vendor.score,
      why: [
        amountReason(amountScore, amount, Math.abs(t.amountCents)),
        input.date ? dateReason(input.date, t.postedAt) : 'no date on the document',
        vendor.why,
      ].join('; '),
    });
  }

  candidates.sort((a, b) => b.confidence - a.confidence || a.postedAt.localeCompare(b.postedAt));
  const best = candidates[0] ?? null;
  const runnerUp = candidates[1] ?? null;

  const ambiguous =
    best !== null && runnerUp !== null && best.confidence - runnerUp.confidence < AMBIGUITY_MARGIN;

  const confident =
    best !== null && best.confidence >= intakeConfig.match.autofileConfidence && !ambiguous;

  return {
    candidates: candidates.slice(0, 10),
    best,
    confident,
    reasoning: describe(candidates.length, best, runnerUp, ambiguous, windowDays, tolerance),
  };
}

/* -------------------------------------------------------------------------- */
/* Scoring — pure functions, unit-testable without a database                  */
/* -------------------------------------------------------------------------- */

/** Null = outside tolerance, i.e. not a candidate at all. */
export function scoreAmount(docCents: number, txnCents: number, toleranceCents: number): number | null {
  const delta = Math.abs(docCents - txnCents);
  if (delta === 0) return AMOUNT_EXACT;
  if (delta <= 2) return AMOUNT_NEAR; // rounding on a printed receipt
  if (delta <= toleranceCents) return AMOUNT_TOLERANT; // tip added, cash back
  return null;
}

/** Null = outside the window. */
export function scoreDate(docDate: string, txnDate: string, windowDays: number): number | null {
  const gap = Math.abs(daysApart(docDate, txnDate));
  if (!Number.isFinite(gap)) return null;
  if (gap === 0) return DATE_SAME;
  if (gap <= 2) return DATE_CLOSE;
  if (gap <= windowDays) return DATE_WINDOW;
  return null;
}

/**
 * Vendor similarity over normalised strings. `normalizeVendor` already strips
 * card-processor prefixes, embedded dates and terminal numbers, which is what
 * makes "SQ *THE HOME DEPOT 6574" and "The Home Depot" comparable at all.
 */
export function scoreVendor(
  docVendorNormalized: string,
  counterparty: string | null,
  description: string,
): { score: number; why: string } {
  if (!docVendorNormalized) {
    return { score: VENDOR_UNKNOWN, why: 'no vendor on the document to compare' };
  }
  const txnVendor = normalizeVendor(counterparty ?? description);
  if (!txnVendor) {
    return { score: VENDOR_UNKNOWN, why: 'transaction has no readable counterparty' };
  }
  if (txnVendor === docVendorNormalized) {
    return { score: VENDOR_EXACT, why: `vendor matches exactly ("${txnVendor}")` };
  }
  if (txnVendor.includes(docVendorNormalized) || docVendorNormalized.includes(txnVendor)) {
    return { score: Math.round(VENDOR_EXACT * 0.85), why: `vendor contained ("${txnVendor}")` };
  }

  const overlap = tokenOverlap(docVendorNormalized, txnVendor);
  if (overlap === 0) {
    return { score: 0, why: `vendor differs ("${txnVendor}")` };
  }
  return {
    score: Math.round(VENDOR_EXACT * overlap),
    why: `vendor ${Math.round(overlap * 100)}% word overlap with "${txnVendor}"`,
  };
}

/** Dice coefficient over words — stable, cheap, and explainable. */
export function tokenOverlap(a: string, b: string): number {
  const at = new Set(a.split(/\s+/).filter((w) => w.length > 1));
  const bt = new Set(b.split(/\s+/).filter((w) => w.length > 1));
  if (at.size === 0 || bt.size === 0) return 0;
  let shared = 0;
  for (const w of at) if (bt.has(w)) shared += 1;
  return (2 * shared) / (at.size + bt.size);
}

/** Whole days between two YYYY-MM-DD strings. */
export function daysApart(a: string, b: string): number {
  const ms = Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ms)) return Number.POSITIVE_INFINITY;
  return Math.round(ms / 86_400_000);
}

export function dateWindow(date: string, days: number): { from: string; to: string } {
  const base = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(base)) return { from: date, to: date };
  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(base - days * 86_400_000), to: iso(base + days * 86_400_000) };
}

/* -------------------------------------------------------------------------- */

async function matchedTxnIds(): Promise<Set<string>> {
  const rows = await db
    .select({ transactionId: txnMatches.transactionId })
    .from(txnMatches)
    .where(isNull(txnMatches.rejectedAt));
  return new Set(rows.map((r) => r.transactionId));
}

function amountReason(score: number, docCents: number, txnCents: number): string {
  if (score === AMOUNT_EXACT) return `amount matches to the cent (${fmt(docCents)})`;
  const delta = Math.abs(docCents - txnCents);
  return `amount within ${fmt(delta)} (${fmt(docCents)} vs ${fmt(txnCents)})`;
}

function dateReason(docDate: string, txnDate: string): string {
  const gap = Math.abs(daysApart(docDate, txnDate));
  if (gap === 0) return `same day (${txnDate})`;
  return `${gap} day${gap === 1 ? '' : 's'} apart (${docDate} vs ${txnDate})`;
}

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function describe(
  total: number,
  best: MatchCandidate | null,
  runnerUp: MatchCandidate | null,
  ambiguous: boolean,
  windowDays: number,
  tolerance: number,
): string {
  const scope = `Searched this client's transactions within ±${windowDays} days and ±${fmt(tolerance)}.`;
  if (!best) {
    return `${scope} No transaction cleared the amount and date gates, so nothing is proposed.`;
  }
  if (ambiguous && runnerUp) {
    return (
      `${scope} ${total} candidate(s). Top two are within ${best.confidence - runnerUp.confidence} points ` +
      `(${best.postedAt} ${best.description} and ${runnerUp.postedAt} ${runnerUp.description}) — ` +
      'too close to auto-file, so a human picks.'
    );
  }
  return `${scope} ${total} candidate(s). Best scored ${best.confidence}: ${best.why}.`;
}
