import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { taskLists, tasks } from '../db/schema.js';
import { requireAuth, resolveClientId, isStaff } from '../auth/guards.js';
import { audit } from '../lib/audit.js';

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tasks', { preHandler: requireAuth }, async (req, reply) => {
    const clientId = resolveClientId(req);
    if (!clientId) return reply.redirect(isStaff(req) ? '/admin' : '/login', 303);

    const lists = await db.query.taskLists.findMany({
      where: and(eq(taskLists.clientId, clientId), isNull(taskLists.archivedAt)),
      orderBy: desc(taskLists.createdAt),
    });

    const items = lists.length
      ? await db.query.tasks.findMany({
          where: inArray(tasks.listId, lists.map((l) => l.id)),
          orderBy: [asc(tasks.sortOrder)],
        })
      : [];

    const byList = new Map<string, (typeof tasks.$inferSelect)[]>();
    for (const t of items) {
      const arr = byList.get(t.listId) ?? [];
      arr.push(t);
      byList.set(t.listId, arr);
    }

    return reply.viewPage('tasks.eta', { title: 'Tasks', lists, byList, clientId });
  });

  /** Toggle completion. Clients may only toggle tasks whose owner is 'client'. */
  app.post<{ Params: { id: string } }>(
    '/tasks/:id/toggle',
    { preHandler: requireAuth },
    async (req, reply) => {
      const clientId = resolveClientId(req);
      if (!clientId) return reply.redirect('/admin', 303);
      const user = req.authContext!.user;

      // Join through the list so the task is provably in this client's scope.
      const rows = await db
        .select({ task: tasks })
        .from(tasks)
        .innerJoin(taskLists, eq(taskLists.id, tasks.listId))
        .where(and(eq(tasks.id, req.params.id), eq(taskLists.clientId, clientId)))
        .limit(1);
      const task = rows[0]?.task;
      if (!task) {
        return reply.code(404).viewPage('error.eta', { title: 'Not found', message: 'That task doesn’t exist.' });
      }
      if (user.role === 'client' && task.owner !== 'client') {
        return reply.code(403).viewPage('error.eta', {
          title: 'Not allowed',
          message: 'That item is on our side of the checklist.',
        });
      }

      const nowDone = !task.completedAt;
      await db
        .update(tasks)
        .set({
          completedAt: nowDone ? new Date() : null,
          completedBy: nowDone ? user.id : null,
        })
        .where(eq(tasks.id, task.id));

      await audit(req, {
        action: nowDone ? 'task.complete' : 'task.reopen',
        clientId,
        entity: 'task',
        entityId: task.id,
      });

      const dest = isStaff(req) ? `/tasks?client=${clientId}` : '/tasks';
      return reply.redirect(dest, 303);
    },
  );
}
