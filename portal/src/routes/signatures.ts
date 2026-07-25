import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { signatureRequests } from '../db/schema.js';
import { requireAuth, resolveClientId, isStaff } from '../auth/guards.js';
import { audit } from '../lib/audit.js';
import { docusealConfigured, getSignerSlug } from '../lib/docuseal.js';
import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyReply {
    /** Set by the signature-view route; widens CSP frame-src to DOCUSEAL_URL. */
    allowDocusealFrame?: boolean;
  }
}

export async function signatureRoutes(app: FastifyInstance): Promise<void> {
  app.get('/signatures', { preHandler: requireAuth }, async (req, reply) => {
    const clientId = resolveClientId(req);
    if (!clientId) return reply.redirect(isStaff(req) ? '/admin' : '/login', 303);

    const rows = await db.query.signatureRequests.findMany({
      where: eq(signatureRequests.clientId, clientId),
      orderBy: desc(signatureRequests.createdAt),
    });

    return reply.viewPage('signatures.eta', { title: 'Signatures', sigRows: rows, clientId });
  });

  /** DocuSeal iframe embed. CSP frame-src is widened for THIS route only. */
  app.get<{ Params: { id: string } }>(
    '/signatures/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const clientId = resolveClientId(req);
      if (!clientId) return reply.redirect('/admin', 303);

      const sig = await db.query.signatureRequests.findFirst({
        where: and(eq(signatureRequests.id, req.params.id), eq(signatureRequests.clientId, clientId)),
      });
      if (!sig) {
        return reply.code(404).viewPage('error.eta', { title: 'Not found', message: 'That signature request doesn’t exist.' });
      }

      let embedUrl: string | null = null;
      if (sig.status === 'pending' && sig.docusealSubmissionId && docusealConfigured()) {
        try {
          const slug = await getSignerSlug(sig.docusealSubmissionId, sig.signerEmail);
          if (slug) embedUrl = `${config.DOCUSEAL_URL}/s/${slug}`;
        } catch (err) {
          req.log.error({ err }, 'DocuSeal slug lookup failed');
        }
      }

      await audit(req, { action: 'signature.view', clientId, entity: 'signature_request', entityId: sig.id });

      // Flag consumed by the security-headers hook to allow the DocuSeal frame.
      reply.allowDocusealFrame = true;
      return reply.viewPage('signature-view.eta', { title: sig.title, sig, embedUrl, clientId });
    },
  );
}
