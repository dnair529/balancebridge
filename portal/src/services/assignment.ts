/**
 * Assignment — the access control, and the relationship moment.
 *
 * CLIENT-ONBOARDING-AND-ROLES.md §1 states the governing idea plainly:
 *
 * > **Assignment is the access control.** A bookkeeper sees no client data at
 * > all until an admin assigns them to that client.
 *
 * That makes this module the single writer of `client_assignments`, and it
 * makes every write here an audited event rather than a row update. Two
 * consequences the code has to honour:
 *
 * 1. **Ending an assignment stops access immediately.** There is no cache, no
 *    grace period and no soft delete — `auth/scope.ts` asks one question, "is
 *    there an active row", and the answer changes the instant `ended_at` is
 *    set. Rows are never deleted, because the history *is* the audit trail.
 *
 * 2. **Assigning a primary fires the whole event** (§6). Not a row: an event.
 *    The bookkeeper gets the client in their world plus a setup checklist; the
 *    client gets a message thread that **already contains a hello**, their
 *    "what we need from you" list, and a notification that leaks nothing. A
 *    blank inbox with a "start a conversation" placeholder is the failure this
 *    exists to prevent.
 *
 * 3. **The client only ever sees the primary** (DECISIONS.md §4). Backups and
 *    reviewers are real, pre-provisioned and invisible: internal structure
 *    surfaced to a client just makes a small firm look bureaucratic. Nothing in
 *    this module ever writes a backup's or reviewer's name into anything
 *    client-facing.
 *
 * Reassignment and offboarding are the same mechanism in reverse — the old
 * assignment ends, the new one begins, and **the client is told by us rather
 * than by silence** (DECISIONS.md §10).
 */

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  clientAssignments,
  clientFinancialAccounts,
  clientOnboarding,
  clients,
  documentRequests,
  messages,
  outboundMessages,
  taskLists,
  tasks,
  threads,
  users,
} from '../db/schema.js';
import type { AssignmentRole } from '../auth/scope.js';
import { audit } from '../lib/audit.js';
import { config } from '../config.js';
import {
  DOCUMENT_CHECKLIST,
  completedSections,
  getOrCreateOnboarding,
  sectionAnswers,
} from './onboarding.js';

export type Plan = 'essentials' | 'growth' | 'controller_plus';
export type AssignmentRow = typeof clientAssignments.$inferSelect;

export const ASSIGNMENT_ROLES: readonly AssignmentRole[] = ['primary', 'backup', 'reviewer'] as const;

export function isAssignmentRole(v: unknown): v is AssignmentRole {
  return v === 'primary' || v === 'backup' || v === 'reviewer';
}

export class NotStaffError extends Error {
  readonly statusCode = 400;
  constructor(userId: string) {
    super(`User ${userId} is not a firm-side account and cannot be assigned to a client.`);
    this.name = 'NotStaffError';
  }
}

/* ========================================================================== */
/* Reading                                                                     */
/* ========================================================================== */

export interface AssignmentView {
  readonly id: string;
  readonly clientId: string;
  readonly userId: string;
  readonly userName: string;
  readonly userEmail: string;
  readonly role: AssignmentRole;
  readonly assignedAt: Date;
  readonly assignedByName: string | null;
}

/** Live assignments for a client, primary first. Admin/staff view only. */
export async function activeAssignments(clientId: string): Promise<AssignmentView[]> {
  const rows = await db
    .select({ a: clientAssignments, name: users.name, email: users.email })
    .from(clientAssignments)
    .innerJoin(users, eq(users.id, clientAssignments.userId))
    .where(and(eq(clientAssignments.clientId, clientId), isNull(clientAssignments.endedAt)))
    .orderBy(asc(clientAssignments.role));

  const byRole: Record<AssignmentRole, number> = { primary: 0, backup: 1, reviewer: 2 };
  return rows
    .map((r) => ({
      id: r.a.id,
      clientId: r.a.clientId,
      userId: r.a.userId,
      userName: r.name,
      userEmail: r.email,
      role: r.a.role as AssignmentRole,
      assignedAt: r.a.assignedAt,
      assignedByName: null,
    }))
    .sort((a, b) => byRole[a.role] - byRole[b.role]);
}

