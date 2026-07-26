/**
 * The staff workspace — the console that determines margin.
 *
 * STAFF-WORKSPACE.md: *"client-facing features win deals; the staff console
 * determines margin."* Seven screens, all staff-only, all keyboard-driven:
 *
 * | Route | What it replaces |
 * |---|---|
 * | `GET /workspace` | "which client do I work on now?" |
 * | `GET /workspace/categorize/:clientId` | one-by-one categorisation |
 * | `GET /workspace/client/:clientId` | ten minutes of reconstruction |
 * | `GET /workspace/close/:clientId` | a checklist in somebody's head |
 * | `GET /workspace/anomalies` | the client noticing first |
 * | `GET /workspace/precedents` | asking whoever has been here longest |
 * | `GET /workspace/capacity` | not knowing who you lose money on |
 *
 * Every route is behind `requireStaff` via a scope-level hook, so a `client`
 * role gets 403 on all of them — including any route added later. Every POST
 * goes through the global CSRF hook. Nothing here writes to the ledger on the
 * strength of a model output: the services do that, and only from a
 * `ConfirmedSuggestion`.
 */

import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { anomalies, clients, precedents, users } from '../db/schema.js';
import { requireStaff } from '../auth/guards.js';
import { audit } from '../lib/audit.js';
import { searchPrecedents } from '../ai/tasks/searchPrecedents.js';
import type { PrecedentRef } from '../ai/payloads.js';
import {
  assignToMe,
  buildQueue,
  capacityReport,
  clientBrief,
  closeRiskStrip,
  persistPriorities,
  queueFacets,
  recordBriefView,
  snooze,
  wakeSnoozed,
  WORK_KINDS,
  type WorkKind,
} from '../services/workspace.js';
import {
  applyCategoryToGroup,
  buildCategorizeView,
  suggestForGroup,
  transactionsForGroup,
} from '../services/categorization.js';
import {
  advanceToReview,
  approveNarrative,
  buildCloseView,
  draftCloseNarrative,
  latestPeriod,
  openPeriod,
  runPreflight,
} from '../services/closePeriods.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only ever redirect back inside the workspace — never to a supplied origin. */
function safeReturn(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  if (!raw.startsWith('/workspace')) return fallback;
  if (raw.includes('//') || raw.includes('\\')) return fallback;
  return raw.slice(0, 300);
}

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  // One hook, whole scope: nothing under /workspace is reachable by a client.
  app.addHook('preHandler', requireStaff);

  /* ====================================================================== */
  /* 1. The unified cross-client work queue                                 */
  /* ====================================================================== */

  app.get('/workspace', async (req, reply) => {
    const me = req.authContext!.user;
    const query = (req.query ?? {}) as Record<string, string>;

    // Anything whose snooze expired belongs back in the queue before we rank.
    await wakeSnoozed();

    const kind = WORK_KINDS.includes(query.kind as WorkKind) ? (query.kind as WorkKind) : null;
    const clientFilter = UUID_RE.test(query.client ?? '') ? query.client! : null;
    const assigned = query.assigned === 'me' || query.assigned === 'unassigned' ? query.assigned : null;

    const [rows, risk, facets, clientRows] = await Promise.all([
      buildQueue({ kind, clientId: clientFilter, assigned, userId: me.id }),
      closeRiskStrip(),
      queueFacets(me.id),
      db.query.clients.findMany({ orderBy: [asc(clients.businessName)] }),
    ]);

    // Persist the ranking so anything else reading work_items.priority agrees
    // with what the bookkeeper is looking at.
    await persistPriorities(rows);

    // One flat list, with the client as a grouping label on the row — never a
    // folder you have to open (STAFF-WORKSPACE.md §1).
    let lastClient = '';
    const listed = rows.map((row) => {
      const newGroup = row.clientId !== lastClient;
      lastClient = row.clientId;
      return { ...row, newGroup };
    });

    return reply.viewPage('workspace/queue.eta', {
      title: 'Work queue',
      rows: listed,
      risk,
      facets,
      clientRows,
      filters: { kind, clientId: clientFilter, assigned },
      kinds: WORK_KINDS,
      me,
    });
  });

  app.post<{ Params: { id: string } }>('/workspace/items/:id/assign', async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.callNotFound();
    const me = req.authContext!.user;
    const row = await assignToMe(req.params.id, me.id);
    if (!row) return reply.callNotFound();
    await audit(req, {
      action: 'workspace.item_assign',
      clientId: row.clientId,
      entity: 'work_items',
      entityId: row.id,
      meta: { assignedTo: me.id },
    });
    const back = safeReturn((req.body as Record<string, unknown>)?.return_to, '/workspace');
    return reply.flash('ok', `Assigned "${row.title}" to you.`).redirect(back, 303);
  });

  app.post<{ Params: { id: string } }>('/workspace/items/:id/snooze', async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.callNotFound();
    const body = (req.body ?? {}) as Record<string, string>;
    const days = Math.min(30, Math.max(1, Number.parseInt(body.days ?? '1', 10) || 1));
    const until = new Date(Date.now() + days * 86_400_000);
    const row = await snooze(req.params.id, until);
    if (!row) return reply.callNotFound();
    await audit(req, {
      action: 'workspace.item_snooze',
      clientId: row.clientId,
      entity: 'work_items',
      entityId: row.id,
      meta: { until: until.toISOString(), days },
    });
    const back = safeReturn(body.return_to, '/workspace');
    return reply
      .flash('ok', `Snoozed "${row.title}" for ${days} day${days === 1 ? '' : 's'}.`)
      .redirect(back, 303);
  });

  /* ====================================================================== */
  /* 2. The categorisation co-pilot                                         */
  /* ====================================================================== */

  app.get<{ Params: { clientId: string } }>('/workspace/categorize/:clientId', async (req, reply) => {
    if (!UUID_RE.test(req.params.clientId)) return reply.callNotFound();
    const view = await buildCategorizeView(req.params.clientId, req.authContext!.user.id);
    if (!view) return reply.callNotFound();

    return reply.viewPage('workspace/categorize.eta', {
      title: `Categorize — ${view.client.businessName}`,
      ...view,
    });
  });

  /**
   * Apply a category to N transactions, and learn the rule.
   *
   * The suggestion is **re-derived server-side** from the group's own
   * representative transaction rather than trusted from the form: the browser
   * gets to say which group and which category, never what the model said or
   * how confident it was.
   */
  app.post<{ Params: { clientId: string } }>(
    '/workspace/categorize/:clientId/apply',
    async (req, reply) => {
      const clientId = req.params.clientId;
      if (!UUID_RE.test(clientId)) return reply.callNotFound();
      const me = req.authContext!.user;
      const body = (req.body ?? {}) as Record<string, string>;
      const back = `/workspace/categorize/${clientId}`;

      const groupKey = (body.group_key ?? '').trim();
      if (!groupKey) {
        return reply.flash('error', 'Nothing to apply — no group was submitted.').redirect(back, 303);
      }

      const groupTxns = await transactionsForGroup(clientId, groupKey);
      if (groupTxns.length === 0) {
        return reply
          .flash('ok', 'That group is already cleared — nothing left to categorise.')
          .redirect(back, 303);
      }

      // An explicit subset (expanded, handled individually) or the whole group.
      const requested = (body.transaction_ids ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => UUID_RE.test(s));
      const target = requested.length > 0 ? groupTxns.filter((t) => requested.includes(t.id)) : groupTxns;
      if (target.length === 0) {
        return reply.flash('error', 'None of those transactions are still open.').redirect(back, 303);
      }

      // Re-derive the suggestion so the thing being confirmed is ours.
      const suggestion = await suggestForGroup(clientId, me.id, target[target.length - 1]!);
      const accepting = body.accept === '1';
      const chosenId = UUID_RE.test(body.category_id ?? '')
        ? body.category_id!
        : accepting
          ? (suggestion.value.categoryId ?? '')
          : '';

      if (!UUID_RE.test(chosenId)) {
        return reply
          .flash(
            'error',
            'Pick a category first — the suggestion had none confident enough to apply.',
          )
          .redirect(back, 303);
      }

      // Only attach the AI's confidence when the human actually took its
      // answer. A different pick is a correction, and is recorded as human.
      const tookSuggestion = accepting && suggestion.value.categoryId === chosenId;
      const confirmed = tookSuggestion
        ? suggestion.confirm(me.id, { acknowledgeLowConfidence: suggestion.needsHuman })
        : null;

      const result = await applyCategoryToGroup({
        clientId,
        userId: me.id,
        transactionIds: target.map((t) => t.id),
        categoryId: chosenId,
        confirmed,
        // Unchecked checkboxes send nothing, so "learn" is opt-in on the wire
        // and checked by default in the form.
        learnRule: body.learn === '1',
        counterpartyLabel: (body.counterparty ?? target[0]!.counterparty ?? target[0]!.description).trim(),
      });

      const ruleNote = result.ruleCreated
        ? ' Learned a rule — this vendor won’t cost a decision again.'
        : result.ruleUpdated
          ? ' Repointed the existing rule to the new category.'
          : '';

      return reply
        .flash(
          'ok',
          `Categorized ${result.categorized} transaction${result.categorized === 1 ? '' : 's'} as ${result.categoryName}.${ruleNote}`,
        )
        .redirect(back, 303);
    },
  );

  /* ====================================================================== */
  /* 3. The client context brief                                            */
  /* ====================================================================== */

  app.get<{ Params: { clientId: string } }>('/workspace/client/:clientId', async (req, reply) => {
    if (!UUID_RE.test(req.params.clientId)) return reply.callNotFound();
    const me = req.authContext!.user;
    const brief = await clientBrief(req.params.clientId, me.id);
    if (!brief) return reply.callNotFound();

    // Record the visit AFTER building, so "since you last looked" is the
    // previous visit rather than this one.
    await recordBriefView(req.params.clientId, me.id, req.ip);

    return reply.viewPage('workspace/client.eta', {
      title: brief.client.businessName,
      brief,
    });
  });

  /* ====================================================================== */
  /* 4. Close orchestration                                                 */
  /* ====================================================================== */

  app.get<{ Params: { clientId: string } }>('/workspace/close/:clientId', async (req, reply) => {
    if (!UUID_RE.test(req.params.clientId)) return reply.callNotFound();
    const view = await buildCloseView(req.params.clientId);
    if (!view) return reply.callNotFound();
    return reply.viewPage('workspace/close.eta', {
      title: `Close — ${view.client.businessName}`,
      ...view,
    });
  });

  app.post<{ Params: { clientId: string } }>('/workspace/close/:clientId/open', async (req, reply) => {
    const clientId = req.params.clientId;
    if (!UUID_RE.test(clientId)) return reply.callNotFound();
    const period = await openPeriod(clientId, req.authContext!.user.id);
    return reply
      .flash('ok', `Opened the ${period.periodStart} close period.`)
      .redirect(`/workspace/close/${clientId}`, 303);
  });

  app.post<{ Params: { clientId: string } }>(
    '/workspace/close/:clientId/preflight',
    async (req, reply) => {
      const clientId = req.params.clientId;
      if (!UUID_RE.test(clientId)) return reply.callNotFound();
      const back = `/workspace/close/${clientId}`;
      const period = await latestPeriod(clientId);
      if (!period) {
        return reply.flash('error', 'Open a close period first.').redirect(back, 303);
      }

      const outcome = await runPreflight(clientId, period, req.authContext!.user.id);
      const message = outcome.readyForReview
        ? `Pre-flight clean — ${outcome.checksWritten} checks, ${outcome.warnings} warning${outcome.warnings === 1 ? '' : 's'}. Ready for review.`
        : `Pre-flight found ${outcome.blockingFailures} blocking failure${outcome.blockingFailures === 1 ? '' : 's'}. This period does not reach a reviewer yet.`;
      return reply.flash(outcome.readyForReview ? 'ok' : 'error', message).redirect(back, 303);
    },
  );

  app.post<{ Params: { clientId: string } }>('/workspace/close/:clientId/advance', async (req, reply) => {
    const clientId = req.params.clientId;
    if (!UUID_RE.test(clientId)) return reply.callNotFound();
    const back = `/workspace/close/${clientId}`;
    const period = await latestPeriod(clientId);
    if (!period) return reply.flash('error', 'Open a close period first.').redirect(back, 303);

    const result = await advanceToReview(period, req.authContext!.user.id);
    return reply.flash(result.advanced ? 'ok' : 'error', result.reason).redirect(back, 303);
  });

  app.post<{ Params: { clientId: string } }>(
    '/workspace/close/:clientId/narrative',
    async (req, reply) => {
      const clientId = req.params.clientId;
      if (!UUID_RE.test(clientId)) return reply.callNotFound();
      const back = `/workspace/close/${clientId}`;
      const period = await latestPeriod(clientId);
      if (!period) return reply.flash('error', 'Open a close period first.').redirect(back, 303);

      const outcome = await draftCloseNarrative(clientId, period, req.authContext!.user.id);
      if (!outcome.stored) {
        return reply
          .flash('error', `No narrative stored. ${outcome.draft.suppressionReason ?? outcome.reasoning}`)
          .redirect(back, 303);
      }
      return reply
        .flash(
          'ok',
          `Draft narrative saved at ${outcome.confidence}% confidence. It is a draft — nothing has been sent.`,
        )
        .redirect(back, 303);
    },
  );

  app.post<{ Params: { clientId: string } }>(
    '/workspace/close/:clientId/narrative/approve',
    async (req, reply) => {
      const clientId = req.params.clientId;
      if (!UUID_RE.test(clientId)) return reply.callNotFound();
      const back = `/workspace/close/${clientId}`;
      const period = await latestPeriod(clientId);
      if (!period) return reply.flash('error', 'Open a close period first.').redirect(back, 303);

      const ok = await approveNarrative(period, req.authContext!.user.id);
      return ok
        ? reply
            .flash('ok', 'Narrative approved. Delivery is still a separate, deliberate act.')
            .redirect(back, 303)
        : reply.flash('error', 'There is no draft narrative to approve.').redirect(back, 303);
    },
  );

  /* ====================================================================== */
  /* 5. Cross-client anomaly review                                         */
  /* ====================================================================== */

  app.get('/workspace/anomalies', async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, string>;
    const status = ['open', 'confirmed', 'dismissed', 'shared'].includes(query.status ?? '')
      ? (query.status as 'open' | 'confirmed' | 'dismissed' | 'shared')
      : 'open';

    const rows = await db
      .select({ anomaly: anomalies, clientName: clients.businessName, resolverName: users.name })
      .from(anomalies)
      .innerJoin(clients, eq(clients.id, anomalies.clientId))
      .leftJoin(users, eq(users.id, anomalies.resolvedBy))
      .where(eq(anomalies.status, status))
      .orderBy(desc(anomalies.createdAt))
      .limit(200);

    const counts = await db
      .select({ status: anomalies.status, id: anomalies.id })
      .from(anomalies);
    const byStatus: Record<string, number> = {};
    for (const c of counts) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;

    return reply.viewPage('workspace/anomalies.eta', {
      title: 'Anomalies',
      rows,
      status,
      byStatus,
    });
  });

  app.post<{ Params: { id: string } }>('/workspace/anomalies/:id', async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.callNotFound();
    const body = (req.body ?? {}) as Record<string, string>;
    const action = body.action;
    if (action !== 'confirm' && action !== 'dismiss' && action !== 'share') {
      return reply.flash('error', 'Unknown action.').redirect('/workspace/anomalies', 303);
    }

    const row = await db.query.anomalies.findFirst({ where: eq(anomalies.id, req.params.id) });
    if (!row) return reply.callNotFound();

    const me = req.authContext!.user;
    const status = action === 'confirm' ? 'confirmed' : action === 'dismiss' ? 'dismissed' : 'shared';
    await db
      .update(anomalies)
      .set({
        status,
        resolvedBy: me.id,
        // Sharing is us telling the client first — the whole point of §5.
        sharedWithClientAt: action === 'share' ? new Date() : row.sharedWithClientAt,
      })
      .where(eq(anomalies.id, row.id));

    await audit(req, {
      action: `workspace.anomaly_${action}`,
      clientId: row.clientId,
      entity: 'anomalies',
      entityId: row.id,
      meta: { kind: row.kind, severity: row.severity, summary: row.summary },
    });

    const messages: Record<string, string> = {
      confirm: 'Confirmed — it stays on the client’s record.',
      dismiss: 'Dismissed.',
      share: 'Marked as shared with the client.',
    };
    const back = safeReturn(body.return_to, '/workspace/anomalies');
    return reply.flash('ok', messages[action]!).redirect(back, 303);
  });

  /* ====================================================================== */
  /* 6. Firm memory — precedent search                                      */
  /* ====================================================================== */

  app.get('/workspace/precedents', async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, string>;
    const q = (query.q ?? '').trim().slice(0, 200);
    const clientId = UUID_RE.test(query.client ?? '') ? query.client! : null;

    const [clientRows, all] = await Promise.all([
      db.query.clients.findMany({ orderBy: [asc(clients.businessName)] }),
      db.query.precedents.findMany({
        where: isNull(precedents.archivedAt),
        orderBy: [desc(precedents.createdAt)],
        limit: 500,
      }),
    ]);

    let matches: {
      id: string;
      title: string;
      body: string;
      score: number;
      why: string;
      scope: 'client' | 'firm';
      clientId: string | null;
    }[] = [];
    let aiMeta: { confidence: number; reasoning: string; provider: string } | null = null;

    if (q && clientId) {
      // Client-scoped: run the real task, which filters candidates to this
      // client plus firm-wide before anything is serialised into a prompt.
      const candidates: PrecedentRef[] = all
        .filter((p) => p.clientId === null || p.clientId === clientId)
        .map(toPrecedentRef);
      const suggestion = await searchPrecedents({
        clientId,
        userId: req.authContext!.user.id,
        query: q,
        precedents: candidates,
        limit: 10,
      });
      const byId = new Map(all.map((p) => [p.id, p] as const));
      matches = suggestion.value.matches.map((m) => ({
        id: m.precedentId,
        title: m.title,
        body: m.snippet,
        score: m.score,
        why: m.whyMatched,
        scope: m.scope,
        clientId: byId.get(m.precedentId)?.clientId ?? null,
      }));
      aiMeta = {
        confidence: suggestion.meta.confidence,
        reasoning: suggestion.meta.reasoning,
        provider: suggestion.meta.provider,
      };
    } else if (q) {
      // Firm-wide browse: deterministic local match. No client is selected, so
      // there is no client to scope a prompt to — and firm memory spanning
      // every engagement must never be handed to a provider as one payload.
      matches = localSearch(q, all);
    }

    return reply.viewPage('workspace/precedents.eta', {
      title: 'Firm memory',
      q,
      clientId,
      clientRows,
      matches,
      aiMeta,
      recent: all.slice(0, 12),
      total: all.length,
    });
  });

  app.post('/workspace/precedents', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const title = (body.title ?? '').trim();
    const text = (body.body ?? '').trim();
    if (!title || !text) {
      return reply
        .flash('error', 'A precedent needs a title and the treatment itself.')
        .redirect('/workspace/precedents', 303);
    }
    const clientId = UUID_RE.test(body.client_id ?? '') ? body.client_id! : null;
    const tags = (body.tags ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 12);

    const [row] = await db
      .insert(precedents)
      .values({
        clientId,
        industry: (body.industry ?? '').trim().slice(0, 100) || null,
        title: title.slice(0, 200),
        body: text.slice(0, 20_000),
        tags,
        createdBy: req.authContext!.user.id,
      })
      .returning();

    await audit(req, {
      action: 'workspace.precedent_create',
      clientId,
      entity: 'precedents',
      entityId: row!.id,
      meta: { title: row!.title, scope: clientId ? 'client' : 'firm' },
    });

    return reply
      .flash('ok', `Recorded "${row!.title}" in firm memory.`)
      .redirect('/workspace/precedents', 303);
  });

  /* ====================================================================== */
  /* 7. Capacity and profitability                                          */
  /* ====================================================================== */

  app.get('/workspace/capacity', async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, string>;
    const days = Math.min(365, Math.max(7, Number.parseInt(query.days ?? '90', 10) || 90));
    const rows = await capacityReport(days);
    const flagged = rows.filter((r) => r.flagged);
    const totalMinutes = rows.reduce((n, r) => n + r.minutes, 0);
    const totalFeeCents = rows.reduce((n, r) => n + r.invoicedCents, 0);

    return reply.viewPage('workspace/capacity.eta', {
      title: 'Capacity',
      rows,
      flagged,
      days,
      totalMinutes,
      totalFeeCents,
    });
  });
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function toPrecedentRef(p: typeof precedents.$inferSelect): PrecedentRef {
  return {
    id: p.id,
    clientId: p.clientId,
    title: p.title,
    body: p.body,
    tags: Array.isArray(p.tags) ? (p.tags as string[]) : [],
    industry: p.industry,
    createdAt: p.createdAt.toISOString(),
  };
}

