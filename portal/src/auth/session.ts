import crypto from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/index.js';
import { sessions, users } from '../db/schema.js';
import { config } from '../config.js';
import { generateToken, hashToken } from './tokens.js';

export type SessionUser = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

export interface AuthContext {
  session: SessionRow;
  user: SessionUser;
}

const cookieOptions = {
  path: '/',
  httpOnly: true,
  secure: config.COOKIE_SECURE,
  sameSite: 'lax' as const,
  // No maxAge: session cookie in the browser; server enforces real lifetimes.
};

/**
 * Create a session: 32 random bytes base64url given to the client,
 * sha256(token+pepper) stored. Sets the __Host-session cookie.
 */
export async function createSession(
  reply: FastifyReply,
  userId: string,
  req: FastifyRequest,
): Promise<SessionRow> {
  const token = generateToken();
  const now = new Date();
  const [row] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      csrfToken: crypto.randomBytes(32).toString('base64url'),
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + config.session.absoluteMs),
      ip: req.ip,
      userAgent: (req.headers['user-agent'] ?? '').slice(0, 500),
    })
    .returning();
  reply.setCookie(config.sessionCookieName, token, cookieOptions);
  return row!;
}

/**
 * Validate the session cookie. Enforces: not revoked, absolute 14d expiry,
 * 24h idle timeout, user not disabled. Bumps last_seen_at (throttled to
 * once per 5 minutes to avoid a write on every request).
 */
export async function validateSession(req: FastifyRequest): Promise<AuthContext | null> {
  const token = req.cookies[config.sessionCookieName];
  if (!token) return null;

  // Lookup is by sha256(token+pepper); an attacker cannot craft a matching
  // hash without the pepper, and hash comparison happens inside Postgres on
  // fixed-length digests (no user-controlled timing side channel on the token).
  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)))
    .limit(1);

  const hit = rows[0];
  if (!hit) return null;

  const now = Date.now();
  const { session, user } = hit;
  if (now >= session.expiresAt.getTime()) return null; // absolute lifetime
  if (now - session.lastSeenAt.getTime() >= config.session.idleMs) {
    await revokeSession(session.id);
    return null; // idle timeout
  }
  if (user.disabled) {
    await revokeSession(session.id);
    return null;
  }

  if (now - session.lastSeenAt.getTime() > 5 * 60 * 1000) {
    await db.update(sessions).set({ lastSeenAt: new Date(now) }).where(eq(sessions.id, session.id));
  }
  return { session, user };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

/** Revoke every active session for a user (password reset, admin disable). */
export async function revokeAllSessions(userId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

/**
 * Session rotation on login and privilege change: revoke the presented
 * session (if any) and mint a fresh token + CSRF secret.
 */
export async function rotateSession(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): Promise<SessionRow> {
  const current = req.authContext;
  if (current) await revokeSession(current.session.id);
  return createSession(reply, userId, req);
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(config.sessionCookieName, cookieOptions);
}
