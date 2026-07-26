/**
 * Oversight — the portfolio board, the pending queue, assignment, scorecards,
 * the alert inbox and the threshold dials.
 *
 * These are the screens OVERSIGHT-AND-PERFORMANCE.md §5 and
 * CLIENT-ONBOARDING-AND-ROLES.md §5–§6 ask for. Four access rules run through
 * every route in this file, and they are enforced here rather than trusted to
 * the templates:
 *
 * 1. **Only an admin creates a staff account, assigns, activates, or moves a
 *    threshold.** Creating a bookkeeper account is called out as *exclusive* to
 *    the admin role (§8), so `POST /admin/staff` is guarded by `requireAdmin`
 *    and additionally re-checks the role inside the handler — a belt-and-braces
 *    duplicate for the one action where a mistake mints an account that can see
 *    client financial data.
 *
 * 2. **A staff user never sees an unassigned client.** Anywhere. The staff
 *    routes resolve their client set through `auth/scope.ts`, never through a
 *    hand-rolled `where` clause. `GET /admin/portfolio` — which shows every
 *    client by design — is admin-only for exactly that reason.
 *
 * 3. **A staff user sees their own scorecard and the team median, never a
 *    colleague's numbers** (DECISIONS.md §6). `GET /scorecard` ignores any user
 *    id in the request and reads the session. There is no parameter to tamper
 *    with.
 *
 * 4. **The engagement RAG is never rendered to a client-role user**
 *    (DECISIONS.md §9). Every route here is `requireStaff` or `requireAdmin`,
 *    so a client role gets 403 before a template is chosen.
 *
 * Account creation issues an **invite**, never a password. An admin who can set
 * another person's password can impersonate them, and the audit log would show
 * that person doing it.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { clients, invites, users } from '../db/schema.js';
import { requireAdmin, requireStaff } from '../auth/guards.js';
import { visibleClientIds } from '../auth/scope.js';
import { generateToken, hashToken } from '../auth/tokens.js';
import { audit } from '../lib/audit.js';
import { config } from '../config.js';
import { inviteEmail, sendMail } from '../lib/mail.js';
import {
  DIMENSIONS,
  DIMENSION_LABELS,
  computeAll,
  historyFor,
  isThresholdKey,
  thresholdRows,
  updateThreshold,
  type Rag,
} from '../services/clientHealth.js';
import {
  ASSIGNMENT_ROLES,
  activateClient,
  activeAssignmentsForAll,
  assignStaff,
  assignableStaff,
  assignmentHistory,
  endAssignment,
  isAssignmentRole,
  pendingClients,
  type Plan,
} from '../services/assignment.js';
import { suggestionFor } from '../services/onboarding.js';
import {
  PERIODS,
  isPeriod,
  scorecard,
  staffWithMetrics,
  wellbeingFlags,
  type Period,
} from '../services/staffMetrics.js';
import { acknowledge, inboxFor, resolve, summarise } from '../services/alerts.js';
import { recentTransitions } from '../services/statusTransitions.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLANS: readonly Plan[] = ['essentials', 'growth', 'controller_plus'];

function str(body: unknown, key: string, max = 200): string {
  const v = (body as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function intOf(body: unknown, key: string, fallback: number): number {
  const raw = str(body, key, 20).replace(/[^0-9.-]/g, '');
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Chip class per colour — the templates render, they do not decide. */
export function ragChipClass(status: Rag): string {
  return status === 'red' ? 'sev-high' : status === 'yellow' ? 'sev-medium' : 'status-active';
}

const TREND_GLYPH: Record<string, string> = {
  improving: '↑',
  degrading: '↓',
  stable: '→',
  new: '·',
};

const BLOCKED_LABEL: Record<string, string> = {
  firm: 'Us',
  client: 'Client',
  external: 'External',
  none: '—',
};