/** Every live assignment, keyed by client — the portfolio board's join. */
export async function activeAssignmentsForAll(): Promise<Map<string, AssignmentView[]>> {
  const rows = await db
    .select({ a: clientAssignments, name: users.name, email: users.email })
    .from(clientAssignments)
    .innerJoin(users, eq(users.id, clientAssignments.userId))
    .where(isNull(clientAssignments.endedAt));

  const out = new Map<string, AssignmentView[]>();
  for (const r of rows) {
    const arr = out.get(r.a.clientId) ?? [];
    arr.push({
      id: r.a.id,
      clientId: r.a.clientId,
      userId: r.a.userId,
      userName: r.name,
      userEmail: r.email,
      role: r.a.role as AssignmentRole,
      assignedAt: r.a.assignedAt,
      assignedByName: null,
    });
    out.set(r.a.clientId, arr);
  }
  return out;
}

/** Firm-side accounts an admin may assign, with their current load. */
export async function assignableStaff(): Promise<
  { id: string; name: string; email: string; role: string; disabled: boolean; activeClients: number }[]
> {
  const [staff, counts] = await Promise.all([
    db.query.users.findMany({
      where: inArray(users.role, ['staff', 'admin']),
      orderBy: [asc(users.name)],
    }),
    db
      .select({
        userId: clientAssignments.userId,
        n: sql<string>`count(distinct ${clientAssignments.clientId})`,
      })
      .from(clientAssignments)
      .where(isNull(clientAssignments.endedAt))
      .groupBy(clientAssignments.userId),
  ]);
  const by = new Map(counts.map((c) => [c.userId, Number(c.n) || 0] as const));
  return staff.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    disabled: u.disabled,
    activeClients: by.get(u.id) ?? 0,
  }));
}

/* ========================================================================== */
/* assignStaff                                                                 */
/* ========================================================================== */

export interface AssignResult {
  readonly assignment: AssignmentRow;
  /** The row we ended to make room, when this replaced somebody. */
  readonly replaced: AssignmentRow | null;
  /** What the assignment event created. Empty unless this was a primary. */
  readonly effects: readonly string[];
}

/**
 * Put someone on a client in one capacity.
 *
 * A client has exactly one live holder of each role, so an existing active row
 * for the same (client, role) is ended first — that is what makes reassignment
 * a single action rather than a two-step dance somebody forgets to finish.
 * Re-assigning the same person to the same role is a no-op that still audits.
 */
export async function assignStaff(
  clientId: string,
  userId: string,
  role: AssignmentRole,
  assignedBy: string,
  opts: { reason?: string; now?: Date } = {},
): Promise<AssignResult> {
  const now = opts.now ?? new Date();

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || (user.role !== 'staff' && user.role !== 'admin')) throw new NotStaffError(userId);

  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client) throw new Error(`No such client ${clientId}`);

  const existing = await db.query.clientAssignments.findFirst({
    where: and(
      eq(clientAssignments.clientId, clientId),
      eq(clientAssignments.role, role),
      isNull(clientAssignments.endedAt),
    ),
  });

  if (existing && existing.userId === userId) {
    return { assignment: existing, replaced: null, effects: [] };
  }

  let replaced: AssignmentRow | null = null;
  if (existing) {
    const [ended] = await db
      .update(clientAssignments)
      .set({ endedAt: now, endedReason: opts.reason ?? `Replaced by a new ${role}` })
      .where(eq(clientAssignments.id, existing.id))
      .returning();
    replaced = ended ?? null;
    await audit(null, {
      action: 'assignment.end',
      userId: assignedBy,
      clientId,
      entity: 'client_assignment',
      entityId: existing.id,
      meta: { role, endedUserId: existing.userId, reason: opts.reason ?? 'replaced' },
    });
  }

  const [assignment] = await db
    .insert(clientAssignments)
    .values({ clientId, userId, role, assignedBy, assignedAt: now })
    .returning();

  await audit(null, {
    action: 'assignment.create',
    userId: assignedBy,
    clientId,
    entity: 'client_assignment',
    entityId: assignment!.id,
    meta: { role, assignedUserId: userId, replacedUserId: replaced?.userId ?? null },
  });

  const effects =
    role === 'primary'
      ? await firePrimaryAssignment({
          clientId,
          bookkeeper: user,
          assignedBy,
          isReassignment: Boolean(replaced),
          now,
        })
      : [];

  return { assignment: assignment!, replaced, effects };
}

/* ========================================================================== */
/* endAssignment                                                               */
/* ========================================================================== */

