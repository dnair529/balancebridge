import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, passwordResets, invites } from '../db/schema.js';
import { hashPassword, verifyPassword, DUMMY_HASH_PROMISE } from '../auth/password.js';
import { generateToken, hashToken } from '../auth/tokens.js';
import {
  createSession,
  revokeSession,
  revokeAllSessions,
  clearSessionCookie,
  validateSession,
} from '../auth/session.js';
import { verifyTotp } from '../auth/totp.js';
import { requireAuth } from '../auth/guards.js';
import { audit } from '../lib/audit.js';
import { sendMail, resetEmail } from '../lib/mail.js';
import { config } from '../config.js';

const LOGIN_ERROR = 'That email and password combination didn’t work.';

/** Signed, short-lived cookie bridging password success -> TOTP entry. */
const TOTP_PENDING_COOKIE = 'totp_pending';
const TOTP_PENDING_MAX_AGE_MS = 5 * 60 * 1000;

const pendingCookieOpts = {
  path: '/',
  httpOnly: true,
  secure: config.COOKIE_SECURE,
  sameSite: 'lax' as const,
  signed: true,
  maxAge: 300,
};

function readTotpPending(req: FastifyRequest): string | null {
  const raw = req.cookies[TOTP_PENDING_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  try {
    const parsed = JSON.parse(unsigned.value) as { u: string; t: number };
    if (Date.now() - parsed.t > TOTP_PENDING_MAX_AGE_MS) return null;
    return parsed.u;
  } catch {
    return null;
  }
}

/** Per-route rate limit: 10 attempts / 15 min / IP+email (spec §1). */
const loginRateLimit = {
  rateLimit: {
    max: 10,
    timeWindow: 15 * 60 * 1000,
    keyGenerator: (req: FastifyRequest) => {
      const email = (req.body as Record<string, unknown> | null)?.['email'];
      return `login:${req.ip}:${typeof email === 'string' ? email.trim().toLowerCase() : ''}`;
    },
  },
};

async function finishLogin(req: FastifyRequest, reply: FastifyReply, userId: string): Promise<void> {
  await createSession(reply, userId, req);
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  reply.clearCookie(TOTP_PENDING_COOKIE, { path: '/' });
  await audit(req, { action: 'auth.login_success', userId });
  await reply.redirect('/dashboard', 303);
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ---------- Login ----------
  app.get('/login', async (req, reply) => {
    // Already signed in? Straight to the dashboard.
    if (await validateSession(req)) return reply.redirect('/dashboard', 303);
    return reply.viewPage('login.eta', { title: 'Sign in' });
  });

  app.post('/login', { config: loginRateLimit }, async (req, reply) => {
    const body = req.body as Record<string, string>;
    const email = (body.email ?? '').trim();
    const password = body.password ?? '';

    const user = email
      ? await db.query.users.findFirst({ where: eq(users.email, email) })
      : undefined;

    // Always run one argon2 verification so response timing doesn't reveal
    // whether the account exists.
    const ok = user
      ? await verifyPassword(user.passwordHash, password)
      : (await verifyPassword(await DUMMY_HASH_PROMISE, password), false);

    if (!user || !ok || user.disabled) {
      await audit(req, {
        action: 'auth.login_fail',
        userId: user?.id ?? null,
        meta: { email: email.slice(0, 200) },
      });
      return reply.flash('error', LOGIN_ERROR).redirect('/login', 303);
    }

    if (user.totpEnabled && user.totpSecret) {
      reply.setCookie(
        TOTP_PENDING_COOKIE,
        JSON.stringify({ u: user.id, t: Date.now() }),
        pendingCookieOpts,
      );
      return reply.redirect('/login/totp', 303);
    }

    return finishLogin(req, reply, user.id);
  });

  // ---------- TOTP second step ----------
  app.get('/login/totp', async (req, reply) => {
    if (!readTotpPending(req)) return reply.redirect('/login', 303);
    return reply.viewPage('totp.eta', { title: 'Two-step verification' });
  });

  app.post('/login/totp', { config: loginRateLimit }, async (req, reply) => {
    const userId = readTotpPending(req);
    if (!userId) return reply.redirect('/login', 303);

    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    const code = ((req.body as Record<string, string>).code ?? '').trim();

    if (!user || user.disabled || !user.totpSecret || !verifyTotp(user.totpSecret, code)) {
      await audit(req, { action: 'auth.totp_fail', userId });
      return reply.flash('error', 'That code didn’t work. Try again.').redirect('/login/totp', 303);
    }
    return finishLogin(req, reply, user.id);
  });

  // ---------- Logout ----------
  app.post('/logout', { preHandler: requireAuth }, async (req, reply) => {
    await revokeSession(req.authContext!.session.id);
    clearSessionCookie(reply);
    await audit(req, { action: 'auth.logout' });
    return reply.redirect('/login', 303);
  });

  // ---------- Forgot password ----------
  app.get('/forgot-password', async (_req, reply) => {
    return reply.viewPage('forgot.eta', { title: 'Forgot password' });
  });

  app.post(
    '/forgot-password',
    { config: { rateLimit: { max: 5, timeWindow: 15 * 60 * 1000 } } },
    async (req, reply) => {
      const email = ((req.body as Record<string, string>).email ?? '').trim();
      const user = email
        ? await db.query.users.findFirst({ where: eq(users.email, email) })
        : undefined;

      if (user && !user.disabled) {
        const token = generateToken();
        await db.insert(passwordResets).values({
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
        });
        const link = `${config.PORTAL_URL}/reset-password/${token}`;
        await sendMail({ to: user.email, ...resetEmail(link) });
        await audit(req, { action: 'auth.reset_requested', userId: user.id });
      }
      // Same response either way — don't reveal whether the account exists.
      return reply
        .flash('ok', 'If that email has an account, a reset link is on its way.')
        .redirect('/login', 303);
    },
  );

  // ---------- Reset password ----------
  app.get<{ Params: { token: string } }>('/reset-password/:token', async (req, reply) => {
    const row = await db.query.passwordResets.findFirst({
      where: and(
        eq(passwordResets.tokenHash, hashToken(req.params.token)),
        isNull(passwordResets.usedAt),
        gt(passwordResets.expiresAt, new Date()),
      ),
    });
    if (!row) {
      return reply
        .flash('error', 'That reset link is invalid or expired. Request a new one.')
        .redirect('/forgot-password', 303);
    }
    return reply.viewPage('reset.eta', { title: 'Choose a new password', token: req.params.token });
  });

  app.post<{ Params: { token: string } }>('/reset-password/:token', async (req, reply) => {
    const row = await db.query.passwordResets.findFirst({
      where: and(
        eq(passwordResets.tokenHash, hashToken(req.params.token)),
        isNull(passwordResets.usedAt),
        gt(passwordResets.expiresAt, new Date()),
      ),
    });
    if (!row) {
      return reply
        .flash('error', 'That reset link is invalid or expired. Request a new one.')
        .redirect('/forgot-password', 303);
    }

    const password = (req.body as Record<string, string>).password ?? '';
    if (password.length < 12) {
      return reply
        .flash('error', 'Passwords need at least 12 characters.')
        .redirect(`/reset-password/${req.params.token}`, 303);
    }

    await db.update(users)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(users.id, row.userId));
    await db.update(passwordResets).set({ usedAt: new Date() }).where(eq(passwordResets.id, row.id));
    // A password reset kills every outstanding session for the account.
    await revokeAllSessions(row.userId);
    await audit(req, { action: 'auth.password_reset', userId: row.userId });

    return reply.flash('ok', 'Password updated. Sign in with your new password.').redirect('/login', 303);
  });

  // ---------- Accept invite ----------
  app.get<{ Params: { token: string } }>('/accept-invite/:token', async (req, reply) => {
    const invite = await db.query.invites.findFirst({
      where: and(
        eq(invites.tokenHash, hashToken(req.params.token)),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, new Date()),
      ),
    });
    if (!invite) {
      return reply
        .flash('error', 'That invite is invalid or expired. Ask us to send a fresh one.')
        .redirect('/login', 303);
    }
    return reply.viewPage('accept-invite.eta', {
      title: 'Set up your account',
      token: req.params.token,
      email: invite.email,
    });
  });

  app.post<{ Params: { token: string } }>('/accept-invite/:token', async (req, reply) => {
    const invite = await db.query.invites.findFirst({
      where: and(
        eq(invites.tokenHash, hashToken(req.params.token)),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, new Date()),
      ),
    });
    if (!invite) {
      return reply
        .flash('error', 'That invite is invalid or expired. Ask us to send a fresh one.')
        .redirect('/login', 303);
    }

    const body = req.body as Record<string, string>;
    const name = (body.name ?? '').trim();
    const password = body.password ?? '';
    if (!name || password.length < 12) {
      return reply
        .flash('error', 'Enter your name and a password of at least 12 characters.')
        .redirect(`/accept-invite/${req.params.token}`, 303);
    }

    const existing = await db.query.users.findFirst({ where: eq(users.email, invite.email) });
    if (existing) {
      return reply.flash('error', 'An account with that email already exists. Sign in instead.').redirect('/login', 303);
    }

    const [user] = await db
      .insert(users)
      .values({
        email: invite.email,
        name,
        passwordHash: await hashPassword(password),
        role: invite.role,
        clientId: invite.clientId,
      })
      .returning();
    await db.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, invite.id));

    await audit(req, {
      action: 'auth.invite_accepted',
      userId: user!.id,
      clientId: invite.clientId,
      entity: 'invite',
      entityId: invite.id,
    });
    return finishLogin(req, reply, user!.id);
  });
}