export async function oversightRoutes(app: FastifyInstance): Promise<void> {
  /* ====================================================================== */
  /* 1. Portfolio board — the morning screen (§5)                            */
  /* ====================================================================== */

  app.get('/admin/portfolio', { preHandler: requireAdmin }, async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, string>;
    const [health, assignmentsByClient, staff, pending] = await Promise.all([
      computeAll(),
      activeAssignmentsForAll(),
      assignableStaff(),
      pendingClients(),
    ]);

    const statusFilter = ['green', 'yellow', 'red'].includes(query.status ?? '')
      ? (query.status as Rag)
      : null;
    const bookkeeperFilter = UUID_RE.test(query.bookkeeper ?? '') ? query.bookkeeper! : null;
    const blockedFilter = ['firm', 'client', 'external', 'none'].includes(query.blocked ?? '')
      ? query.blocked!
      : null;

    const rows = health
      .map((h) => {
        const assigned = assignmentsByClient.get(h.clientId) ?? [];
        return {
          ...h,
          chip: ragChipClass(h.status),
          trendGlyph: TREND_GLYPH[h.trend] ?? '·',
          blockedLabel: BLOCKED_LABEL[h.blockedBy] ?? h.blockedBy,
          assigned,
          // The client only ever sees the primary; internally we show the whole
          // bench, because "who covers this on Friday" is an admin question.
          backupName: assigned.find((a) => a.role === 'backup')?.userName ?? null,
          reviewerName: assigned.find((a) => a.role === 'reviewer')?.userName ?? null,
          hasReviewer: assigned.some((a) => a.role === 'reviewer'),
        };
      })
      .filter((r) => (statusFilter ? r.status === statusFilter : true))
      .filter((r) =>
        bookkeeperFilter ? r.assigned.some((a) => a.userId === bookkeeperFilter) : true,
      )
      .filter((r) => (blockedFilter ? r.blockedBy === blockedFilter : true))
      .sort(
        (a, b) =>
          rank(b.status) - rank(a.status) ||
          (b.timeInStatusDays ?? 0) - (a.timeInStatusDays ?? 0) ||
          a.businessName.localeCompare(b.businessName),
      );

    const counts = {
      red: health.filter((h) => h.status === 'red').length,
      yellow: health.filter((h) => h.status === 'yellow').length,
      green: health.filter((h) => h.status === 'green').length,
      firmBlocked: health.filter((h) => h.blockedBy === 'firm').length,
      clientBlocked: health.filter((h) => h.blockedBy === 'client').length,
      unassigned: health.filter((h) => !h.primaryUserId).length,
      noBackup: health.filter(
        (h) => !(assignmentsByClient.get(h.clientId) ?? []).some((a) => a.role === 'backup'),
      ).length,
    };

    return reply.viewPage('oversight/portfolio.eta', {
      title: 'Portfolio',
      rows,
      counts,
      staff,
      pendingCount: pending.length,
      filters: { status: statusFilter, bookkeeper: bookkeeperFilter, blocked: blockedFilter },
      transitions: await recentTransitions(12),
      dimensionLabels: DIMENSION_LABELS,
    });
  });

  /* ====================================================================== */
  /* 2. Pending queue and activation (§5)                                    */
  /* ====================================================================== */

  app.get('/admin/pending', { preHandler: requireAdmin }, async (_req, reply) => {
    const [pending, staff] = await Promise.all([pendingClients(), assignableStaff()]);
    const withSuggestions = await Promise.all(
      pending.map(async (p) => ({ ...p, suggestion: await suggestionFor(p.client.id) })),
    );

    return reply.viewPage('oversight/pending.eta', {
      title: 'Pending signups',
      pending: withSuggestions,
      staff: staff.filter((s) => !s.disabled),
      plans: PLANS,
    });
  });

  app.post<{ Params: { clientId: string } }>(
    '/admin/pending/:clientId/activate',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const me = req.authContext!.user;
      const { clientId } = req.params;
      const body = req.body as Record<string, unknown>;
      const back = '/admin/pending';

      if (!UUID_RE.test(clientId)) {
        return reply.flash('error', 'That client id is not valid.').redirect(back, 303);
      }

      const plan = str(body, 'plan') as Plan;
      const primaryId = str(body, 'primary');
      const backupId = str(body, 'backup');
      const reviewerId = str(body, 'reviewer');
      const monthlyFeeDollars = intOf(body, 'monthly_fee', -1);
      const closeTargetDay = intOf(body, 'close_target_day', 10);

      if (!PLANS.includes(plan)) {
        return reply.flash('error', 'Pick a plan before activating.').redirect(back, 303);
      }
      if (monthlyFeeDollars < 0) {
        return reply.flash('error', 'Set a monthly fee — activation starts the billing clock.').redirect(back, 303);
      }
      // DECISIONS.md §4: a primary AND a named backup on every client from day
      // one. A single bookkeeper per client is a single point of failure.
      if (!UUID_RE.test(primaryId)) {
        return reply.flash('error', 'A primary bookkeeper is required.').redirect(back, 303);
      }
      if (!UUID_RE.test(backupId)) {
        return reply
          .flash('error', 'A named backup is required — every client gets one from day one.')
          .redirect(back, 303);
      }
      if (primaryId === backupId) {
        return reply
          .flash('error', 'The backup has to be a different person, or it is not cover.')
          .redirect(back, 303);
      }

      const activated = await activateClient(
        clientId,
        {
          plan,
          monthlyFeeCents: Math.round(monthlyFeeDollars * 100),
          closeTargetDay,
        },
        me.id,
      );
      if (!activated) {
        return reply.flash('error', 'That client no longer exists.').redirect(back, 303);
      }

      // Backup and reviewer first, so the primary event fires last and the
      // client's welcome message goes out against a fully-staffed engagement.
      await assignStaff(clientId, backupId, 'backup', me.id);
      if (UUID_RE.test(reviewerId) && reviewerId !== primaryId) {
        await assignStaff(clientId, reviewerId, 'reviewer', me.id);
      }
      const result = await assignStaff(clientId, primaryId, 'primary', me.id);

      return reply
        .flash(
          'ok',
          `${activated.businessName} is active. ${result.effects.length ? `Created: ${result.effects.join(', ')}.` : ''}`,
        )
        .redirect('/admin/portfolio', 303);
    },
  );

  /* ====================================================================== */
  /* 3. Assignment (§6) — admin only, exclusively                            */
  /* ====================================================================== */

  app.post<{ Params: { clientId: string } }>(
    '/admin/clients/:clientId/assign',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const me = req.authContext!.user;
      const { clientId } = req.params;
      const body = req.body as Record<string, unknown>;
      const back = str(body, 'return', 300).startsWith('/admin')
        ? str(body, 'return', 300)
        : '/admin/portfolio';

      const userId = str(body, 'user_id');
      const role = str(body, 'role');

      if (!UUID_RE.test(clientId) || !UUID_RE.test(userId) || !isAssignmentRole(role)) {
        return reply.flash('error', 'Pick a person and a capacity.').redirect(back, 303);
      }

      try {
        const result = await assignStaff(clientId, userId, role, me.id, {
          reason: str(body, 'reason', 300) || undefined,
        });
        const note = result.effects.length ? ` Created: ${result.effects.join(', ')}.` : '';
        const replaced = result.replaced ? ' The previous holder lost access immediately.' : '';
        return reply.flash('ok', `Assigned as ${role}.${replaced}${note}`).redirect(back, 303);
      } catch (err) {
        req.log.warn({ err }, 'assignment failed');
        return reply
          .flash('error', err instanceof Error ? err.message : 'Could not assign.')
          .redirect(back, 303);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/assignments/:id/end',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const me = req.authContext!.user;
      const body = req.body as Record<string, unknown>;
      const back = str(body, 'return', 300).startsWith('/admin')
        ? str(body, 'return', 300)
        : '/admin/portfolio';
      const reason = str(body, 'reason', 300) || 'Ended by an administrator';

      if (!UUID_RE.test(req.params.id)) {
        return reply.flash('error', 'That assignment id is not valid.').redirect(back, 303);
      }
      const row = await endAssignment(req.params.id, reason, me.id);
      if (!row) {
        return reply.flash('error', 'That assignment was already ended.').redirect(back, 303);
      }
      return reply
        .flash('ok', `Assignment ended. Access stopped immediately${row.role === 'primary' ? ', and the client has been told.' : '.'}`)
        .redirect(back, 303);
    },
  );

  /* ====================================================================== */
  /* 4. Bookkeeper accounts — the exclusively-admin action (§8)              */
  /* ====================================================================== */

  app.get('/admin/staff', { preHandler: requireAdmin }, async (_req, reply) => {
    const [staff, metrics, pendingInvites, flags] = await Promise.all([
      assignableStaff(),
      staffWithMetrics(),
      db
        .select({ invite: invites, inviterName: users.name })
        .from(invites)
        .innerJoin(users, eq(users.id, invites.createdBy))
        .where(and(isNull(invites.acceptedAt), inArray(invites.role, ['staff', 'admin'])))
        .orderBy(desc(invites.expiresAt)),
      wellbeingFlags(),
    ]);

    const rollupBy = new Map(metrics.map((m) => [m.id, m.lastRollup] as const));
    return reply.viewPage('oversight/staff.eta', {
      title: 'Bookkeepers',
      staff: staff.map((s) => ({ ...s, lastRollup: rollupBy.get(s.id) ?? null })),
      invites: pendingInvites,
      flags,
    });
  });

  /**
   * Create a bookkeeper account.
   *
   * §8: *"Create, disable and reset bookkeeper accounts (exclusive)"* — the
   * admin role, and no other. `requireAdmin` already guarantees that; the
   * in-handler re-check is deliberate duplication on the single action whose
   * failure mode is a new account with access to every client's financials.
   *
   * An **invite** is generated rather than a password being set. The new user
   * chooses their own credential, so no administrator ever holds one, and the
   * audit trail cannot be confused about who did what.
   */
  app.post('/admin/staff', { preHandler: requireAdmin }, async (req, reply) => {
    const me = req.authContext!.user;
    if (me.role !== 'admin') {
      return reply.code(403).viewPage('error.eta', {
        title: 'Not allowed',
        message: 'Only an administrator can create a bookkeeper account.',
      });
    }

    const body = req.body as Record<string, unknown>;
    const email = str(body, 'email', 254).toLowerCase();
    const role = str(body, 'role') === 'admin' ? 'admin' : 'staff';

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return reply.flash('error', 'A valid work email is required.').redirect('/admin/staff', 303);
    }

    const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (existing) {
      return reply
        .flash('error', 'There is already an account with that email.')
        .redirect('/admin/staff', 303);
    }

    const token = generateToken();
    const [invite] = await db
      .insert(invites)
      .values({
        email,
        role,
        clientId: null,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
        createdBy: me.id,
      })
      .returning();

    const link = `${config.PORTAL_URL}/accept-invite/${token}`;
    await sendMail({ to: email, ...inviteEmail(link, me.name) });
    await audit(req, {
      action: 'oversight.staff_invite',
      entity: 'invite',
      entityId: invite!.id,
      meta: { email, role },
    });

    return reply
      .flash(
        'ok',
        `Invite sent to ${email}. They set their own password — nobody here ever holds it. The invite expires in 7 days.`,
      )
      .redirect('/admin/staff', 303);
  });

  /* ====================================================================== */
  /* 5. Scorecards (§3, DECISIONS.md §6)                                     */
  /* ====================================================================== */

  app.get<{ Params: { userId: string } }>(
    '/admin/scorecard/:userId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const period = periodFrom(req);
      if (!UUID_RE.test(req.params.userId)) {
        return reply.code(404).viewPage('error.eta', {
          title: 'Not found',
          message: 'No such person.',
        });
      }
      const card = await scorecard(req.params.userId, period);
      if (!card) {
        return reply.code(404).viewPage('error.eta', {
          title: 'Not found',
          message: 'No such firm-side account.',
        });
      }
      return reply.viewPage('oversight/scorecard.eta', {
        title: `${card.name} — scorecard`,
        card,
        period,
        periods: PERIODS,
        own: false,
        backHref: '/admin/staff',
      });
    },
  );

  /**
   * A staff member's own scorecard.
   *
   * DECISIONS.md §6: full visibility of their own numbers, with the same
   * difficulty adjustment the admin sees, benchmarked against the **team
   * median** and never against a named colleague. The user id is taken from the
   * session and nowhere else — there is no parameter here to tamper with, so
   * this route cannot be turned into a way to read somebody else's figures.
   */
  app.get('/scorecard', { preHandler: requireStaff }, async (req, reply) => {
    const me = req.authContext!.user;
    const period = periodFrom(req);
    const card = await scorecard(me.id, period);
    if (!card) {
      return reply.code(404).viewPage('error.eta', {
        title: 'No scorecard yet',
        message: 'Nothing has been rolled up for this account yet.',
      });
    }
    return reply.viewPage('oversight/scorecard.eta', {
      title: 'My scorecard',
      card,
      period,
      periods: PERIODS,
      own: true,
      backHref: '/workspace',
    });
  });

  /* ====================================================================== */
  /* 6. Alert inbox (§4)                                                     */
  /* ====================================================================== */

  app.get('/alerts', { preHandler: requireStaff }, async (req, reply) => {
    const me = req.authContext!.user;
    const query = (req.query ?? {}) as Record<string, string>;
    const showResolved = query.show === 'resolved';

    const rows = await inboxFor(me, {
      statuses: showResolved ? ['resolved'] : ['open', 'acknowledged'],
    });

    // A staff member's alert list is bounded by their assignments, which is the
    // same set `visibleClientIds` gives every other staff-facing query.
    const scopeIds = await visibleClientIds(me);

    return reply.viewPage('oversight/alerts.eta', {
      title: 'Alerts',
      rows,
      stats: summarise(rows),
      showResolved,
      isAdmin: me.role === 'admin',
      assignedCount: scopeIds === null ? null : scopeIds.length,
    });
  });

  app.post<{ Params: { id: string } }>(
    '/alerts/:id/ack',
    { preHandler: requireStaff },
    async (req, reply) => {
      const me = req.authContext!.user;
      if (!(await mayTouchAlert(req, me.id))) {
        return reply.flash('error', 'That alert is not yours.').redirect('/alerts', 303);
      }
      const row = await acknowledge(req.params.id, me.id);
      if (row) {
        await audit(req, {
          action: 'alert.acknowledge',
          clientId: row.clientId,
          entity: 'alert',
          entityId: row.id,
          meta: { kind: row.kind },
        });
      }
      return reply.flash('ok', 'Acknowledged — it is yours now.').redirect('/alerts', 303);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/alerts/:id/resolve',
    { preHandler: requireStaff },
    async (req, reply) => {
      const me = req.authContext!.user;
      if (!(await mayTouchAlert(req, me.id))) {
        return reply.flash('error', 'That alert is not yours.').redirect('/alerts', 303);
      }
      const row = await resolve(req.params.id);
      if (row) {
        await audit(req, {
          action: 'alert.resolve',
          clientId: row.clientId,
          entity: 'alert',
          entityId: row.id,
          meta: { kind: row.kind },
        });
      }
      return reply.flash('ok', 'Resolved.').redirect('/alerts', 303);
    },
  );

  /* ====================================================================== */
  /* 7. Thresholds — tuning without a deploy (§2)                            */
  /* ====================================================================== */

  app.get('/admin/thresholds', { preHandler: requireAdmin }, async (_req, reply) => {
    const rows = await thresholdRows();
    // Grouped here rather than in the template: an Eta `<% %>` block that opens
    // with an array literal is concatenated straight onto the preceding output
    // statement, and ASI reads it as an index expression rather than a new one.
    const groups = DIMENSIONS.map((dimension) => ({
      dimension,
      label: DIMENSION_LABELS[dimension],
      rows: rows.filter((r) => r.dimension === dimension),
    })).filter((g) => g.rows.length > 0);

    return reply.viewPage('oversight/thresholds.eta', { title: 'Health thresholds', groups });
  });

  app.post('/admin/thresholds', { preHandler: requireAdmin }, async (req, reply) => {
    const me = req.authContext!.user;
    const body = req.body as Record<string, unknown>;
    const key = str(body, 'key', 60);

    if (!isThresholdKey(key)) {
      return reply.flash('error', 'Unknown threshold.').redirect('/admin/thresholds', 303);
    }
    const yellowAt = intOf(body, 'yellow_at', Number.NaN);
    const redAt = intOf(body, 'red_at', Number.NaN);
    if (!Number.isFinite(yellowAt) || !Number.isFinite(redAt)) {
      return reply.flash('error', 'Both figures have to be numbers.').redirect('/admin/thresholds', 303);
    }

    const ok = await updateThreshold(key, yellowAt, redAt, me.id);
    if (!ok) {
      return reply.flash('error', 'Could not save that threshold.').redirect('/admin/thresholds', 303);
    }
    await audit(req, {
      action: 'oversight.threshold_update',
      entity: 'health_threshold',
      entityId: key,
      meta: { yellowAt, redAt },
    });
    return reply
      .flash('ok', 'Saved. It applies on the next computation — no deploy needed.')
      .redirect('/admin/thresholds', 303);
  });

  /* ====================================================================== */
  /* 8. One client, everything oversight knows (§5 "client scorecard")       */
  /* ====================================================================== */

  app.get<{ Params: { clientId: string } }>(
    '/admin/portfolio/:clientId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { clientId } = req.params;
      if (!UUID_RE.test(clientId)) {
        return reply.code(404).viewPage('error.eta', {
          title: 'Not found',
          message: 'No such client.',
        });
      }
      const [all, client, history, assignments, staff] = await Promise.all([
        computeAll(),
        db.query.clients.findFirst({ where: eq(clients.id, clientId) }),
        historyFor(clientId),
        assignmentHistory(clientId),
        assignableStaff(),
      ]);
      const health = all.find((h) => h.clientId === clientId) ?? null;
      if (!client) {
        return reply.code(404).viewPage('error.eta', {
          title: 'Not found',
          message: 'No such client.',
        });
      }
      return reply.viewPage('oversight/client.eta', {
        title: `${client.businessName} — health`,
        client,
        health,
        chip: health ? ragChipClass(health.status) : 'status-draft',
        history,
        assignments,
        staff: staff.filter((s) => !s.disabled),
        roles: ASSIGNMENT_ROLES,
        blockedLabel: BLOCKED_LABEL,
      });
    },
  );
}

/* ========================================================================== */
/* Helpers                                                                     */
/* ========================================================================== */

function rank(status: Rag): number {
  return status === 'red' ? 2 : status === 'yellow' ? 1 : 0;
}

function periodFrom(req: FastifyRequest): Period {
  const raw = (req.query as Record<string, unknown> | null)?.['period'];
  return isPeriod(raw) ? raw : '30d';
}

/**
 * An alert may be acted on by the person it is addressed to, or by an admin.
 *
 * A staff member cannot acknowledge an alert about a client they are not
 * assigned to, because such an alert could not have been addressed to them in
 * the first place — but the check is made against the row rather than assumed
 * from how it was created.
 */
async function mayTouchAlert(
  req: FastifyRequest<{ Params: { id: string } }>,
  userId: string,
): Promise<boolean> {
  const me = req.authContext!.user;
  if (!UUID_RE.test(req.params.id)) return false;
  const rows = await inboxFor(me, { statuses: ['open', 'acknowledged'], limit: 1000 });
  void userId;
  return rows.some((r) => r.id === req.params.id);
}