/**
 * End an assignment. Access stops on the next request — `visibleClientIds`
 * reads `ended_at is null` and nothing caches the answer.
 *
 * Ending a **primary** also tells the client, because the alternative is that
 * they find out from silence (DECISIONS.md §10). The named backup, if there is
 * one, is who steps up; the client is not told the internal structure, only
 * that we are handing over.
 */
export async function endAssignment(
  id: string,
  reason: string,
  endedBy: string,
  opts: { now?: Date } = {},
): Promise<AssignmentRow | null> {
  const now = opts.now ?? new Date();
  const [row] = await db
    .update(clientAssignments)
    .set({ endedAt: now, endedReason: reason.slice(0, 300) || 'Ended by an administrator' })
    .where(and(eq(clientAssignments.id, id), isNull(clientAssignments.endedAt)))
    .returning();
  if (!row) return null;

  await audit(null, {
    action: 'assignment.end',
    userId: endedBy,
    clientId: row.clientId,
    entity: 'client_assignment',
    entityId: row.id,
    meta: { role: row.role, endedUserId: row.userId, reason },
  });

  if (row.role === 'primary') {
    await queueClientNotification({
      clientId: row.clientId,
      body:
        'There is a change to who looks after your books at Balance Bridge. ' +
        'Sign in to the portal and we will introduce you — nothing you have sent us is affected.',
      now,
    });
  }
  return row;
}

/** Every live assignment for a departing staff member, ended in one action. */
export async function endAllForUser(
  userId: string,
  reason: string,
  endedBy: string,
): Promise<number> {
  const live = await db.query.clientAssignments.findMany({
    where: and(eq(clientAssignments.userId, userId), isNull(clientAssignments.endedAt)),
  });
  let n = 0;
  for (const row of live) {
    if (await endAssignment(row.id, reason, endedBy)) n += 1;
  }
  return n;
}

/* ========================================================================== */
/* activateClient                                                              */
/* ========================================================================== */

export interface ActivationInput {
  readonly plan: Plan;
  readonly monthlyFeeCents: number;
  readonly closeTargetDay: number;
}

/**
 * pending → active. The admin has read the profile, set the plan and the price,
 * and fixed the close target — which is the SLA every downstream queue measures
 * against (CLIENT-ONBOARDING-AND-ROLES.md §5).
 *
 * Idempotent: activating an already-active client updates the commercial terms
 * and leaves `activated_at` alone, so re-submitting the form cannot rewrite
 * history.
 */
export async function activateClient(
  clientId: string,
  input: ActivationInput,
  adminId: string,
  opts: { now?: Date } = {},
): Promise<typeof clients.$inferSelect | null> {
  const now = opts.now ?? new Date();
  const current = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!current) return null;

  const [row] = await db
    .update(clients)
    .set({
      status: 'active',
      plan: input.plan,
      monthlyFeeCents: Math.max(0, Math.round(input.monthlyFeeCents)),
      closeTargetDay: Math.min(28, Math.max(1, Math.round(input.closeTargetDay))),
      activatedAt: current.activatedAt ?? now,
    })
    .where(eq(clients.id, clientId))
    .returning();

  await audit(null, {
    action: 'client.activate',
    userId: adminId,
    clientId,
    entity: 'client',
    entityId: clientId,
    meta: {
      plan: input.plan,
      monthlyFeeCents: input.monthlyFeeCents,
      closeTargetDay: input.closeTargetDay,
      previousStatus: current.status,
    },
  });

  return row ?? null;
}

/* ========================================================================== */
/* The assignment event (§6)                                                   */
/* ========================================================================== */

/** The setup work a bookkeeper owes a new client in their first week (§6). */
export const SETUP_CHECKLIST: readonly { title: string; notes: string }[] = [
  {
    title: 'Connect the bank and card feeds',
    notes: 'Plaid or a read-only accountant invite. Never ask the client for banking credentials.',
  },
  {
    title: 'Build the chart of accounts',
    notes: 'Start from the industry template, then adjust to how this owner actually talks about their money.',
  },
  {
    title: 'Import history and opening balances',
    notes: 'Everything from the engagement start date, or from the beginning of the catch-up period.',
  },
  {
    title: 'Reconcile opening balances',
    notes: 'Agree every account to a statement before the first live close. Do not carry a guess forward.',
  },
  {
    title: 'Set the close calendar',
    notes: 'Open the first period and confirm the target date matches the plan the client was sold.',
  },
  {
    title: 'Read the onboarding answers end to end',
    notes: 'Ten minutes now saves the client repeating themselves, which is the fastest way to lose trust.',
  },
];

