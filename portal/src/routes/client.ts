/**
 * The client-facing mobile experience.
 *
 *   GET  /m                        mobile home — cash, runway, what we need
 *   GET  /mobile                   → /m
 *   GET  /questions                open questions, one tap to answer
 *   POST /questions/:id/answer     records the answer
 *   GET  /needs                    what we still need from you
 *   GET  /insights                 close summary, anomalies, health, calendar
 *   GET  /sw.js                    the service worker (root scope)
 *   GET  /manifest.webmanifest     the install manifest
 *
 * ## Three rules this file does not bend
 *
 * 1. **Client scope comes from the session.** Every handler goes through
 *    `resolveClientId`, which for a `client` role returns the client_id on the
 *    user row and never consults the URL or the body (auth/guards.ts). There is
 *    no route here that takes a client id as a parameter.
 * 2. **Never render an unapproved narrative.** The close summary query requires
 *    `narrative_approved_at IS NOT NULL` in SQL — a draft cannot reach a client
 *    even if a template forgets to check. Human-in-the-loop is a guardrail, not
 *    a preference (CLIENT-PLATFORM-STRATEGY.md §3).
 * 3. **Never render an unshared anomaly.** Same shape: `status = 'shared'` is in
 *    the WHERE clause, not in the view.
 *
 * And a fourth, everywhere: no account numbers. Views receive `mask` (last
 * four) only; the external feed ids are never selected.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  anomalies,
  clientQuestions,
  closePeriods,
  documentRequests,
  transactions,
} from '../db/schema.js';
import { requireAuth, resolveClientId, isStaff } from '../auth/guards.js';
import { audit } from '../lib/audit.js';
import { config } from '../config.js';
import {
  captureStatusLabel,
  channelLabel,
  mobileHome,
} from '../services/clientDashboard.js';
import { groupChecks, latestHealthScore } from '../services/healthScore.js';
import { INFORMATIONAL_NOTICE, ensureCalendar, upcomingEvents } from '../services/compliance.js';

/** Max characters we will store for a free-text answer. */
const ANSWER_MAX = 500;

const pwaDir = path.join(config.publicDir, 'pwa');

