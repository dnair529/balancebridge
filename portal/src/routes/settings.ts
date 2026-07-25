import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { requireAuth } from '../auth/guards.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { generateTotpSecret, totpQrDataUrl, verifyTotp } from '../auth/totp.js';
import { rotateSession, revokeAllSessions, createSession } from '../auth/session.js';
import { audit } from '../lib/audit.js';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/settings', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.authContext!.user;
    // If MFA setup is mid-flight (secret stored, not yet enabled), re-show the QR.
    let qr: string | null = null;
    if (user.totpSecret && !user.totpEnabled) {
      qr = await totpQrDataUrl(user.email, user.totpSecret);
    }
    return reply.viewPage('settings.eta', {
      title: 'Settings',
      qr,
      totpSecret: user.totpSecret && !user.totpEnabled ? user.totpSecret : null,
    });
  });

  // ---------- Password change ----------
  app.post('/settings/password', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.authContext!.user;
    const body = req.body as Record<string, string>;
    const current = body.current_password ?? '';
    const next = body.new_password ?? '';

    if (!(await verifyPassword(user.passwordHash, current))) {
      return reply.flash('error', 'Your current password didn’t match.').redirect('/settings', 303);
    }
    if (next.length < 12) {
      return reply.flash('error', 'New password needs at least 12 characters.').redirect('/settings', 303);
    }

    await db.update(users).set({ passwordHash: await hashPassword(next) }).where(eq(users.id, user.id));
    // Privilege change: revoke every other session, rotate this one.
    await revokeAllSessions(user.id);
    await createSession(reply, user.id, req);
    await audit(req, { action: 'auth.password_change', clientId: user.clientId });

    return reply.flash('ok', 'Password updated.').redirect('/settings', 303);
  });

  // ---------- TOTP setup: generate secret + show QR ----------
  app.post('/settings/mfa/setup', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.authContext!.user;
    if (user.totpEnabled) {
      return reply.flash('error', 'Two-step verification is already on.').redirect('/settings', 303);
    }
    const secret = generateTotpSecret();
    await db.update(users).set({ totpSecret: secret, totpEnabled: false }).where(eq(users.id, user.id));
    return reply.redirect('/settings', 303);
  });

  // ---------- TOTP verify: first valid code arms MFA ----------
  app.post('/settings/mfa/verify', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.authContext!.user;
    const code = ((req.body as Record<string, string>).code ?? '').trim();
    if (!user.totpSecret || user.totpEnabled) return reply.redirect('/settings', 303);

    if (!verifyTotp(user.totpSecret, code)) {
      return reply.flash('error', 'That code didn’t match. Scan the QR again and retry.').redirect('/settings', 303);
    }

    await db.update(users).set({ totpEnabled: true }).where(eq(users.id, user.id));
    // Privilege change → session rotation.
    await rotateSession(req, reply, user.id);
    await audit(req, { action: 'auth.mfa_enabled', clientId: user.clientId });
    return reply.flash('ok', 'Two-step verification is on.').redirect('/settings', 303);
  });

  // ---------- TOTP disable (requires current password) ----------
  app.post('/settings/mfa/disable', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.authContext!.user;
    const password = (req.body as Record<string, string>).password ?? '';
    if (!(await verifyPassword(user.passwordHash, password))) {
      return reply.flash('error', 'Your password didn’t match.').redirect('/settings', 303);
    }
    await db.update(users).set({ totpEnabled: false, totpSecret: null }).where(eq(users.id, user.id));
    await rotateSession(req, reply, user.id);
    await audit(req, { action: 'auth.mfa_disabled', clientId: user.clientId });
    return reply.flash('ok', 'Two-step verification is off.').redirect('/settings', 303);
  });
}
