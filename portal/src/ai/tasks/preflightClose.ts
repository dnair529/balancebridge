/**
 * Task: close pre-flight.
 *
 * Only files that pass pre-flight reach the reviewer. This is the mechanism
 * that lets client count grow **without error rate growing** — the failure mode
 * that kills scaling firms (STAFF-WORKSPACE.md §6).
 *
 * ## Deterministic truth wins
 *
 * A model does not get to mark a failing check as passed. The blocking checks
 * (`UNCATEGORIZED`, `RECONCILED`) are computed here from the supplied counts,
 * and {@link reconcileWithTruth} overwrites the provider's verdict wherever the
 * two disagree — recording that it did. The model's contribution is narrative
 * detail on the softer checks, not the gate itself.
 */

import { Suggestion } from '../../lib/ai-guard.js';
import { clampConfidence, money } from '../format.js';
import { buildRequest } from '../request.js';
import { requireJson, runTask } from '../index.js';
import type { RunLogger } from '../runlog.js';
import type { AiProvider } from '../provider.js';
import type { CheckModel, PeriodRef, PreflightFacts, PreflightPayload, PreflightResultModel } from '../payloads.js';

export interface PreflightCloseInput {
  readonly clientId: string;
  readonly userId?: string | null;
  readonly closePeriodId: string;
  readonly period: PeriodRef;
  readonly facts: PreflightFacts;
  readonly provider?: AiProvider;
  readonly threshold?: number;
  readonly logger?: RunLogger;
}

export interface CloseCheck {
  readonly code: string;
  readonly label: string;
  readonly severity: 'info' | 'warn' | 'block';
  readonly passed: boolean;
  readonly detail: string;
}

export interface PreflightResult {
  readonly checks: readonly CloseCheck[];
  /** True only when no blocking check failed. */
  readonly readyForReview: boolean;
  readonly blockingFailures: number;
  readonly warnings: number;
  readonly confidence: number;
  readonly reasoning: string;
  readonly needsHuman: boolean;
}

const SEVERITIES = ['info', 'warn', 'block'] as const;

const SCHEMA = {
  type: 'object',
  required: ['checks', 'confidence', 'reasoning'],
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['code', 'label', 'severity', 'passed', 'detail'],
        properties: {
          code: { type: 'string' },
          label: { type: 'string' },
          severity: { type: 'string', enum: SEVERITIES },
          passed: { type: 'boolean' },
          detail: { type: 'string' },
        },
      },
    },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    reasoning: { type: 'string' },
  },
};

/**
 * Checks whose verdict is arithmetic, not judgment. Whatever a provider says
 * about these, the count decides.
 */
function deterministicVerdicts(facts: PreflightFacts): Map<string, { passed: boolean; detail: string }> {
  return new Map<string, { passed: boolean; detail: string }>([
    [
      'UNCATEGORIZED',
      {
        passed: facts.uncategorizedCount === 0,
        detail:
          facts.uncategorizedCount === 0
            ? `All ${facts.totalTransactions} transactions carry a category.`
            : `${facts.uncategorizedCount} of ${facts.totalTransactions} transactions are uncategorised.`,
      },
    ],
    [
      'RECONCILED',
      {
        passed: facts.unreconciledAccounts.length === 0,
        detail:
          facts.unreconciledAccounts.length === 0
            ? 'Every account ties to its statement.'
            : `${facts.unreconciledAccounts.length} account(s) unreconciled: ${facts.unreconciledAccounts
                .map((a) => `${a.name} (${money(a.varianceCents)} out)`)
                .join(', ')}.`,
      },
    ],
    [
      'OPEN_QUESTIONS',
      {
        passed: facts.unansweredQuestions === 0,
        detail:
          facts.unansweredQuestions === 0
            ? 'No questions outstanding with the client.'
            : `${facts.unansweredQuestions} question(s) still with the client.`,
      },
    ],
    [
      'SUPPORTING_DOCS',
      {
        passed: facts.missingDocuments.length === 0,
        detail:
          facts.missingDocuments.length === 0
            ? 'Every transaction that needs a receipt has one.'
            : `${facts.missingDocuments.length} document(s) still outstanding.`,
      },
    ],
  ]);
}