interface PrimaryEventInput {
  clientId: string;
  bookkeeper: typeof users.$inferSelect;
  assignedBy: string;
  isReassignment: boolean;
  now: Date;
}

/**
 * Everything that happens the moment a client gets a primary.
 *
 * Deliberately best-effort per effect and idempotent per effect: a re-run must
 * not produce a second welcome thread or a duplicate checklist, and one failing
 * effect must not roll back the assignment itself — an assignment that exists
 * with a missing checklist is recoverable; a client with access and no
 * assignment record is not.
 */
async function firePrimaryAssignment(input: PrimaryEventInput): Promise<string[]> {
  const effects: string[] = [];
  const client = await db.query.clients.findFirst({ where: eq(clients.id, input.clientId) });
  if (!client) return effects;

  const threadId = await ensureWelcomeThread(input, client);
  if (threadId) effects.push('welcome thread with a hello from the bookkeeper');

  const created = await generateDocumentRequests(input.clientId, input.now);
  if (created > 0) effects.push(`${created} document request${created === 1 ? '' : 's'} from onboarding gaps`);

  const listId = await ensureSetupChecklist(input);
  if (listId) effects.push('bookkeeper setup checklist');

  await queueClientNotification({
    clientId: input.clientId,
    body: input.isReassignment
      ? `You have a new point of contact at Balance Bridge. ${input.bookkeeper.name} has left you a message in the portal.`
      : `You are all set up at Balance Bridge. ${input.bookkeeper.name} has left you a message in the portal.`,
    now: input.now,
  });
  effects.push('client notification queued');

  await audit(null, {
    action: 'assignment.primary_event',
    userId: input.assignedBy,
    clientId: input.clientId,
    entity: 'client',
    entityId: input.clientId,
    meta: { bookkeeperId: input.bookkeeper.id, effects },
  });

  return effects;
}

/**
 * The thread is created **with the hello already in it**. §6 is explicit: the
 * channel is never an empty box. An empty thread with a blinking cursor asks
 * the client to make the first move on a relationship they have not started
 * yet, and most of them simply will not.
 */
async function ensureWelcomeThread(
  input: PrimaryEventInput,
  client: typeof clients.$inferSelect,
): Promise<string | null> {
  const subject = 'Welcome to Balance Bridge';
  const existing = await db.query.threads.findFirst({
    where: and(eq(threads.clientId, input.clientId), eq(threads.subject, subject)),
  });

  const hello = welcomeMessage(input.bookkeeper, client, input.isReassignment);

  if (existing) {
    // Reassignment: same thread, new voice. The client keeps their history and
    // meets the new person in the place they already look for us.
    if (!input.isReassignment) return null;
    await db.insert(messages).values({
      threadId: existing.id,
      senderId: input.bookkeeper.id,
      body: hello,
      createdAt: input.now,
    });
    return existing.id;
  }

  const [thread] = await db
    .insert(threads)
    .values({
      clientId: input.clientId,
      subject,
      createdBy: input.bookkeeper.id,
      createdAt: input.now,
    })
    .returning();

  await db.insert(messages).values({
    threadId: thread!.id,
    senderId: input.bookkeeper.id,
    body: hello,
    createdAt: input.now,
  });
  return thread!.id;
}

/** "Meet your bookkeeper" in their own voice — a person, not a system email. */
export function welcomeMessage(
  bookkeeper: { name: string; email: string },
  client: { businessName: string; contactName: string | null; closeTargetDay: number | null },
  isReassignment: boolean,
): string {
  const first = (client.contactName ?? '').split(' ')[0] || 'there';
  const day = client.closeTargetDay ?? 10;
  const opening = isReassignment
    ? `Hi ${first} — I'm ${bookkeeper.name}, and I'm taking over the books for ${client.businessName}. I've read everything you sent, so you won't need to repeat yourself.`
    : `Hi ${first} — I'm ${bookkeeper.name}, your bookkeeper at Balance Bridge. I'll be looking after the books for ${client.businessName}.`;

  return [
    opening,
    '',
    'Three things worth knowing:',
    '',
    `• **Sending us things.** Reply here, or text a photo of a receipt to your capture number. Either way it lands on the right file — you never have to sort or name anything.`,
    `• **When your books close.** I aim to have each month finished by business day ${day}, and you'll get a short plain-English summary of what happened, not just a spreadsheet.`,
    `• **Reaching a human.** This thread reaches me directly at ${bookkeeper.email}. If something is urgent or something is wrong, say so and it comes straight to me.`,
    '',
    "I'll send over anything I still need in the next day or two — you'll see it in the portal as a list, so nothing gets lost in email.",
    '',
    bookkeeper.name,
  ].join('\n');
}

