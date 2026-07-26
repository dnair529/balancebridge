import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

/**
 * MFA policy for firm-side users.
 *
 * Staff and admin accounts can read and write EVERY client's financial records
 * (guards.ts lets them address any client via ?client=). A stolen staff
 * password is therefore a full-tenant breach, which is exactly the case where a
 * second factor earns its keep. Client accounts stay optional-TOTP: they can
 * only reach their own data, and forcing enrolment on a small-business owner is
 * the kind of friction that gets a portal abandoned.
 *
 * Controlled by REQUIRE_STAFF_MFA. Anything other than the literal '0' enforces
 * it — an unset or typo'd value fails safe (enforced), never open.
 */

/** Minimal shape needed; matches SessionUser from auth/session.ts. */
export interface MfaSubject {
  role: 'client' | 'staff' | 'admin';
  totpEnabled?: boolean;
}

/** True when this user is REQUIRED to have TOTP enabled. */
export function mfaRequired(user: MfaSubject): boolean {
  if (!config.mfa.requireStaff) return false;
  return user.role === 'staff' || user.role === 'admin';
}

/** True when the user is required to have MFA and has not set it up yet. */
export function mfaSetupOutstanding(user: MfaSubject): boolean {
  return mfaRequired(user) && !user.totpEnabled;
}

/** Where a staff/admin user without TOTP gets sent. */
export const MFA_REQUIRED_PATH = '/settings/mfa-required';

/**
 * Paths that must stay reachable while enrolment is outstanding, or the user
 * is locked into a redirect loop with no way to comply (or to log out).
 */
const ALLOWED_WHILE_OUTSTANDING = [
  MFA_REQUIRED_PATH,
  '/settings/mfa',
  '/settings/mfa/setup',
  '/settings/mfa/verify',
  '/logout',
  '/healthz',
  '/assets',
  '/public',
];

function isExempt(url: string): boolean {
  const pathOnly = url.split('?')[0] ?? url;
  return ALLOWED_WHILE_OUTSTANDING.some((p) => pathOnly === p || pathOnly.startsWith(`${p}/`));
}

/**
 * Fastify preHandler: send staff/admin without TOTP to the enrolment page.
 *
 * NOT WIRED IN — routes are owned elsewhere. To enable it, add one line to the
 * global hook chain in src/server.ts, after the session is resolved:
 *
 *     app.addHook('preHandler', enforceMfaSetup);
 *
 * (or per-route: `{ preHandler: [requireAuth, enforceMfaSetup] }`). It is a
 * no-op for unauthenticated requests, for client users, and when
 * REQUIRE_STAFF_MFA=0, so registering it globally is safe.
 *
 * The routes agent also needs to serve GET /settings/mfa-required — a page
 * explaining why, linking to the existing POST /settings/mfa/setup flow.
 */
export async function enforceMfaSetup(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = req.authContext?.user;
  if (!user) return; // public route, or an auth guard will handle it
  if (!mfaSetupOutstanding(user)) return;
  if (isExempt(req.url)) return;
  await reply.redirect(MFA_REQUIRED_PATH, 303);
}
