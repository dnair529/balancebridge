/**
 * Set a user's password from the command line.
 *
 *   node dist/db/set-password.js <email> <newPassword>
 *   node dist/db/set-password.js --all <newPassword>     # every user (NON-PROD ONLY)
 *
 * Hashes with the same argon2id parameters as the app and revokes every active
 * session for the affected users, so a password change always forces re-login.
 *
 * Refuses to run with NODE_ENV=production unless ALLOW_PROD_PASSWORD_RESET=1 —
 * this exists for UAT convenience and must not become a production habit.
 */
import { eq, inArray, isNull, and } from 'drizzle-orm';
import { db } from './index.js';
import { users, sessions } from './schema.js';
import { hashPassword } from '../auth/password.js';

const args = process.argv.slice(2);

function usage(msg: string): never {
  console.error(`error: ${msg}
usage:
  node dist/db/set-password.js <email> <newPassword>
  node dist/db/set-password.js --all <newPassword>`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (args.length !== 2) usage('expected exactly 2 arguments');

  const [target, newPassword] = args as [string, string];
  if (!newPassword) usage('password must not be empty');

  if (process.env['NODE_ENV'] === 'production' && process.env['ALLOW_PROD_PASSWORD_RESET'] !== '1') {
    console.error(
      'refusing to run against a production build without ALLOW_PROD_PASSWORD_RESET=1',
    );
    process.exit(2);
  }

  if (newPassword.length < 12) {
    console.warn(
      `warning: "${'*'.repeat(newPassword.length)}" is ${newPassword.length} characters. ` +
        'Acceptable for UAT; use a long unique password before this account touches real client data.',
    );
  }

  const hash = await hashPassword(newPassword);

  const targets =
    target === '--all'
      ? await db.select({ id: users.id, email: users.email }).from(users)
      : await db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(eq(users.email, target));

  if (targets.length === 0) usage(`no user found matching "${target}"`);

  const ids = targets.map((u) => u.id);
  await db.update(users).set({ passwordHash: hash }).where(inArray(users.id, ids));

  // Any existing session was authenticated with the old credential — revoke it.
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(inArray(sessions.userId, ids), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });

  for (const u of targets) console.log(`  updated  ${u.email}`);
  console.log(`done: ${targets.length} user(s), ${revoked.length} session(s) revoked.`);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('set-password failed:', err);
  process.exit(1);
});
