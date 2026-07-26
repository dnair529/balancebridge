/**
 * The automation actor.
 *
 * `lib/ai-guard.ts` makes a hard promise: **AI proposes, a human commits.** A
 * `Suggestion<T>` cannot be persisted until `.confirm(userId)` mints a branded
 * `ConfirmedSuggestion<T>` against a named user. That is exactly right for a
 * bookkeeper clearing a queue — and it still has to hold when a receipt lands
 * at 11pm from a phone with nobody watching.
 *
 * The resolution is that automated intake is not anonymous. Every automated
 * confirmation is attributed to a real `users` row — a staff/admin account
 * acting as the firm's automation identity — and:
 *
 *   * **Recording** an extraction (an append-only note of what the model read)
 *     is attributed to that actor.
 *   * **Committing** to the ledger — filing a document, linking a match,
 *     applying a category — additionally requires the confidence gate to pass.
 *     Below it, nothing is committed: the item goes to `needs_review` and a
 *     work item is raised for a person.
 *
 * So the actor is an accountability record, never a bypass. Confidence, not
 * the actor, is what licenses a write.
 *
 * Configure with `INTAKE_AUTOMATION_EMAIL`; otherwise the firm's
 * `ADMIN_EMAIL`, otherwise the oldest admin, otherwise the oldest staff user.
 */

import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { config } from '../config.js';

export class NoAutomationActorError extends Error {
  override readonly name = 'NoAutomationActorError';
  constructor() {
    super(
      'No staff or admin user exists to attribute automated intake to. ' +
        'Seed one (npm run db:seed) or set INTAKE_AUTOMATION_EMAIL to an existing staff account.',
    );
  }
}

export interface AutomationActor {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

let cached: AutomationActor | null = null;

/** Test/ops seam: forget the memoised actor (used after reseeding). */
export function resetAutomationActor(): void {
  cached = null;
}

export async function resolveAutomationActor(): Promise<AutomationActor> {
  if (cached) return cached;

  const preferred = (process.env['INTAKE_AUTOMATION_EMAIL'] ?? '').trim() || config.ADMIN_EMAIL;

  const byEmail = preferred
    ? await db.query.users.findFirst({ where: eq(users.email, preferred) })
    : undefined;

  const actor =
    byEmail && !byEmail.disabled && byEmail.role !== 'client'
      ? byEmail
      : await db.query.users.findFirst({
          where: inArray(users.role, ['admin', 'staff']),
          orderBy: [asc(users.createdAt)],
        });

  if (!actor) throw new NoAutomationActorError();
  cached = { id: actor.id, email: actor.email, name: actor.name };
  return cached;
}