/** Deterministic token overlap. Used when no client is selected to scope to. */
function localSearch(
  q: string,
  rows: readonly (typeof precedents.$inferSelect)[],
): {
  id: string;
  title: string;
  body: string;
  score: number;
  why: string;
  scope: 'client' | 'firm';
  clientId: string | null;
}[] {
  const terms = q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  if (terms.length === 0) return [];

  return rows
    .map((p) => {
      const tags = Array.isArray(p.tags) ? (p.tags as string[]).join(' ').toLowerCase() : '';
      const title = p.title.toLowerCase();
      const body = p.body.toLowerCase();
      const inTitle = terms.filter((t) => title.includes(t));
      const inTags = terms.filter((t) => tags.includes(t));
      const inBody = terms.filter((t) => body.includes(t));
      const raw = inTitle.length * 3 + inTags.length * 3 + inBody.length;
      const score = Math.min(100, Math.round((raw / (terms.length * 3 || 1)) * 100));
      const why: string[] = [];
      if (inTitle.length) why.push(`title mentions ${inTitle.join(', ')}`);
      if (inTags.length) why.push(`tagged ${inTags.join(', ')}`);
      if (inBody.length && !inTitle.length) why.push(`body covers ${inBody.slice(0, 4).join(', ')}`);
      return {
        id: p.id,
        title: p.title,
        body: p.body.length > 240 ? `${p.body.slice(0, 237)}…` : p.body,
        score,
        why: why.length ? `Literal match: ${why.join('; ')}.` : 'no overlap',
        scope: (p.clientId === null ? 'firm' : 'client') as 'client' | 'firm',
        clientId: p.clientId,
        _hits: raw,
      };
    })
    .filter((m) => m._hits > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(({ _hits: _drop, ...m }) => m);
}
