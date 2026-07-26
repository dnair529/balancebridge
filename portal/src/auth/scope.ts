/**
 * Assignment-based access control.
 *
 * THE RULE: a staff user may see a client only while an active row exists in
 * `client_assignments`. Admins see every client. Client users see only their own.
 *
 * Every staff-facing query that touches client data MUST resolve its client set
 * through this module. Enforcing it in one place is what makes the rule
 * reviewable — if a route builds its own `where` clause on client_id, that is a
 * bug, and it is visible in review precisely because it bypasses these helpers.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { clientAssignments, clients } from '../db/schema.js';
import type { SessionUser } from './session.js';

export class ClientAccessDeniedError extends Error {
  readonly statusCode = 403;
  constructor(clientId: string) {
    super(`Not assigned to client ${clientId}`);
    this.name = 'ClientAccessDeniedError';
  }
}

export type AssignmentRole = 'primary' | 'backup' | 'reviewer';

/** Client ids a user may see. `null` means "every client" (admin). */
export async function visibleClientIds(user: SessionUser): Promise<string[] | null> {
  if (user.role === 'admin') return null; // unrestricted

  if (user.role === 'client') {
    return user.clientId ? [user.clientId] : [];
  }

  // staff: only active assignments
  const rows = await db
    .selectDistinct({ clientId: clientAssignments.clientId })
    .from(clientAssignments)
    .where(and(eq(clientAssignments.userId, user.id), isNull(clientAssignments.endedAt)));
  return rows.map((r) => r.clientId);
}

/**
 * A drizzle condition constraining a query to what this user may see.
 * Pass the client_id column of whatever table is being queried.
 *
 *   const where = and(eq(t.status,'open'), await scopeTo(user, t.clientId));
 */
export async function scopeTo(
  user: SessionUser,
  clientIdColumn: Parameters<typeof inArray>[0],
): Promise<ReturnType<typeof inArray> | undefined> {
  const ids = await visibleClientIds(user);
  if (ids === null) return undefined; // admin — no constraint
  if (ids.length === 0) return sql`false` as never; // fail closed, never "no filter"
  return inArray(clientIdColumn, ids);
}

/** Throws unless the user may act on this client. Use before any mutation. */
export async function assertClientAccess(user: SessionUser, clientId: string): Promise<void> {
  const ids = await visibleClientIds(user);
  if (ids === null) return;
  if (!ids.includes(clientId)) throw new ClientAccessDeniedError(clientId);
}

/** What capacity is this user assigned in? Null when not assigned. */
export async function assignmentRole(
  userId: string,
  clientId: string,
): Promise<AssignmentRole | null> {
  const [row] = await db
    .select({ role: clientAssignments.role })
    .from(clientAssignments)
    .where(
      and(
        eq(clientAssignments.userId, userId),
        eq(clientAssignments.clientId, clientId),
        isNull(clientAssignments.endedAt),
      ),
    )
    .limit(1);
  return (row?.role as AssignmentRole) ?? null;
}

/** The client's primary — the only staff member the client is ever shown. */
export async function primaryFor(clientId: string) {
  const [row] = await db
    .select({ userId: clientAssignments.userId })
    .from(clientAssignments)
    .where(
      and(
        eq(clientAssignments.clientId, clientId),
        eq(clientAssignments.role, 'primary'),
        isNull(clientAssignments.endedAt),
      ),
    )
    .limit(1);
  return row?.userId ?? null;
}

/** Active assignees for a client, with their roles. Admin/staff view. */
export async function assigneesFor(clientId: string) {
  return db
    .select({ userId: clientAssignments.userId, role: clientAssignments.role })
    .from(clientAssignments)
    .where(and(eq(clientAssignments.clientId, clientId), isNull(clientAssignments.endedAt)));
}

/** Clients a staff user is assigned to, with names — the "my clients" list. */
export async function myClients(user: SessionUser) {
  const ids = await visibleClientIds(user);
  if (ids !== null && ids.length === 0) return [];
  const base = db
    .select({
      id: clients.id,
      businessName: clients.businessName,
      status: clients.status,
      plan: clients.plan,
      closeTargetDay: clients.closeTargetDay,
    })
    .from(clients);
  return ids === null ? base : base.where(inArray(clients.id, ids));
}
