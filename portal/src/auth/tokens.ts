import crypto from 'node:crypto';
import { config } from '../config.js';

/** 32 random bytes, base64url — used for sessions, invites, password resets. */
export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Tokens are stored as sha256(token + pepper). The pepper lives only in env,
 * so a leaked database alone cannot be replayed as valid tokens.
 */
export function hashToken(token: string): string {
  return crypto
    .createHash('sha256')
    .update(token)
    .update(config.SESSION_PEPPER)
    .digest('hex');
}

/** Constant-time string comparison (length-safe). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Compare against self to keep timing uniform, then fail.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}