export async function clientRoutes(app: FastifyInstance): Promise<void> {
  /* ====================================================================== */
  /* PWA plumbing — served from the root so the scope covers the whole app   */
  /* ====================================================================== */

  /**
   * The service worker is served from `/sw.js` rather than `/assets/pwa/sw.js`
   * on purpose: a worker's default scope is its own directory, and a worker
   * under /assets could not control /m. Serving it from the root gives it root
   * scope without needing a Service-Worker-Allowed override.
   */
  app.get('/sw.js', async (_req, reply) => {
    const body = await readFile(path.join(pwaDir, 'sw.js'), 'utf8');
    return reply
      .type('text/javascript; charset=utf-8')
      .header('Service-Worker-Allowed', '/')
      .header('Cache-Control', 'no-cache')
      .send(body);
  });

  /** Root-scoped so `scope: "/"` and `start_url: "/m"` are both inside it. */
  app.get('/manifest.webmanifest', async (_req, reply) => {
    const body = await readFile(path.join(pwaDir, 'manifest.webmanifest'), 'utf8');
    return reply
      .type('application/manifest+json; charset=utf-8')
      .header('Cache-Control', 'public, max-age=3600')
      .send(body);
  });

  /* ====================================================================== */
  /* GET /m — the mobile home                                               */
  /* ====================================================================== */

  app.get('/mobile', { preHandler: requireAuth }, async (req, reply) => {
    const q = isStaff(req) && resolveClientId(req) ? `?client=${resolveClientId(req)}` : '';
    return reply.redirect(`/m${q}`, 303);
  });

  app.get('/m', { preHandler: requireAuth }, async (req, reply) => {
    const clientId = resolveClientId(req);
    if (!clientId) return reply.redirect(isStaff(req) ? '/admin' : '/login', 303);

    const home = await mobileHome(clientId);

    return reply.viewPage('client/mobile.eta', {
      title: 'Home',
      cash: home.cash,
      runway: home.runway,
      needs: home.needs,
      captures: home.captures.map((c) => ({
        ...c,
        channelLabel: channelLabel(c.channel),
        statusLabel: captureStatusLabel(c.status),
      })),
    });
  });

  /* ====================================================================== */
  /* GET /questions — one tap to answer                                     */
  /* ====================================================================== */

  app.get('/questions', { preHandler: requireAuth }, async (req, reply) => {
    const clientId = resolveClientId(req);
    if (!clientId) return reply.redirect(isStaff(req) ? '/admin' : '/login', 303);

    const open = await db
      .select({
        id: clientQuestions.id,
        question: clientQuestions.question,
        choices: clientQuestions.choices,
        createdAt: clientQuestions.createdAt,
        transactionId: clientQuestions.transactionId,
        txnDescription: transactions.description,
        txnCounterparty: transactions.counterparty,
        txnAmountCents: transactions.amountCents,
        txnPostedAt: transactions.postedAt,
      })
      .from(clientQuestions)
      .leftJoin(transactions, eq(clientQuestions.transactionId, transactions.id))
      .where(and(eq(clientQuestions.clientId, clientId), isNull(clientQuestions.answeredAt)))
      .orderBy(asc(clientQuestions.createdAt))
      .limit(50);

    const answered = await db
      .select({
        id: clientQuestions.id,
        question: clientQuestions.question,
        answer: clientQuestions.answer,
        answeredAt: clientQuestions.answeredAt,
        answeredVia: clientQuestions.answeredVia,
      })
      .from(clientQuestions)
      .where(and(eq(clientQuestions.clientId, clientId), isNotNull(clientQuestions.answeredAt)))
      .orderBy(desc(clientQuestions.answeredAt))
      .limit(5);

    return reply.viewPage('client/questions.eta', {
      title: 'Questions',
      open: open.map((q) => ({ ...q, choices: normalizeChoices(q.choices) })),
      answered,
    });
  });

  /**
   * Record an answer. The lookup is scoped by client_id as well as id, so an
   * id belonging to another client is simply not found — the same shape as
   * documents.ts. Already-answered questions are not re-opened: a double tap
   * on a slow connection must not overwrite the first answer.
   */
  app.post<{ Params: { id: string } }>(
    '/questions/:id/answer',
    { preHandler: requireAuth },
    async (req, reply) => {
      const clientId = resolveClientId(req);
      if (!clientId) return reply.redirect(isStaff(req) ? '/admin' : '/login', 303);

      const body = (req.body ?? {}) as Record<string, unknown>;
      const raw = typeof body['answer'] === 'string' ? body['answer'] : '';
      const other = typeof body['other'] === 'string' ? body['other'] : '';
      const answer = (raw.trim() || other.trim()).slice(0, ANSWER_MAX);

      const dest = isStaff(req) ? `/questions?client=${clientId}` : '/questions';
      if (!answer) {
        return reply.flash('error', 'Pick an answer or type one first.').redirect(dest, 303);
      }

      const question = await db.query.clientQuestions.findFirst({
        where: and(eq(clientQuestions.id, req.params.id), eq(clientQuestions.clientId, clientId)),
      });
      if (!question) {
        return reply.code(404).viewPage('error.eta', {
          title: 'Not found',
          message: 'That question doesn’t exist.',
        });
      }
      if (question.answeredAt) {
        return reply.flash('ok', 'That one was already answered — thanks.').redirect(dest, 303);
      }

      await db
        .update(clientQuestions)
        .set({ answer, answeredAt: new Date(), answeredVia: 'portal' })
        .where(and(eq(clientQuestions.id, question.id), isNull(clientQuestions.answeredAt)));

      await audit(req, {
        action: 'client_question.answered',
        clientId,
        entity: 'client_question',
        entityId: question.id,
        meta: { via: 'portal', length: answer.length },
      });

      return reply.flash('ok', 'Got it — thanks. That’s one less thing.').redirect(dest, 303);
    },
  );

  /* ====================================================================== */
  /* GET /needs — what we still need from you                               */
  /* ====================================================================== */

  app.get('/needs', { preHandler: requireAuth }, async (req, reply) => {
    const clientId = resolveClientId(req);
    if (!clientId) return reply.redirect(isStaff(req) ? '/admin' : '/login', 303);

    const rows = await db
      .select()
      .from(documentRequests)
      .where(and(eq(documentRequests.clientId, clientId), eq(documentRequests.status, 'open')))
      .orderBy(asc(documentRequests.dueAt), desc(documentRequests.createdAt))
      .limit(200);

    // Grouped by what kind of thing it is, which is exactly how the request was
    // derived in services/documentRequests.ts: a transaction means a receipt,
    // an account means a statement, neither means a W-9.
    const groups = [
      { key: 'receipt', title: 'Receipts', blurb: 'A photo of the receipt is enough.', items: [] as typeof rows },
      { key: 'statement', title: 'Statements', blurb: 'A PDF from the bank, or a photo of the paper copy.', items: [] as typeof rows },
      { key: 'w9', title: 'W-9s and other paperwork', blurb: 'Collecting these now makes January painless.', items: [] as typeof rows },
    ];
    for (const r of rows) {
      const key = r.transactionId ? 'receipt' : r.accountId ? 'statement' : 'w9';
      groups.find((g) => g.key === key)?.items.push(r);
    }

    return reply.viewPage('client/needs.eta', {
      title: 'What we need',
      groups: groups.filter((g) => g.items.length > 0),
      total: rows.length,
    });
  });

  /* ====================================================================== */
  /* GET /insights — approved narrative, shared anomalies, health, calendar  */
  /* ====================================================================== */

  app.get('/insights', { preHandler: requireAuth }, async (req, reply) => {
    const clientId = resolveClientId(req);
    if (!clientId) return reply.redirect(isStaff(req) ? '/admin' : '/login', 303);

    // ---- The hard rule, expressed in SQL -------------------------------
    // An unapproved draft narrative cannot be selected, so it cannot be
    // rendered. `narrativeApprovedAt IS NOT NULL` is the gate; a narrative that
    // exists but has not been signed off simply is not in this result set.
    const [close] = await db
      .select({
        id: closePeriods.id,
        periodStart: closePeriods.periodStart,
        periodEnd: closePeriods.periodEnd,
        narrative: closePeriods.narrative,
        narrativeApprovedAt: closePeriods.narrativeApprovedAt,
        deliveredAt: closePeriods.deliveredAt,
      })
      .from(closePeriods)
      .where(
        and(
          eq(closePeriods.clientId, clientId),
          isNotNull(closePeriods.narrative),
          isNotNull(closePeriods.narrativeApprovedAt),
        ),
      )
      .orderBy(desc(closePeriods.periodEnd))
      .limit(1);

    // ---- Shared anomalies only -----------------------------------------
    // 'open', 'confirmed' and 'dismissed' are firm-side states. Only a human
    // moving one to 'shared' puts it in front of the client.
    const shared = await db
      .select({
        id: anomalies.id,
        kind: anomalies.kind,
        severity: anomalies.severity,
        summary: anomalies.summary,
        createdAt: anomalies.createdAt,
        sharedWithClientAt: anomalies.sharedWithClientAt,
      })
      .from(anomalies)
      .where(and(eq(anomalies.clientId, clientId), eq(anomalies.status, 'shared')))
      .orderBy(desc(anomalies.sharedWithClientAt), desc(anomalies.createdAt))
      .limit(20);

    // A calendar nobody seeded is not a feature. Seed on first view.
    await ensureCalendar(clientId);

    const [health, calendar] = await Promise.all([
      latestHealthScore(clientId),
      upcomingEvents(clientId, { limit: 10 }),
    ]);

    return reply.viewPage('client/insights.eta', {
      title: 'Insights',
      close: close ?? null,
      anomalies: shared.map((a) => ({ ...a, kindLabel: anomalyKindLabel(a.kind) })),
      health,
      healthGroups: groupChecks(health.checks),
      calendar,
      complianceNotice: INFORMATIONAL_NOTICE,
    });
  });
}

/* ========================================================================== */
/* Helpers                                                                     */
/* ========================================================================== */

/**
 * `choices` is jsonb, so it is whatever was written. Coerce defensively to a
 * short list of short strings before a template ever sees it.
 */
function normalizeChoices(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((c): c is string => typeof c === 'string')
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && c.length <= 80)
    .slice(0, 8);
}

function anomalyKindLabel(kind: string): string {
  switch (kind) {
    case 'duplicate_payment':
      return 'Possible duplicate payment';
    case 'price_increase':
      return 'Price increase';
    case 'unusual_amount':
      return 'Unusual amount';
    case 'new_vendor':
      return 'New vendor';
    case 'slow_paying_customer':
      return 'Customer paying slower';
    case 'missing_deposit':
      return 'Missing deposit';
    default:
      return 'Worth a look';
  }
}
