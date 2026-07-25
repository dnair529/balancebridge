import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { safeEqual } from '../auth/tokens.js';
import { validateSession } from '../auth/session.js';

/**
 * CSRF protection (spec §3): synchronizer token pattern.
 *
 * - Authenticated requests: the token lives in the sessions row
 *   (sessions.csrf_token) and is emitted as a hidden `_csrf` field in every
 *   form. Rotates whenever the session rotates.
 * - Pre-auth forms (login, forgot/reset password, accept-invite): no session
 *   exists yet, so we use a double-submit cookie — a random value in an
 *   httpOnly SameSite=Lax cookie must match the hidden field.
 * - Exempt: /webhooks/* (signature / shared-secret verified) and /api/leads
 *   (cross-origin by design; rate limit + honeypot + CORS allowlist).
 *
 * All comparisons are constant-time.
 */

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Route opts out of the global CSRF preHandler (must protect itself). */
    skipCsrf?: boolean;
  }
}

const anonCookieOpts = {
  path: '/',
  httpOnly: true,
  secure: config.COOKIE_SECURE,
  sameSite: 'lax' as const,
};

/** Ensure the anonymous CSRF cookie exists; return its value for the form. */
export function anonCsrfToken(req: FastifyRequest, reply: FastifyReply): string {
  const existing = req.cookies[config.csrfCookieName];
  if (existing && /^[A-Za-z0-9_-]{43}$/.test(existing)) return existing;
  const token = crypto.randomBytes(32).toString('base64url');
  reply.setCookie(config.csrfCookieName, token, anonCookieOpts);
  return token;
}

/** The token templates should embed for the current requester. */
export function csrfTokenFor(req: FastifyRequest, reply: FastifyReply): string {
  return req.authContext?.session.csrfToken ?? anonCsrfToken(req, reply);
}

function submittedToken(req: FastifyRequest): string | null {
  const body = req.body as Record<string, unknown> | null;
  const t = body?.['_csrf'];
  return typeof t === 'string' ? t : null;
}

/** Verify a token that was collected out-of-band (multipart uploads). */
export function verifyCsrfValue(req: FastifyRequest, value: string | null | undefined): boolean {
  const expected = req.authContext?.session.csrfToken ?? req.cookies[config.csrfCookieName];
  return Boolean(expected && value && safeEqual(value, expected));
}

/**
 * Global preHandler: reject any POST whose `_csrf` hidden field doesn't match.
 * Instance-level hooks run before route-level preHandlers (requireAuth), so
 * resolve the session here if a cookie is present; guards reuse the result.
 */
export function registerCsrfHook(app: FastifyInstance): void {
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'POST') return;
    if (req.routeOptions.config?.skipCsrf) return;
    if (!req.authContext) {
      const ctx = await validateSession(req);
      if (ctx) req.authContext = ctx;
    }
    if (!verifyCsrfValue(req, submittedToken(req))) {
      req.log.warn({ url: req.url }, 'CSRF token mismatch');
      await reply.code(403).viewPage('error.eta', {
        title: 'Form expired',
        message: 'That form expired or was tampered with. Go back and try again.',
      });
    }
  });
}
