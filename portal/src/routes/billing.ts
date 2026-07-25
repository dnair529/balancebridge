import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { clients, invoices } from '../db/schema.js';
import { requireAuth, resolveClientId, isStaff } from '../auth/guards.js';
import { audit } from '../lib/audit.js';
import { stripe } from '../lib/stripe.js';
import { config } from '../config.js';

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/billing', { preHandler: requireAuth }, async (req, reply) => {
    const clientId = resolveClientId(req);
    if (!clientId) return reply.redirect(isStaff(req) ? '/admin' : '/login', 303);

    const rows = await db.query.invoices.findMany({
      where: eq(invoices.clientId, clientId),
      orderBy: desc(invoices.issuedAt),
    });

    await audit(req, { action: 'invoice.view_list', clientId });

    const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
    return reply.viewPage('billing.eta', {
      title: 'Billing',
      invoiceRows: rows,
      clientId,
      portalAvailable: Boolean(stripe && client?.stripeCustomerId),
    });
  });

  /** Stripe-hosted customer portal (no card data ever touches this app). */
  app.post('/billing/portal', { preHandler: requireAuth }, async (req, reply) => {
    const clientId = resolveClientId(req);
    if (!clientId) return reply.redirect('/admin', 303);

    const client = await db.query.clients.findFirst({
      where: and(eq(clients.id, clientId)),
    });
    if (!stripe || !client?.stripeCustomerId) {
      return reply.flash('error', 'Billing portal isn’t set up yet — message us instead.').redirect('/billing', 303);
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: client.stripeCustomerId,
      return_url: `${config.PORTAL_URL}/billing`,
    });
    await audit(req, { action: 'billing.portal_open', clientId });
    return reply.redirect(session.url, 303);
  });
}
