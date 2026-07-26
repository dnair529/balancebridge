import type { FastifyInstance } from 'fastify';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  auditLog,
  channelIdentities,
  clients,
  documents,
  intakeItems,
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
import { runRetention } from '../lib/retention.js';
import { config } from '../config.js';
import { linkIdentity } from '../intake/identity.js';
import type { Channel } from '../intake/channels/types.js';
import { recomputeAll } from '../services/healthScore.js';
import {
  aiUsage,
  clientOverview,
  integrationRows,
  isIntegrationProvider,
  quarantineQueue,
  recheckIntegration,
  rulesOverview,
  setRuleDisabled,
  systemHealth,
  RETENTION_AUDIT_ACTION,
} from '../services/adminOverview.js';

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

/**
 * The channels an identity can be registered on — the `channel_identities`
 * enum, restated so a form value is validated against a list rather than
 * trusted into an enum column.
 */
const IDENTITY_CHANNELS: readonly Channel[] = [
  'sms',
  'whatsapp',
  'email',
  'portal',
  'pwa',
  'voice',
  'cloud_folder',
  'bank_feed',
];

function isIdentityChannel(value: string): value is Channel {
  return (IDENTITY_CHANNELS as readonly string[]).includes(value);
}

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

    // Everything the v1 subsystems know about this client: who can text us,
    // how healthy the books are, what we are still chasing, where the close is,
    // and whether the engagement is paying for the effort it takes.
    const overview = await clientOverview(client.id);

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
      overview,
      channels: IDENTITY_CHANNELS,
    });
  });

  /* ====================================================================== */
  /* Channel identities — what makes SMS capture work for a client          */
  /* ====================================================================== */

  /**
   * Register an identity against a client.
   *
   * Normalisation is `linkIdentity`'s job, not this route's: a phone number
   * typed as `(512) 555-0147` becomes `+15125550147` there, which is the only
   * form an inbound Twilio webhook will ever match. Doing it here as well would
   * be a second implementation of the rule that decides which client a receipt
   * belongs to.
   */
  app.post<{ Params: { id: string } }>('/admin/clients/:id/identities', async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.callNotFound();
    const client = await db.query.clients.findFirst({ where: eq(clients.id, req.params.id) });
    if (!client) return reply.callNotFound();
    const back = `/admin/clients/${client.id}`;

    const body = (req.body ?? {}) as Record<string, string>;
    const channel = (body.channel ?? '').trim();
    const raw = (body.identity ?? '').trim();
    if (!isIdentityChannel(channel)) {
      return reply.flash('error', 'Pick a channel from the list.').redirect(back, 303);
    }
    if (!raw) {
      return reply.flash('error', 'An identity needs a phone number, address or folder id.').redirect(back, 303);
    }

    // Moving an identity between clients is legitimate (a bookkeeper fixing a
    // mistake) but it is never silent — record where it came from.
    const existing = await db.query.channelIdentities.findFirst({
      where: eq(channelIdentities.identity, raw),
    });

    let linked;
    try {
      linked = await linkIdentity({
        clientId: client.id,
        channel,
        identity: raw,
        label: (body.label ?? '').trim().slice(0, 200) || null,
        verified: body.verified === '1',
        // TCPA: consent is an explicit act with a timestamp, never a default.
        consent: body.consent === '1',
      });
    } catch (err) {
      return reply
        .flash('error', err instanceof Error ? err.message : 'That identity could not be normalised.')
        .redirect(back, 303);
    }

    await audit(req, {
      action: 'admin.identity_link',
      clientId: client.id,
      entity: 'channel_identity',
      entityId: linked.identityId,
      meta: {
        channel,
        raw,
        normalized: linked.identity,
        verified: Boolean(linked.verifiedAt),
        consentAt: linked.consentAt?.toISOString() ?? null,
        movedFromClientId: existing && existing.clientId !== client.id ? existing.clientId : null,
      },
    });

    const consentNote = linked.consentAt
      ? ` Consent recorded ${linked.consentAt.toISOString()}.`
      : ' No consent recorded — we can reply, but we cannot start a conversation on this identity.';
    return reply
      .flash('ok', `Linked ${channel} ${linked.identity} to ${client.businessName}.${consentNote}`)
      .redirect(back, 303);
  });

  /**
   * Consent, withdrawal and removal on an existing identity. All three are
   * timestamped writes, because "when did they agree" is the only version of
   * that question a TCPA complaint cares about.
   */
  app.post<{ Params: { id: string; identityId: string } }>(
    '/admin/clients/:id/identities/:identityId',
    async (req, reply) => {
      if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.identityId)) {
        return reply.callNotFound();
      }
      const back = `/admin/clients/${req.params.id}`;
      const row = await db.query.channelIdentities.findFirst({
        where: and(
          eq(channelIdentities.id, req.params.identityId),
          eq(channelIdentities.clientId, req.params.id),
        ),
      });
      if (!row) return reply.callNotFound();

      const action = ((req.body ?? {}) as Record<string, string>).action ?? '';
      const now = new Date();
      let message: string;

      if (action === 'consent') {
        await db
          .update(channelIdentities)
          .set({ consentAt: now, revokedAt: null })
          .where(eq(channelIdentities.id, row.id));
        message = `TCPA consent recorded for ${row.identity} at ${now.toISOString()}.`;
      } else if (action === 'withdraw') {
        // Same effect as an inbound STOP: consent goes, the identity stays
        // resolvable so their next text still reaches the right client.
        await db.update(channelIdentities).set({ consentAt: null }).where(eq(channelIdentities.id, row.id));
        message = `Consent withdrawn for ${row.identity}. Nothing will be sent to it unprompted.`;
      } else if (action === 'remove') {
        // Revoked, not deleted: a deleted identity takes the provenance of
        // everything that ever arrived on it with it.
        await db
          .update(channelIdentities)
          .set({ revokedAt: now, consentAt: null })
          .where(eq(channelIdentities.id, row.id));
        message = `Removed ${row.identity}. Anything it sends from now on lands in quarantine.`;
      } else if (action === 'verify') {
        await db
          .update(channelIdentities)
          .set({ verifiedAt: row.verifiedAt ?? now })
          .where(eq(channelIdentities.id, row.id));
        message = `Marked ${row.identity} as verified.`;
      } else {
        return reply.flash('error', 'Unknown action.').redirect(back, 303);
      }

      await audit(req, {
        action: `admin.identity_${action}`,
        clientId: row.clientId,
        entity: 'channel_identity',
        entityId: row.id,
        meta: { channel: row.channel, identity: row.identity, at: now.toISOString() },
      });
      return reply.flash('ok', message).redirect(back, 303);
    },
  );

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

  /* ====================================================================== */
  /* Integrations — what is connected, and what each connection unlocks      */
  /* ====================================================================== */

  /**
   * Read-only status for every provider. **No secret value is ever put into
   * the template locals** — `integrationRows()` reports presence booleans and
   * variable names, never the strings themselves, so this page cannot leak a
   * key even if somebody adds a `<%= %>` in the wrong place.
   */
  app.get('/admin/integrations', async (_req, reply) => {
    const rows = await integrationRows();
    return reply.viewPage('admin/integrations.eta', {
      title: 'Integrations',
      rows,
      counts: {
        configured: rows.filter((r) => r.liveStatus === 'configured').length,
        error: rows.filter((r) => r.liveStatus === 'error').length,
        notConfigured: rows.filter((r) => r.liveStatus === 'not_configured').length,
        drifted: rows.filter((r) => r.drifted).length,
      },
    });
  });

  /** Re-probe one provider and write the result to `integrations`. Admin only. */
  app.post<{ Params: { provider: string } }>(
    '/admin/integrations/:provider/recheck',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const provider = req.params.provider;
      if (!isIntegrationProvider(provider)) {
        return reply.flash('error', 'Unknown provider.').redirect('/admin/integrations', 303);
      }
      const probe = await recheckIntegration(provider);
      await audit(req, {
        action: 'admin.integration_recheck',
        entity: 'integrations',
        entityId: provider,
        // The detail line never contains a credential — see adminOverview.ts.
        meta: { provider, status: probe.liveStatus, detail: probe.detail },
      });
      return reply
        .flash(
          probe.liveStatus === 'error' ? 'error' : 'ok',
          `${probe.title}: ${probe.liveStatus.replace('_', ' ')} — ${probe.detail}`,
        )
        .redirect('/admin/integrations', 303);
    },
  );

  /* ====================================================================== */
  /* Categorisation rules — the compounding asset, made visible              */
  /* ====================================================================== */

  app.get('/admin/rules', async (_req, reply) => {
    const overview = await rulesOverview();
    return reply.viewPage('admin/rules.eta', { title: 'Rules', ...overview });
  });

  app.post<{ Params: { id: string } }>('/admin/rules/:id/toggle', async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.callNotFound();
    const disable = ((req.body ?? {}) as Record<string, string>).disable === '1';
    const row = await setRuleDisabled(req.params.id, disable);
    if (!row) return reply.callNotFound();

    await audit(req, {
      action: disable ? 'admin.rule_disable' : 'admin.rule_enable',
      clientId: row.clientId,
      entity: 'categorization_rules',
      entityId: row.id,
      meta: { pattern: row.pattern, matchType: row.matchType, hitCount: row.hitCount },
    });
    return reply
      .flash('ok', `${disable ? 'Disabled' : 'Re-enabled'} the rule for "${row.pattern}".`)
      .redirect('/admin/rules', 303);
  });

  /* ====================================================================== */
  /* AI usage and safety                                                    */
  /* ====================================================================== */

  app.get('/admin/ai', async (_req, reply) => {
    const usage = await aiUsage();
    return reply.viewPage('admin/ai.eta', {
      title: 'AI usage',
      ...usage,
      threshold: config.AI_CONFIDENCE_THRESHOLD,
      provider: config.AI_PROVIDER,
    });
  });

  /* ====================================================================== */
  /* Quarantine — inbound we could not resolve to a client                  */
  /* ====================================================================== */

  app.get('/admin/quarantine', async (_req, reply) => {
    const [rows, clientRows] = await Promise.all([
      quarantineQueue(),
      db.query.clients.findMany({ orderBy: [asc(clients.businessName)] }),
    ]);
    return reply.viewPage('admin/quarantine.eta', {
      title: 'Quarantine',
      rows,
      clientRows,
    });
  });

  /**
   * Claim a quarantined item for a client, optionally remembering the sender.
   *
   * `POST /api/intake/:id/assign` does the same thing for API callers and also
   * replays the payload through the pipeline; it answers JSON, which is the
   * wrong thing to hand a browser mid-form. The identity rule itself is not
   * duplicated — `linkIdentity` is the same helper that endpoint calls.
   */
  app.post<{ Params: { id: string } }>('/admin/quarantine/:id/assign', async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.callNotFound();
    const body = (req.body ?? {}) as Record<string, string>;
    const clientId = (body.client_id ?? '').trim();
    if (!UUID_RE.test(clientId)) {
      return reply.flash('error', 'Pick which client this belongs to.').redirect('/admin/quarantine', 303);
    }

    const [item, client] = await Promise.all([
      db.query.intakeItems.findFirst({ where: eq(intakeItems.id, req.params.id) }),
      db.query.clients.findFirst({ where: eq(clients.id, clientId) }),
    ]);
    if (!item) return reply.callNotFound();
    if (!client) {
      return reply.flash('error', 'That client no longer exists.').redirect('/admin/quarantine', 303);
    }
    if (item.status !== 'quarantined') {
      return reply
        .flash('error', `That item is ${item.status}, not quarantined — somebody else already claimed it.`)
        .redirect('/admin/quarantine', 303);
    }

    // Remembering is opt-in: a one-off forward from a client's accountant
    // should not permanently bind that address to the client.
    const remember = body.remember === '1' && Boolean(item.senderIdentity);
    if (remember) {
      await linkIdentity({
        clientId,
        channel: item.channel,
        identity: item.senderIdentity!,
        label: (body.label ?? '').trim().slice(0, 200) || null,
        verified: true,
        consent: body.consent === '1',
      });
    }

    await db
      .update(intakeItems)
      .set({ clientId, status: 'received', quarantineReason: null })
      .where(eq(intakeItems.id, item.id));

    await audit(req, {
      action: 'intake.assigned',
      clientId,
      entity: 'intake_item',
      entityId: item.id,
      meta: {
        channel: item.channel,
        senderIdentity: item.senderIdentity,
        rememberIdentity: remember,
        via: 'admin.quarantine',
      },
    });

    return reply
      .flash(
        'ok',
        `Assigned to ${client.businessName}.${remember ? ' Next message from that sender resolves on its own.' : ''}`,
      )
      .redirect('/admin/quarantine', 303);
  });

  /* ====================================================================== */
  /* System health                                                          */
  /* ====================================================================== */

  app.get('/admin/health', async (_req, reply) => {
    const health = await systemHealth();
    return reply.viewPage('admin/health.eta', { title: 'System health', ...health });
  });

  /** Recompute every active client's books health score. */
  app.post('/admin/health/recompute', async (req, reply) => {
    const results = await recomputeAll();
    await audit(req, {
      action: 'admin.health_recompute',
      entity: 'health_scores',
      meta: { clients: results.length },
    });
    return reply
      .flash('ok', `Recomputed the books health score for ${results.length} client${results.length === 1 ? '' : 's'}.`)
      .redirect('/admin/health', 303);
  });

  /**
   * Run the retention report. Dry run only — this page reports what is
   * eligible for deletion; the deletion itself stays a deliberate act on the
   * command line (`node dist/lib/retention.js --apply`), where it is reviewable
   * and does not hang off a browser session.
   */
  app.post('/admin/health/retention', { preHandler: requireAdmin }, async (req, reply) => {
    const report = await runRetention({ dryRun: true });
    await audit(req, {
      action: RETENTION_AUDIT_ACTION,
      entity: 'retention',
      meta: {
        dryRun: true,
        totalMatched: report.totalMatched,
        hadErrors: report.hadErrors,
        buckets: report.buckets.map((b) => ({ name: b.name, matched: b.matched, windowDays: b.windowDays })),
      },
    });
    return reply
      .flash(
        report.hadErrors ? 'error' : 'ok',
        `Retention dry run: ${report.totalMatched} row${report.totalMatched === 1 ? '' : 's'} eligible across ${report.buckets.length} buckets. Nothing was deleted.`,
      )
      .redirect('/admin/health', 303);
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
