import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages, threadReads, threads, users } from '../db/schema.js';
import { requireAuth, resolveClientId, isStaff } from '../auth/guards.js';
import { audit } from '../lib/audit.js';
import { sendMail, newMessageEmail } from '../lib/mail.js';
import { config } from '../config.js';

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/messages', { preHandler: requireAuth }, async (req, reply) => {
    const clientId = resolveClientId(req);
    if (!clientId) return reply.redirect(isStaff(req) ? '/admin' : '/login', 303);
    const userId = req.authContext!.user.id;

    const rows = await db
      .select({
        thread: threads,
        lastMessageAt: sql<string | null>`(select max(m.created_at) from messages m where m.thread_id = ${threads.id})`,
        messageCount: sql<number>`(select count(*)::int from messages m where m.thread_id = ${threads.id})`,
        unread: sql<boolean>`exists(
          select 1 from messages m
          where m.thread_id = ${threads.id}
            and m.sender_id <> ${userId}
            and m.created_at > coalesce(
              (select tr.last_read_at from thread_reads tr
                where tr.thread_id = ${threads.id} and tr.user_id = ${userId}),
              'epoch'::timestamptz)
        )`,
      })
      .from(threads)
      .where(eq(threads.clientId, clientId))
      .orderBy(desc(threads.createdAt));

    return reply.viewPage('messages.eta', { title: 'Messages', threadRows: rows, clientId });
  });

  app.post('/messages/new', { preHandler: requireAuth }, async (req, reply) => {
    const clientId = resolveClientId(req);
    if (!clientId) return reply.redirect('/admin', 303);
    const body = req.body as Record<string, string>;
    const subject = (body.subject ?? '').trim().slice(0, 200);
    const text = (body.body ?? '').trim();
    if (!subject || !text) {
      return reply.flash('error', 'Add a subject and a message.').redirect(backTo(req, '/messages', clientId), 303);
    }

    const user = req.authContext!.user;
    const [thread] = await db
      .insert(threads)
      .values({ clientId, subject, createdBy: user.id })
      .returning();
    await db.insert(messages).values({ threadId: thread!.id, senderId: user.id, body: text });
    await db
      .insert(threadReads)
      .values({ threadId: thread!.id, userId: user.id, lastReadAt: new Date() })
      .onConflictDoUpdate({
        target: [threadReads.threadId, threadReads.userId],
        set: { lastReadAt: new Date() },
      });

    await audit(req, { action: 'message.send', clientId, entity: 'thread', entityId: thread!.id });
    await notifyOtherSide(req.authContext!.user.id, clientId, subject, thread!.id);

    return reply.redirect(backTo(req, `/messages/${thread!.id}`, clientId), 303);
  });

  app.get<{ Params: { threadId: string } }>(
    '/messages/:threadId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const clientId = resolveClientId(req);
      if (!clientId) return reply.redirect('/admin', 303);

      const thread = await db.query.threads.findFirst({
        where: and(eq(threads.id, req.params.threadId), eq(threads.clientId, clientId)),
      });
      if (!thread) {
        return reply.code(404).viewPage('error.eta', { title: 'Not found', message: 'That conversation doesn’t exist.' });
      }

      const msgs = await db
        .select({ message: messages, senderName: users.name, senderRole: users.role })
        .from(messages)
        .innerJoin(users, eq(users.id, messages.senderId))
        .where(eq(messages.threadId, thread.id))
        .orderBy(asc(messages.createdAt));

      // Mark read for the current user.
      const userId = req.authContext!.user.id;
      await db
        .insert(threadReads)
        .values({ threadId: thread.id, userId, lastReadAt: new Date() })
        .onConflictDoUpdate({
          target: [threadReads.threadId, threadReads.userId],
          set: { lastReadAt: new Date() },
        });

      return reply.viewPage('thread.eta', { title: thread.subject, thread, msgs, clientId });
    },
  );

  app.post<{ Params: { threadId: string } }>(
    '/messages/:threadId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const clientId = resolveClientId(req);
      if (!clientId) return reply.redirect('/admin', 303);

      const thread = await db.query.threads.findFirst({
        where: and(eq(threads.id, req.params.threadId), eq(threads.clientId, clientId)),
      });
      if (!thread || thread.closedAt) {
        return reply.code(404).viewPage('error.eta', { title: 'Not found', message: 'That conversation is closed.' });
      }

      const text = ((req.body as Record<string, string>).body ?? '').trim();
      if (!text) {
        return reply.redirect(backTo(req, `/messages/${thread.id}`, clientId), 303);
      }

      const user = req.authContext!.user;
      await db.insert(messages).values({ threadId: thread.id, senderId: user.id, body: text });
      await audit(req, { action: 'message.send', clientId, entity: 'thread', entityId: thread.id });
      await notifyOtherSide(user.id, clientId, thread.subject, thread.id);

      return reply.redirect(backTo(req, `/messages/${thread.id}`, clientId), 303);
    },
  );
}

function backTo(req: { authContext?: { user: { role: string } } }, path: string, clientId: string): string {
  const staff = req.authContext?.user.role !== 'client';
  return staff ? `${path}?client=${clientId}` : path;
}

/** Email the other side of the conversation (client user(s) or firm inbox). */
async function notifyOtherSide(
  senderId: string,
  clientId: string,
  subject: string,
  threadId: string,
): Promise<void> {
  const sender = await db.query.users.findFirst({ where: eq(users.id, senderId) });
  if (!sender) return;
  const link = `${config.PORTAL_URL}/messages/${threadId}`;

  if (sender.role === 'client') {
    await sendMail({ to: config.FIRM_INBOX, ...newMessageEmail(subject, `${link}?client=${clientId}`) });
  } else {
    const clientUsers = await db.query.users.findMany({
      where: and(eq(users.clientId, clientId), eq(users.disabled, false)),
    });
    for (const u of clientUsers) {
      await sendMail({ to: u.email, ...newMessageEmail(subject, link) });
    }
  }
}
