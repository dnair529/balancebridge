import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { db } from '../db/index.js';
import { documents, signatureRequests, users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { stripe, upsertInvoiceFromStripe } from '../lib/stripe.js';
import { fetchSignedPdf } from '../lib/docuseal.js';
import { saveBuffer } from '../lib/storage.js';
import { safeEqual } from '../auth/tokens.js';
import { config } from '../config.js';

/**
 * Webhooks are registered in their own encapsulated plugin so we can install
 * a raw-body content-type parser without affecting the rest of the app
 * (Stripe signature verification needs the exact bytes).
 *
 * Both endpoints are CSRF-exempt: Stripe is verified by signature, DocuSeal
 * by a shared-secret header. Both are idempotent (upserts / state checks).
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, payload, done) => {
    done(null, payload);
  });

  // ---------- Stripe ----------
  app.post('/webhooks/stripe', { config: { skipCsrf: true } }, async (req, reply) => {
    if (!stripe || !config.STRIPE_WEBHOOK_SECRET) {
      return reply.code(503).send({ error: 'stripe not configured' });
    }

    let event: Stripe.Event;
    try {
      // Official-library signature verification (constant-time internally).
      event = stripe.webhooks.constructEvent(
        req.body as Buffer,
        String(req.headers['stripe-signature'] ?? ''),
        config.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      req.log.warn({ err }, 'stripe webhook signature verification failed');
      return reply.code(400).send({ error: 'invalid signature' });
    }

    switch (event.type) {
      case 'invoice.finalized':
      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'invoice.voided': {
        const invoice = event.data.object as Stripe.Invoice;
        const clientId = await upsertInvoiceFromStripe(invoice);
        await audit(req, {
          action: `stripe.${event.type}`,
          clientId,
          entity: 'invoice',
          entityId: invoice.id ?? undefined,
        });
        break;
      }
      default:
        // Acknowledge everything else without acting on it.
        break;
    }
    return reply.send({ received: true });
  });

  // ---------- DocuSeal ----------
  app.post('/webhooks/docuseal', { config: { skipCsrf: true } }, async (req, reply) => {
    if (!config.DOCUSEAL_WEBHOOK_SECRET) {
      return reply.code(503).send({ error: 'docuseal not configured' });
    }
    // Shared-secret header, constant-time comparison.
    const presented = String(req.headers['x-docuseal-secret'] ?? '');
    if (!safeEqual(presented, config.DOCUSEAL_WEBHOOK_SECRET)) {
      req.log.warn('docuseal webhook: bad shared secret');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    let payload: { event_type?: string; data?: { submission_id?: number | string; id?: number | string } };
    try {
      payload = JSON.parse((req.body as Buffer).toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'invalid json' });
    }

    if (payload.event_type === 'form.completed' || payload.event_type === 'submission.completed') {
      const submissionId = String(payload.data?.submission_id ?? payload.data?.id ?? '');
      if (!submissionId) return reply.send({ received: true });

      const sig = await db.query.signatureRequests.findFirst({
        where: eq(signatureRequests.docusealSubmissionId, submissionId),
      });
      // Idempotency: already completed → nothing to do.
      if (!sig || sig.status === 'completed') return reply.send({ received: true });

      await db
        .update(signatureRequests)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(signatureRequests.id, sig.id));

      // Save the signed PDF back into the client's documents (spec: Integrations).
      try {
        const pdf = await fetchSignedPdf(submissionId);
        if (pdf) {
          const stored = await saveBuffer(pdf);
          const uploader =
            (await db.query.users.findFirst({ where: eq(users.id, sig.createdBy) })) ?? null;
          if (uploader) {
            await db.insert(documents).values({
              clientId: sig.clientId,
              uploadedBy: uploader.id,
              folder: 'General',
              filename: `${sig.title} (signed).pdf`,
              storedName: stored.storedName,
              mime: 'application/pdf',
              sizeBytes: stored.sizeBytes,
              sha256: stored.sha256,
            });
          }
        }
      } catch (err) {
        req.log.error({ err }, 'failed to archive signed PDF');
      }

      await audit(req, {
        action: 'signature.completed',
        clientId: sig.clientId,
        entity: 'signature_request',
        entityId: sig.id,
      });
    }

    return reply.send({ received: true });
  });
}
