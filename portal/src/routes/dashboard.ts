import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  documents,
  invoices,
  signatureRequests,
  taskLists,
  tasks,
  threads,
} from '../db/schema.js';
import { requireAuth, resolveClientId, isStaff } from '../auth/guards.js';

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: requireAuth }, async (_req, reply) => {
    return reply.redirect('/dashboard', 303);
  });

  app.get('/dashboard', { preHandler: requireAuth }, async (req, reply) => {
    // Firm-side users work out of /admin; the client dashboard is client-scoped.
    if (isStaff(req) && !resolveClientId(req)) return reply.redirect('/admin', 303);

    const clientId = resolveClientId(req);
    if (!clientId) return reply.redirect('/login', 303);

    const [recentDocs, openThreads, openInvoices, pendingSignatures, listRows] = await Promise.all([
      db.query.documents.findMany({
        where: and(eq(documents.clientId, clientId), isNull(documents.deletedAt)),
        orderBy: desc(documents.createdAt),
        limit: 5,
      }),
      db.query.threads.findMany({
        where: and(eq(threads.clientId, clientId), isNull(threads.closedAt)),
        orderBy: desc(threads.createdAt),
        limit: 5,
      }),
      db.query.invoices.findMany({
        where: and(eq(invoices.clientId, clientId), inArray(invoices.status, ['open', 'past_due'])),
        orderBy: desc(invoices.issuedAt),
      }),
      db.query.signatureRequests.findMany({
        where: and(eq(signatureRequests.clientId, clientId), eq(signatureRequests.status, 'pending')),
      }),
      db.query.taskLists.findMany({
        where: and(eq(taskLists.clientId, clientId), isNull(taskLists.archivedAt)),
        columns: { id: true },
      }),
    ]);

    let openTasks: (typeof tasks.$inferSelect)[] = [];
    if (listRows.length > 0) {
      openTasks = await db.query.tasks.findMany({
        where: and(
          inArray(tasks.listId, listRows.map((l) => l.id)),
          eq(tasks.owner, 'client'),
          isNull(tasks.completedAt),
        ),
        orderBy: [tasks.sortOrder],
        limit: 8,
      });
    }

    const amountDueCents = openInvoices.reduce(
      (sum, inv) => sum + Math.max(0, inv.amountDueCents - inv.amountPaidCents),
      0,
    );

    return reply.viewPage('dashboard.eta', {
      title: 'Dashboard',
      recentDocs,
      openThreads,
      openInvoices,
      pendingSignatures,
      openTasks,
      amountDueCents,
    });
  });

  // Lightweight health endpoint (also used by the Docker HEALTHCHECK).
  app.get('/healthz', { config: { skipCsrf: true } }, async (_req, reply) => {
    await db.execute(sql`SELECT 1`);
    return reply.send({ ok: true });
  });
}