/**
 * Turn the onboarding gaps into an explicit "what we need from you" list.
 *
 * The document checklist the client did not tick, plus three months of
 * statements for every account they told us about. Deduplicated by label, so a
 * reassignment does not double the client's to-do list.
 */
async function generateDocumentRequests(clientId: string, now: Date): Promise<number> {
  const onboarding = await getOrCreateOnboarding(clientId);
  const done = new Set(completedSections(onboarding));
  const fAnswers = sectionAnswers(onboarding, 'f');
  const uploaded = new Set(
    Array.isArray(fAnswers['uploaded']) ? (fAnswers['uploaded'] as string[]) : [],
  );

  const wanted: { label: string; due: Date }[] = [];
  for (const item of DOCUMENT_CHECKLIST) {
    if (uploaded.has(item.key)) continue;
    // Only the genuinely optional item is skipped when the section is done.
    if (done.has('f') && item.key === 'voided_check') continue;
    wanted.push({ label: item.label, due: new Date(now.getTime() + 14 * 86_400_000) });
  }

  const finAccounts = await db
    .select()
    .from(clientFinancialAccounts)
    .where(
      and(eq(clientFinancialAccounts.clientId, clientId), eq(clientFinancialAccounts.active, true)),
    );
  for (const a of finAccounts) {
    const name = a.nickname ? `${a.institution} · ${a.nickname}` : a.institution;
    wanted.push({
      label: `Last three statements — ${name} ••${a.last4 ?? '????'}`,
      due: new Date(now.getTime() + 7 * 86_400_000),
    });
  }

  if (wanted.length === 0) return 0;

  const existing = await db
    .select({ label: documentRequests.label })
    .from(documentRequests)
    .where(eq(documentRequests.clientId, clientId));
  const have = new Set(existing.map((r) => r.label));

  const fresh = wanted.filter((w) => !have.has(w.label));
  if (fresh.length === 0) return 0;

  await db.insert(documentRequests).values(
    fresh.map((w) => ({
      clientId,
      label: w.label,
      status: 'open' as const,
      dueAt: w.due,
      createdAt: now,
    })),
  );
  return fresh.length;
}

/** The bookkeeper's own setup list. Owner is `firm` — this is not client work. */
async function ensureSetupChecklist(input: PrimaryEventInput): Promise<string | null> {
  const title = 'New client setup';
  const existing = await db.query.taskLists.findFirst({
    where: and(
      eq(taskLists.clientId, input.clientId),
      eq(taskLists.title, title),
      isNull(taskLists.archivedAt),
    ),
  });
  if (existing) return null;

  const [list] = await db
    .insert(taskLists)
    .values({
      clientId: input.clientId,
      title,
      createdBy: input.bookkeeper.id,
      createdAt: input.now,
    })
    .returning();

  await db.insert(tasks).values(
    SETUP_CHECKLIST.map((t, i) => ({
      listId: list!.id,
      title: t.title,
      notes: t.notes,
      owner: 'firm' as const,
      sortOrder: i,
    })),
  );
  return list!.id;
}

/**
 * Queue the client's notification.
 *
 * **Notifications leak nothing** (§7). The body says a message is waiting and
 * where to read it. Amounts, vendors and balances stay behind the login,
 * because email is not a secure channel and a phone on a truck seat is not a
 * private device. The row is queued rather than sent here: delivery is the
 * outbound worker's job, and queuing keeps the assignment write fast and
 * auditable.
 */
