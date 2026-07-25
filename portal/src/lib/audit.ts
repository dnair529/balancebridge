import type { FastifyRequest } from 'fastify';
import { db } from '../db/index.js';
import { auditLog } from '../db/schema.js';

interface AuditInput {
  action: string;
  userId?: string | null;
  clientId?: string | null;
  entity?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
}

/**
 * Append-only audit trail. Failures are logged but never break the request —
 * except that callers who need write-and-fail-together can await + try/catch.
 * Nothing in app code ever updates or deletes audit_log rows.
 */
export async function audit(req: FastifyRequest | null, input: AuditInput): Promise<void> {
  try {
    await db.insert(auditLog).values({
      action: input.action,
      userId: input.userId ?? req?.authContext?.user.id ?? null,
      clientId: input.clientId ?? null,
      entity: input.entity ?? null,
      entityId: input.entityId ?? null,
      ip: req?.ip ?? null,
      meta: input.meta ?? null,
    });
  } catch (err) {
    req?.log.error({ err, action: input.action }, 'audit write failed');
  }
}
