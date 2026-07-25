import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/index.js';
import { leads } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { sendMail, leadAlertEmail } from '../lib/mail.js';
import { config } from '../config.js';

/**
 * POST /api/leads — the ONLY cross-origin endpoint. Protections:
 * - CORS allowlist (marketing site origins + localhost dev)
 * - rate limit 5/min/IP
 * - honeypot: hidden 'website' field must be empty (bots fill it)
 * - CSRF exempt by design (cross-origin form post; no session to ride)
 */

function corsHeaders(req: FastifyRequest, reply: FastifyReply): void {
  const origin = req.headers.origin;
  if (origin && config.leadOrigins.has(origin)) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
    reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type');
  }
}

const str = (v: unknown, max = 300): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, max);
  return t || null;
};

export async function leadRoutes(app: FastifyInstance): Promise<void> {
  app.options('/api/leads', { config: { skipCsrf: true } }, async (req, reply) => {
    corsHeaders(req, reply);
    return reply.code(204).send();
  });

  app.post(
    '/api/leads',
    {
      config: {
        skipCsrf: true,
        rateLimit: {
          max: 5,
          timeWindow: 60 * 1000,
          keyGenerator: (req: FastifyRequest) => `leads:${req.ip}`,
        },
      },
    },
    async (req, reply) => {
      corsHeaders(req, reply);
      const body = (req.body ?? {}) as Record<string, unknown>;

      // Honeypot: real visitors never see or fill 'website'. Bots do.
      // Respond as if it worked so the bot learns nothing.
      const honeypot = typeof body['website'] === 'string' && body['website'].trim() !== '';
      if (honeypot) {
        req.log.info({ ip: req.ip }, 'lead rejected: honeypot');
        return reply.code(422).send({ ok: false, error: 'Could not submit form.' });
      }

      const email = str(body['email'], 254);
      const name = str(body['name'], 200);
      if (!email && !name) {
        return reply.code(400).send({ ok: false, error: 'Name or email is required.' });
      }

      const [lead] = await db
        .insert(leads)
        .values({
          form: str(body['form'], 50) ?? 'contact',
          name,
          email,
          phone: str(body['phone'], 50),
          company: str(body['company'], 200),
          businessType: str(body['business_type'] ?? body['businessType'], 100),
          revenue: str(body['revenue'], 100),
          message: str(body['message'], 5000),
          ip: req.ip,
        })
        .returning();

      await audit(req, { action: 'lead.created', entity: 'lead', entityId: lead!.id });
      await sendMail({ to: config.FIRM_INBOX, ...leadAlertEmail(lead!) });

      // Browser form posts get sent to the marketing site's thank-you page;
      // fetch() callers can follow the redirect or read the JSON below.
      const accepts = req.headers.accept ?? '';
      if (accepts.includes('application/json')) {
        return reply.send({ ok: true });
      }
      // Lead-magnet signups land on the thank-you page with the download unlocked.
      const suffix = lead!.form === 'lead-magnet' ? '?dl=checklist' : '';
      return reply.redirect(`${config.SITE_URL}/thanks/${suffix}`, 303);
    },
  );
}