export async function queueClientNotification(input: {
  clientId: string;
  body: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const client = await db.query.clients.findFirst({ where: eq(clients.id, input.clientId) });
  if (!client) return;

  const to = client.email ?? client.phone;
  if (!to) return;

  await db.insert(outboundMessages).values({
    clientId: input.clientId,
    channel: client.email ? 'email' : 'sms',
    toIdentity: to,
    body: `${input.body} ${config.PORTAL_URL}`,
    purpose: 'other',
    relatedEntity: 'client_assignment',
    relatedId: input.clientId,
    status: 'queued',
    createdAt: now,
  });
}

/* ========================================================================== */
/* Pending queue read model                                                    */
/* ========================================================================== */

export interface ComplexitySignal {
  readonly label: string;
  readonly value: string;
  /** True when this is the reason the engagement is hard, not just a fact. */
  readonly notable: boolean;
}

export interface PendingClient {
  readonly client: typeof clients.$inferSelect;
  readonly signedUpAt: Date;
  readonly onboardingPercent: number;
  readonly sectionsDone: number;
  readonly submitted: boolean;
  readonly accountCount: number;
  readonly services: readonly string[];
  readonly monthsBehind: number;
  readonly complexity: readonly ComplexitySignal[];
  readonly contactEmail: string | null;
}

/**
 * The admin's pending queue (§5): the submitted profile plus the complexity
 * assessment the wizard's answers imply. The suggested plan and price come from
 * `onboarding.suggestionFor`, which is a pure function the admin is meant to
 * argue with — a starting point, not an oracle.
 */
export async function pendingClients(): Promise<PendingClient[]> {
  const rows = await db.query.clients.findMany({
    where: eq(clients.status, 'pending'),
    orderBy: [asc(clients.createdAt)],
  });
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [onboardingRows, accountRows] = await Promise.all([
    db.query.clientOnboarding.findMany({ where: inArray(clientOnboarding.clientId, ids) }),
    db
      .select({ clientId: clientFinancialAccounts.clientId, n: sql<string>`count(*)` })
      .from(clientFinancialAccounts)
      .where(
        and(
          inArray(clientFinancialAccounts.clientId, ids),
          eq(clientFinancialAccounts.active, true),
        ),
      )
      .groupBy(clientFinancialAccounts.clientId),
  ]);

  const onboardingBy = new Map(onboardingRows.map((r) => [r.clientId, r] as const));
  const accountBy = new Map(accountRows.map((r) => [r.clientId, Number(r.n) || 0] as const));

  return rows.map((client) => {
    const ob = onboardingBy.get(client.id);
    const done = ob ? completedSections(ob).length : 0;
    const b = ob ? sectionAnswers(ob, 'b') : {};
    const services = Array.isArray(b['services']) ? (b['services'] as string[]) : [];
    const monthsBehind = Number(b['monthsBehind'] ?? client.monthsBehind ?? 0) || 0;
    const accountCount = accountBy.get(client.id) ?? 0;

    const complexity: ComplexitySignal[] = [
      {
        label: 'Monthly volume',
        value: client.txnVolumeBand ?? 'not stated',
        notable: ['401-1000', '1000+'].includes(client.txnVolumeBand ?? ''),
      },
      {
        label: 'Accounts to reconcile',
        value: String(accountCount),
        notable: accountCount >= 6,
      },
      {
        label: 'Months behind',
        value: String(monthsBehind),
        notable: monthsBehind >= 4,
      },
      {
        label: 'Books status',
        value: client.booksStatus ?? 'not stated',
        notable: client.booksStatus === 'never',
      },
      {
        label: 'Industry',
        value: client.industry ?? 'not stated',
        notable: ['construction-trades', 'restaurants-hospitality', 'ecommerce-retail'].includes(
          client.industry ?? '',
        ),
      },
      {
        label: 'Services requested',
        value: services.length ? String(services.length) : 'not yet chosen',
        notable: services.length >= 4,
      },
    ];

    return {
      client,
      signedUpAt: client.createdAt,
      onboardingPercent: Math.round((done / 7) * 100),
      sectionsDone: done,
      submitted: Boolean(ob?.submittedAt),
      accountCount,
      services,
      monthsBehind,
      complexity,
      contactEmail: client.email,
    };
  });
}

/** Assignment history for a client, newest first — "who could see what, when". */
export async function assignmentHistory(clientId: string, limit = 40) {
  return db
    .select({ a: clientAssignments, name: users.name, email: users.email })
    .from(clientAssignments)
    .innerJoin(users, eq(users.id, clientAssignments.userId))
    .where(eq(clientAssignments.clientId, clientId))
    .orderBy(desc(clientAssignments.assignedAt))
    .limit(limit);
}
