import type { FastifyReply, FastifyRequest } from 'fastify';
import { validateSession, type AuthContext } from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireAuth (and friends). Absent on public routes. */
    authContext?: AuthContext;
  }
}

/**
 * preHandler: require a valid session. Redirects browsers to /login.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // The global CSRF hook may have resolved the session already (POSTs).
  if (!req.authContext) {
    const ctx = await validateSession(req);
    if (ctx) req.authContext = ctx;
  }
  if (!req.authContext) {
    await reply.redirect('/login', 303);
  }
}

/** preHandler: staff or admin only. */
export async function requireStaff(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply);
  if (reply.sent) return;
  const role = req.authContext!.user.role;
  if (role !== 'staff' && role !== 'admin') {
    await reply.code(403).viewPage('error.eta', {
      title: 'Not allowed',
      message: 'You do not have access to that page.',
    });
  }
}

/** preHandler: admin only. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply);
  if (reply.sent) return;
  if (req.authContext!.user.role !== 'admin') {
    await reply.code(403).viewPage('error.eta', {
      title: 'Not allowed',
      message: 'You do not have access to that page.',
    });
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * client_id scoping helper — THE access-control choke point.
 *
 * - `client` role: ALWAYS the client_id bound to the session's user row.
 *   Request params are never consulted, so a client cannot address another
 *   client's data no matter what they send.
 * - `staff`/`admin`: may act on any client, chosen explicitly via the
 *   `?client=<uuid>` query parameter (validated); returns null when absent so
 *   staff-facing pages can redirect to /admin instead of guessing.
 */
export function resolveClientId(req: FastifyRequest): string | null {
  const { user } = req.authContext!;
  if (user.role === 'client') {
    return user.clientId; // server-side value only
  }
  const q = (req.query as Record<string, unknown>)?.client;
  if (typeof q === 'string' && UUID_RE.test(q)) return q;
  return null;
}

export function isStaff(req: FastifyRequest): boolean {
  const role = req.authContext?.user.role;
  return role === 'staff' || role === 'admin';
}
