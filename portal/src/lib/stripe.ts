import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { clients, invoices } from '../db/schema.js';
import { config } from '../config.js';

/** null when Stripe isn't configured (dev) — callers must handle that. */
export const stripe: Stripe | null = config.STRIPE_SECRET_KEY
  ? new Stripe(config.STRIPE_SECRET_KEY)
  : null;

/**
 * Upsert our mirror row for a Stripe invoice. We store status metadata only —
 * no card data ever (spec §10). Idempotent: keyed on stripe_invoice_id.
 * Returns the client_id the invoice belongs to, or null if we don't know
 * the customer (invoice for someone who isn't a portal client).
 */
export async function upsertInvoiceFromStripe(inv: Stripe.Invoice): Promise<string | null> {
  const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
  if (!customerId || !inv.id) return null;

  const client = await db.query.clients.findFirst({
    where: eq(clients.stripeCustomerId, customerId),
  });
  if (!client) return null;

  const values = {
    clientId: client.id,
    stripeInvoiceId: inv.id,
    number: inv.number ?? null,
    amountDueCents: inv.amount_due ?? 0,
    amountPaidCents: inv.amount_paid ?? 0,
    currency: inv.currency ?? 'usd',
    status: inv.status ?? 'draft',
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    invoicePdf: inv.invoice_pdf ?? null,
    issuedAt: inv.created ? new Date(inv.created * 1000) : null,
    dueAt: inv.due_date ? new Date(inv.due_date * 1000) : null,
    paidAt: inv.status_transitions?.paid_at ? new Date(inv.status_transitions.paid_at * 1000) : null,
  };

  await db
    .insert(invoices)
    .values(values)
    .onConflictDoUpdate({ target: invoices.stripeInvoiceId, set: values });

  return client.id;
}
