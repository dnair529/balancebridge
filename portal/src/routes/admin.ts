import type { FastifyInstance } from 'fastify';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  auditLog,
  clients,
  documents,
  invites,
  invoices,
  leads,
  signatureRequests,
  taskLists,
  tasks,
  threads,
  users,
} from '../db/schema.js';
import { requireStaff, requireAdmin } from '../auth/guards.js';
import { audit } from '../lib/audit.js';
import { generateToken, hashToken } from '../auth/tokens.js';
import { sendMail, inviteEmail, taskAssignedEmail, signatureRequestEmail } from '../lib/mail.js';
import { stripe, upsertInvoiceFromStripe } from '../lib/stripe.js';
import { createSubmissionFromPdf, docusealConfigured } from '../lib/docuseal.js';
import { config } from '../config.js';

/** Reusable checklist templates staff can apply to a client. */
const TASK_TEMPLATES: Record<string, { title: string; items: Array<{ title: string; owner: 'client' | 'firm' }> }> = {
  onboarding: {
    title: 'Onboarding',
    items: [
      { title: 'Connect bank feeds (read-only)', owner: 'client' },
      { title: 'Upload last 3 months of bank statements', owner: 'client' },
      { title: 'Share prior-year financials', owner: 'client' },
      { title: 'Set up chart of accounts', owner: 'firm' },
      { title: 'Kickoff call', owner: 'firm' },
    ],
  },
  monthly_close: {
    title: 'Monthly close',
    items: [
      { title: 'Upload bank & credit card statements', owner: 'client' },
      { title: 'Answer open transaction questions', owner: 'client' },
      { title: 'Reconcile all accounts', owner: 'firm' },
      { title: 'Deliver financial package', owner: 'firm' },
    ],
  },
  year_end: {
    title: 'Year-end wrap-up',
    items: [
      { title: 'Confirm 1099 vendor list', owner: 'client' },
      { title: 'Upload December statements', owner: 'client' },
      { title: 'Post year-end adjustments', owner: 'firm' },
      { title: 'Send package to your CPA', owner: 'firm' },
    ],
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Everything under /admin requires staff; /admin/audit requires admin.
  app.addHook('preHandler', requireStaff);

  // ---------- Overview ----------
  app.get('/admin', async (_req, reply) => {
    const [clientRows, openLeads, pendingSigs, openInvoices] = await Promise.all([
      db.query.clients.findMany({ orderBy: desc(clients.createdAt) }),
      db.query.leads.findMany({ where: isNull(leads.handledAt), orderBy: desc(leads.createdAt) }),
      db.query.signatureRequests.findMany({ where: eq(signatureRequests.status, 'pending') }),
      db.query.invoices.findMany({ where: eq(invoices.status, 'open') }),
    ]);
    return reply.viewPage('admin/index.eta', {
      title: 'Admin',
      clientRows,
      openLeads,
      pendingSigs,
      openInvoices,
    });
  });

  // ---------- Clients ----------
  app.get('/admin/clients', async (_req, reply) => {
    const rows = await db.query.clients.findMany({ orderBy: desc(clients.createdAt) });
    return reply.viewPage('admin/clients.eta', { title: 'Clients', clientRows: rows });
  });

  app.post('/admin/clients', async (req, reply) => {
    const body = req.body as Record<string, string>;
    const businessName = (body.business_name ?? '').trim();
    if (!businessName) {
      return reply.flash('error', 'Business name is required.').redirect('/admin/clients', 303);
    }
    const [client] = await db
      .insert(clients)
      .values({
        businessName: businessName.slice(0, 200),
        contactName: (body.contact_name ?? '').trim().slice(0, 200) || null,
        email: (body.email ?? '').trim().slice(0, 254) || null,
        phone: (body.phone ?? '').trim().slice(0, 50) || null,
        stripeCustomerId: (body.stripe_customer_id ?? '').trim().slice(0, 100) || null,
        notes: (body.notes ?? '').trim().slice(0, 5000) || null,
      })
      .returning();
    await audit(req, { action: 'admin.client_create', clientId: client!.id, entity: 'client', entityId: client!.id });
    return reply.flash('ok', `Added ${client!.businessName}.`).redirect(`/admin/clients/${client!.id}`, 303);
  });

  app.get<{ Params: { id: string } }>('/admin/clients/:id', async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.callNotFound();
    const client = await db.query.clients.findFirst({ where: eq(clients.id, req.params.id) });
    if (!client) return reply.callNotFound();

    const [docs, threadRows, lists, listTasks, invoiceRows, sigRows, userRows, inviteRows] =
      await Promise.all([
        db.query.documents.findMany({
          where: and(eq(documents.clientId, client.id), isNull(documents.deletedAt)),
          orderBy: desc(documents.createdAt),
        }),
        db.query.threads.findMany({ where: eq(threads.clientId, client.id), orderBy: desc(threads.createdAt) }),
        db.query.taskLists.findMany({
          where: and(eq(taskLists.clientId, client.id), isNull(taskLists.archivedAt)),
          orderBy: desc(taskLists.createdAt),
        }),
        db
          .select({ task: tasks })
          .from(tasks)
          .innerJoin(taskLists, eq(taskLists.id, tasks.listId))
          .where(eq(taskLists.clientId, client.id))
          .orderBy(tasks.sortOrder),
        db.query.invoices.findMany({ where: eq(invoices.clientId, client.id), orderBy: desc(invoices.issuedAt) }),
        db.query.signatureRequests.findMany({
          where: eq(signatureRequests.clientId, client.id),
          orderBy: desc(signatureRequests.createdAt),
        }),
        db.query.users.findMany({ where: eq(users.clientId, client.id) }),
        db.query.invites.findMany({
          where: and(eq(invites.clientId, client.id), isNull(invites.acceptedAt)),
        }),
      ]);

    const byList = new Map<string, (typeof tasks.$inferSelect)[]>();
    for (const { task } of listTasks) {
      const arr = byList.get(task.listId) ?? [];
      arr.push(task);
      byList.set(task.listId, arr);
    }

    return reply.viewPage('admin/client-detail.eta', {
      title: client.businessName,
      client,
      docs,
      threadRows,
      lists,
      byList,
      invoiceRows,
      sigRows,
      userRows,
      inviteRows,
      templates: Object.entries(TASK_TEMPLATES).map(([key, t]) => ({ key, title: t.title })),
      docusealOn: docusealConfigured(),
    });
  });

  // ---------- Task list creation (template or custom lines) ----------
  app.post<{ Params: { id: string } }>('/admin/clients/:id/tasks', async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.callNotFound();
    const client = await db.query.clients.findFirst({ where: eq(clients.id, req.params.id) });
    if (!client) return reply.callNotFound();

    const body = req.body as Record<string, string>;
    const templateKey = body.template ?? '';
    const template = TASK_TEMPLATES[templateKey];

    let title: string;
    let items: Array<{ title: string; owner: 'client' | 'firm' }>;
    if (template) {
      title = (body.title ?? '').trim() || template.title;
      items = template.items;
    } else {
      title = (body.title ?? '').trim();
      items = (body.items ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) =>
          line.startsWith('!')
            ? { title: line.slice(1).trim(), owner: 'firm' as const }
            : { title: line, owner: 'client' as const },
        );
    }
    if (!title || items.length === 0) {
      return reply
        .flash('error', 'Pick a template, or give the list a title and at least one line.')
        .redirect(`/admin/clients/${client.id}`, 303);
    }

    const [list] = await db
      .insert(taskLists)
      .values({ clientId: client.id, title: title.slice(0, 200), createdBy: req.authContext!.user.id })
      .returning();
    await db.insert(tasks).values(
      items.map((item, i) => ({
        listId: list!.id,
        title: item.title.slice(0, 300),
        owner: item.owner,
        sortOrder: i + 1,
      })),
    );

    await audit(req, { action: 'admin.tasklist_create', clientId: client.id, entity: 'task_list', entityId: list!.id });

    // Notify the client's portal users.
    const clientUsers = await db.query.users.findMany({
      where: and(eq(users.clientId, client.id), eq(users.disabled, false)),
    });
    for (const u of clientUsers) {
      await sendMail({ to: u.email, ...taskAssignedEmail(title, `${config.PORTAL_URL}/tasks`) });
    }

    return reply.flash('ok', `Checklist "${title}" created.`).redirect(`/admin/clients/${client.id}`, 303);
  });

  // ---------- Invites ----------
  app.get('/admin/invites', async (_req, reply) => {
    const rows = await db
      .select({ invite: invites, clientName: clients.businessName, inviterName: users.name })
      .from(invites)
      .leftJoin(clients, eq(clients.id, invites.clientId))
      .innerJoin(users, eq(users.id, invites.createdBy))
      .orderBy(desc(invites.expiresAt));
    const clientRows = await db.query.clients.findMany({ orderBy: clients.businessName });
    return reply.viewPage('admin/invites.eta', { title: 'Invites', inviteRows: rows, clientRows });
  });

  app.post('/admin/invites', async (req, reply) => {
    const me = req.authContext!.user;
    const body = req.body as Record<string, string>;
    const email = (body.email ?? '').trim();
    const role = body.role === 'staff' || body.role === 'admin' ? body.role : 'client';
    const clientId = (body.client_id ?? '').trim();

    // Only admins may mint staff/admin accounts.
    if (role !== 'client' && me.role !== 'admin') {
      return reply.flash('error', 'Only admins can invite staff.').redirect('/admin/invites', 303);
    }
    if (!email || !email.includes('@')) {
      return reply.flash('error', 'A valid email is required.').redirect('/admin/invites', 303);
    }
    if (role === 'client' && !UUID_RE.test(clientId)) {
      return reply.flash('error', 'Pick which client this person belongs to.').redirect('/admin/invites', 303);
    }

    const token = generateToken();
    const [invite] = await db
      .insert(invites)
      .values({
        email,
        role,
        clientId: role === 'client' ? clientId : null,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000), // 7 days
        createdBy: me.id,
      })
      .returning();

    const link = `${config.PORTAL_URL}/accept-invite/${token}`;
    await sendMail({ to: email, ...inviteEmail(link, me.name) });
    await audit(req, {
      action: 'admin.invite_create',
      clientId: invite!.clientId,
      entity: 'invite',
      entityId: invite!.id,
      meta: { email, role },
    });

    return reply.flash('ok', `Invite sent to ${email}.`).redirect('/admin/invites', 303);
  });

  // ---------- Leads ----------
  app.get('/admin/leads', async (_req, reply) => {
    const rows = await db.query.leads.findMany({ orderBy: desc(leads.createdAt), limit: 200 });
    return reply.viewPage('admin/leads.eta', { title: 'Leads', leadRows: rows });
  });

  app.post<{ Params: { id: string } }>('/admin/leads/:id/handled', async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.callNotFound();
    await db.update(leads).set({ handledAt: new Date() }).where(eq(leads.id, req.params.id));
    await audit(req, { action: 'admin.lead_handled', entity: 'lead', entityId: req.params.id });
    return reply.redirect('/admin/leads', 303);
  });

  // ---------- Signatures: create DocuSeal submission from an uploaded doc ----------
  app.post('/admin/signatures/new', async (req, reply) => {
    const body = req.body as Record<string, string>;
    const documentId = (body.document_id ?? '').trim();
    const signerEmail = (body.signer_email ?? '').trim();
    const title = (body.title ?? '').trim().slice(0, 200);

    if (!docusealConfigured()) {
      return reply.flash('error', 'DocuSeal isn’t configured on this environment.').redirect('/admin', 303);
    }
    if (!UUID_RE.test(documentId) || !signerEmail.includes('@') || !title) {
      return reply.flash('error', 'Pick a PDF document, a title, and a signer email.').redirect('/admin', 303);
    }

    const doc = await db.query.documents.findFirst({
      where: and(eq(documents.id, documentId), isNull(documents.deletedAt)),
    });
    if (!doc || !doc.filename.toLowerCase().endsWith('.pdf')) {
      return reply.flash('error', 'Signature requests need an existing PDF document.').redirect('/admin', 303);
    }

    const pdf = await fsp.readFile(path.join(config.uploadsDir, doc.storedName));
    const { submissionId } = await createSubmissionFromPdf({
      title,
      pdfBase64: pdf.toString('base64'),
      signerEmail,
    });

    const [sig] = await db
      .insert(signatureRequests)
      .values({
        clientId: doc.clientId,
        title,
        docusealSubmissionId: submissionId,
        signerEmail,
        createdBy: req.authContext!.user.id,
      })
      .returning();

    await audit(req, {
      action: 'signature.request_created',
      clientId: doc.clientId,
      entity: 'signature_request',
      entityId: sig!.id,
    });
    await sendMail({
      to: signerEmail,
      ...signatureRequestEmail(title, `${config.PORTAL_URL}/signatures/${sig!.id}`),
    });

    return reply
      .flash('ok', `Signature request "${title}" sent to ${signerEmail}.`)
      .redirect(`/admin/clients/${doc.clientId}`, 303);
  });

  // ---------- Invoice sync (pull from Stripe) ----------
  app.post('/admin/invoices/sync', async (req, reply) => {
    if (!stripe) {
      return reply.flash('error', 'Stripe isn’t configured on this environment.').redirect('/admin', 303);
    }
    const withStripe = await db.query.clients.findMany({
      where: sql`${clients.stripeCustomerId} is not null`,
    });
    let synced = 0;
    for (const client of withStripe) {
      const list = await stripe.invoices.list({ customer: client.stripeCustomerId!, limit: 100 });
      for (const inv of list.data) {
        if (await upsertInvoiceFromStripe(inv)) synced += 1;
      }
    }
    await audit(req, { action: 'admin.invoice_sync', meta: { synced } });
    return reply.flash('ok', `Synced ${synced} invoice${synced === 1 ? '' : 's'} from Stripe.`).redirect('/admin', 303);
  });

  // ---------- Audit log (admin only) ----------
  app.get('/admin/audit', { preHandler: requireAdmin }, async (_req, reply) => {
    const rows = await db
      .select({ entry: auditLog, userName: users.name, userEmail: users.email })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.userId))
      .orderBy(desc(auditLog.id))
      .limit(300);
    return reply.viewPage('admin/audit.eta', { title: 'Audit log', auditRows: rows });
  });
}