export async function preflightClose(input: PreflightCloseInput): Promise<Suggestion<PreflightResult>> {
  const payload: PreflightPayload = {
    clientId: input.clientId,
    closePeriodId: input.closePeriodId,
    period: input.period,
    facts: input.facts,
  };

  const request = buildRequest({
    task: 'preflight',
    clientId: input.clientId,
    payload,
    jsonSchema: SCHEMA,
    instructions:
      `Run the close pre-flight for ${input.period.label}. Return one check per condition, each with a detail ` +
      'sentence naming the specific counts, accounts, or amounts. Judge only from the facts below. Do not soften ' +
      'a failing count — nothing reaches a reviewer until the blocking checks pass.',
  });

  const truth = deterministicVerdicts(input.facts);

  return runTask<PreflightResult>({
    task: 'preflight',
    clientId: input.clientId,
    userId: input.userId ?? null,
    request,
    relatedEntity: 'close_periods',
    relatedId: input.closePeriodId,
    provider: input.provider,
    threshold: input.threshold,
    logger: input.logger,
    parse: (res) => {
      const raw = requireJson<Partial<PreflightResultModel>>(res, res.model, 'close pre-flight');
      const list = Array.isArray(raw.checks) ? (raw.checks as Partial<CheckModel>[]) : [];

      const normalized: CloseCheck[] = list
        .filter((c) => typeof c.code === 'string' && c.code.trim())
        .map((c) => ({
          code: (c.code as string).trim().toUpperCase(),
          label: typeof c.label === 'string' && c.label.trim() ? c.label.trim() : (c.code as string),
          severity: SEVERITIES.includes(c.severity as (typeof SEVERITIES)[number])
            ? (c.severity as (typeof SEVERITIES)[number])
            : 'warn',
          passed: c.passed === true,
          detail: typeof c.detail === 'string' ? c.detail.trim() : '',
        }));

      const { checks, overrides } = reconcileWithTruth(normalized, truth, input.facts);

      const blockingFailures = checks.filter((c) => !c.passed && c.severity === 'block').length;
      const warnings = checks.filter((c) => !c.passed && c.severity === 'warn').length;
      const confidence = clampConfidence(Number(raw.confidence ?? 0));

      const reasoning =
        (typeof raw.reasoning === 'string' && raw.reasoning.trim()
          ? raw.reasoning.trim()
          : 'No reasoning supplied by the provider.') +
        (overrides.length
          ? ` Deterministic override applied to ${overrides.length} check(s) where the provider disagreed with the supplied counts: ${overrides.join(', ')}.`
          : '') +
        ` Verdict: ${blockingFailures} blocking failure(s), ${warnings} warning(s).`;

      const value: PreflightResult = {
        checks,
        readyForReview: blockingFailures === 0,
        blockingFailures,
        warnings,
        confidence,
        reasoning,
        needsHuman: false, // set by the gate below
      };
      return { value, confidence, reasoning };
    },
  }).then((s) => s.map((v) => ({ ...v, needsHuman: s.needsHuman, reasoning: s.meta.reasoning })));
}

/**
 * Overwrite provider verdicts with arithmetic where the two disagree, and add
 * any deterministic check the provider omitted entirely.
 */
function reconcileWithTruth(
  checks: readonly CloseCheck[],
  truth: ReadonlyMap<string, { passed: boolean; detail: string }>,
  facts: PreflightFacts,
): { checks: CloseCheck[]; overrides: string[] } {
  const overrides: string[] = [];
  const seen = new Set<string>();

  const result: CloseCheck[] = checks.map((c) => {
    seen.add(c.code);
    const t = truth.get(c.code);
    if (!t) return c;
    if (t.passed === c.passed) return c;
    overrides.push(c.code);
    return {
      ...c,
      passed: t.passed,
      detail: `${t.detail} (Provider reported ${c.passed ? 'passed' : 'failed'}; the supplied counts say otherwise.)`,
    };
  });

  // A check the provider simply did not return is still a check we run.
  const LABELS: Record<string, { label: string; severity: 'info' | 'warn' | 'block' }> = {
    UNCATEGORIZED: { label: 'All transactions categorised', severity: 'block' },
    RECONCILED: { label: 'Every account reconciled', severity: 'block' },
    OPEN_QUESTIONS: { label: 'Client questions answered', severity: 'warn' },
    SUPPORTING_DOCS: { label: 'Supporting documents on file', severity: 'warn' },
  };
  for (const [code, t] of truth) {
    if (seen.has(code)) continue;
    const meta = LABELS[code] ?? { label: code, severity: 'warn' as const };
    overrides.push(`${code} (added)`);
    result.push({ code, label: meta.label, severity: meta.severity, passed: t.passed, detail: t.detail });
  }

  // Negative balances are arithmetic too, and easy for a provider to skip.
  if (!seen.has('NEGATIVE_BALANCE') && facts.negativeBalances.length > 0) {
    result.push({
      code: 'NEGATIVE_BALANCE',
      label: 'No impossible balances',
      severity: 'warn',
      passed: false,
      detail: `${facts.negativeBalances.length} account(s) sit negative: ${facts.negativeBalances
        .map((a) => `${a.name} at ${money(a.balanceCents)}`)
        .join(', ')}.`,
    });
    overrides.push('NEGATIVE_BALANCE (added)');
  }

  return { checks: result, overrides };
}
