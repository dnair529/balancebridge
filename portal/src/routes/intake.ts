/**
 * Omnichannel intake endpoints.
 *
 * Two very different trust models live in this file, so they live in two
 * different Fastify scopes:
 *
 *   * `/webhooks/*` — public, unauthenticated, CSRF-exempt, and therefore
 *     **signature-verified without exception**. Registered in a child scope
 *     with a raw-body parser, because an HMAC over "the body as our framework
 *     re-serialised it" is not an HMAC over the body. Same pattern as
 *     `routes/webhooks.ts`.
 *   * `/api/*` — session-authenticated, CSRF-protected, and inheriting the
 *     app's normal parsers (multipart included).
 *
 * Every route is rate-limited. A webhook endpoint that accepts client
 * financial documents and is reachable from the internet gets a limit whether
 * or not the provider is well-behaved.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { channelIdentities, clients, intakeItems } from '../db/schema.js';
import { requireAuth, requireStaff, resolveClientId } from '../auth/guards.js';
import { verifyCsrfValue } from '../lib/csrf.js';
import { audit } from '../lib/audit.js';
import { isAllowedExtension, FileTooLargeError } from '../lib/storage.js';
import { config } from '../config.js';
import { ingest, routeInbound } from '../intake/pipeline.js';
import { linkIdentity } from '../intake/identity.js';
import { adapterFor } from '../intake/channels/index.js';
import type { Channel, InboundAttachment, WebhookRequest } from '../intake/channels/types.js';
import { consentKeyword } from '../intake/channels/sms.js';
import { whatsappAdapter } from '../intake/channels/whatsapp.js';
import { pwaAdapter } from '../intake/channels/pwa.js';

/** Webhook limit: generous for a legitimate provider, useless for a flood. */
const webhookRateLimit = (name: string) => ({
  skipCsrf: true,
  rateLimit: {
    max: 120,
    timeWindow: 60 * 1000,
    keyGenerator: (req: FastifyRequest) => `intake:${name}:${req.ip}`,
  },
});

const uploadRateLimit = {
  skipCsrf: true,
  rateLimit: {
    max: 60,
    timeWindow: 60 * 1000,
    keyGenerator: (req: FastifyRequest) => `intake:pwa:${req.authContext?.user.id ?? req.ip}`,
  },
};

const staffRateLimit = {
  rateLimit: {
    max: 120,
    timeWindow: 60 * 1000,
    keyGenerator: (req: FastifyRequest) => `intake:staff:${req.authContext?.user.id ?? req.ip}`,
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function intakeRoutes(app: FastifyInstance): Promise<void> {
  /* ====================================================================== */
  /* Public webhooks — raw body, signature verified, CSRF exempt            */
  /* ====================================================================== */
  await app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, payload, done) => {
      done(null, payload);
    });

    /** Normalise a Fastify request into the adapter's transport-free shape. */
    const toWebhookRequest = (req: FastifyRequest): WebhookRequest => ({
      method: req.method,
      url: req.url,
      headers: req.headers as Record<string, string | string[] | undefined>,
      rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      query: req.query as Record<string, string | undefined>,
    });

    /**
     * One handler for every signed webhook. The differences between providers
     * live in the adapters; the security posture is identical and lives here:
     * verify or reject, parse or 400, then hand to the pipeline.
     */
    const handle = async (
      channel: Channel,
      req: FastifyRequest,
      reply: FastifyReply,
    ): Promise<FastifyReply> => {
      const adapter = adapterFor(channel);
      const wreq = toWebhookRequest(req);

      if (!adapter.verifySignature) {
        // Structurally impossible for the channels routed here; belt and braces.
        req.log.error({ channel }, 'intake webhook has no signature verifier');
        return reply.code(503).send({ error: 'channel not accepting webhooks' });
      }
      if (!adapter.verifySignature(wreq)) {
        req.log.warn({ channel, ip: req.ip }, 'intake webhook signature rejected');
        await audit(req, {
          action: 'intake.webhook_rejected',
          entity: 'intake',
          entityId: channel,
          meta: { reason: 'signature verification failed' },
        });
        return reply.code(401).send({ error: 'invalid signature' });
      }

      const msg = adapter.parseWebhook(wreq);
      if (!msg) {
        // Status callbacks and delivery receipts land here. Acknowledge them.
        return reply.send({ received: true, ingested: false });
      }

      // TCPA STOP/START, handled before anything else touches the message.
      if (channel === 'sms' || channel === 'whatsapp') {
        const keyword = consentKeyword(msg.text);
        if (keyword) {
          await applyConsentKeyword(channel, msg.senderIdentity, keyword, req);
          return reply.send({ received: true, ingested: false, consent: keyword });
        }
      }

      const result = await routeInbound(msg);
      return reply.send({
        received: true,
        ingested: !result.duplicate,
        intakeItemId: result.intakeItemId,
        status: result.status,
      });
    };

    hooks.post('/webhooks/sms', { config: webhookRateLimit('sms') }, (req, reply) =>
      handle('sms', req, reply),
    );

    hooks.post('/webhooks/whatsapp', { config: webhookRateLimit('whatsapp') }, (req, reply) =>
      handle('whatsapp', req, reply),
    );

    /** Meta's GET handshake when the callback URL is first saved. */
    hooks.get('/webhooks/whatsapp', { config: webhookRateLimit('whatsapp-verify') }, async (req, reply) => {
      const challenge = whatsappAdapter.verifyChallenge({
        method: req.method,
        url: req.url,
        headers: req.headers as Record<string, string | string[] | undefined>,
        rawBody: Buffer.alloc(0),
        query: req.query as Record<string, string | undefined>,
      });
      if (challenge === null) return reply.code(403).send({ error: 'verification failed' });
      return reply.type('text/plain').send(challenge);
    });

    hooks.post('/webhooks/email', { config: webhookRateLimit('email') }, (req, reply) =>
      handle('email', req, reply),
    );

    hooks.post('/webhooks/voice', { config: webhookRateLimit('voice') }, (req, reply) =>
      handle('voice', req, reply),
    );
  });

  /* ====================================================================== */
  /* PWA upload — authenticated client, multipart                           */
  /* ====================================================================== */

  /**
   * The offline queue replays here: a phone that has been out of signal all
   * afternoon posts each capture with its own `captureId` and `capturedAt`.
   * `captureId` is the idempotency key, so a replay that already landed is a
   * no-op that still returns 200 — a client that retries must never be
   * punished with a duplicate document.
   */
  app.post(
    '/api/pwa/upload',
    { preHandler: requireAuth, config: uploadRateLimit },
    async (req, reply) => {
      const clientId = resolveClientId(req);
      if (!clientId) {
        return reply.code(400).send({ ok: false, error: 'no client in scope' });
      }

      let csrfValue: string | null = null;
      let captureId: string | null = null;
      let capturedAt: string | null = null;
      let note: string | null = null;
      const files: InboundAttachment[] = [];

      try {
        for await (const part of req.parts()) {
          if (part.type === 'field') {
            const value = String(part.value).slice(0, 2000);
            if (part.fieldname === '_csrf') csrfValue = value;
            if (part.fieldname === 'captureId') captureId = value.slice(0, 200);
            if (part.fieldname === 'capturedAt') capturedAt = value.slice(0, 40);
            if (part.fieldname === 'note') note = value;
          } else if (part.type === 'file') {
            const filename = part.filename ?? 'capture.jpg';
            if (!isAllowedExtension(filename)) {
              part.file.resume();
              return reply.code(415).send({ ok: false, error: 'unsupported file type' });
            }
            const buffer = await part.toBuffer();
            if (buffer.length > config.upload.maxBytes) throw new FileTooLargeError();
            files.push({
              filename: filename.slice(0, 300),
              mime: (part.mimetype || 'application/octet-stream').slice(0, 200),
              buffer,
            });
          }
        }
      } catch (err) {
        if (err instanceof FileTooLargeError || (err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.code(413).send({ ok: false, error: 'files are limited to 25MB' });
        }
        throw err;
      }

      // Multipart bodies bypass the global CSRF hook, so verify it by hand —
      // after parsing, before anything is written. Same as documents.ts.
      if (!verifyCsrfValue(req, csrfValue)) {
        return reply.code(403).send({ ok: false, error: 'invalid csrf token' });
      }
      if (files.length === 0 && !note) {
        return reply.code(400).send({ ok: false, error: 'nothing to upload' });
      }

      const msg = pwaAdapter.fromEnvelope(
        {
          // Server-side identity: the session's client, never a body field.
          senderIdentity: `client:${clientId}`,
          captureId: captureId ? `${clientId}:${captureId}` : null,
          capturedAt,
          note,
        },
        files,
      );

      // The uploader is already authenticated, so the client is known without
      // a channel_identities lookup — this door does not quarantine.
      const result = await routeInbound(msg, { clientId });

      await audit(req, {
        action: 'intake.pwa_upload',
        clientId,
        entity: 'intake_item',
        entityId: result.intakeItemId,
        meta: { duplicate: result.duplicate, status: result.status, files: files.length },
      });

      return reply.send({
        ok: true,
        duplicate: result.duplicate,
        intakeItemId: result.intakeItemId,
        status: result.status,
        documentId: result.documentId,
      });
    },
  );

  /* ====================================================================== */
  /* Quarantine — staff only                                                */
  /* ====================================================================== */

  /**
   * Everything that arrived from a sender we could not name. This queue
   * existing is the point: an unrecognised sender is never guessed onto a
   * client (OMNICHANNEL-CAPTURE.md §5).
   */
  app.get('/api/intake/quarantine', { preHandler: requireStaff, config: staffRateLimit }, async (req, reply) => {
    const rows = await db.query.intakeItems.findMany({
      where: and(eq(intakeItems.status, 'quarantined'), isNull(intakeItems.clientId)),
      orderBy: [desc(intakeItems.receivedAt)],
      limit: 200,
    });

    return reply.send({
      ok: true,
      count: rows.length,
      items: rows.map((r) => ({
        id: r.id,
        channel: r.channel,
        senderIdentity: r.senderIdentity,
        receivedAt: r.receivedAt,
        mime: r.mime,
        externalId: r.externalId,
        quarantineReason: r.quarantineReason,
        // The raw payload can carry the message body; staff need it to work out
        // who this is, and they already have access to every client's data.
        preview: previewOf(r.rawPayload),
      })),
    });
  });

  /**
   * Claim a quarantined item for a client. Optionally — and this is the part
   * that stops the queue from refilling with the same number every week —
   * remember the sender against that client so the next message resolves on
   * its own.
   */
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/intake/:id/assign',
    { preHandler: requireStaff, config: staffRateLimit },
    async (req, reply) => {
      const id = req.params.id;
      if (!UUID_RE.test(id)) return reply.code(400).send({ ok: false, error: 'bad id' });

      const body = req.body ?? {};
      const clientId = typeof body['clientId'] === 'string' ? body['clientId'] : '';
      if (!UUID_RE.test(clientId)) {
        return reply.code(400).send({ ok: false, error: 'clientId is required' });
      }

      const item = await db.query.intakeItems.findFirst({ where: eq(intakeItems.id, id) });
      if (!item) return reply.code(404).send({ ok: false, error: 'not found' });
      if (item.status !== 'quarantined') {
        return reply.code(409).send({ ok: false, error: `item is ${item.status}, not quarantined` });
      }

      const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
      if (!client) return reply.code(404).send({ ok: false, error: 'client not found' });

      // Attaching the identity is opt-in: a one-off forward from an accountant
      // should not permanently bind that address to the client.
      const remember = body['rememberIdentity'] === true || body['rememberIdentity'] === 'true';
      if (remember && item.senderIdentity) {
        await linkIdentity({
          clientId,
          channel: item.channel,
          identity: item.senderIdentity,
          label: typeof body['label'] === 'string' ? body['label'].slice(0, 200) : null,
          verified: true,
        });
      }

      await db
        .update(intakeItems)
        .set({
          clientId,
          status: 'received',
          quarantineReason: null,
        })
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
          assignedBy: req.authContext!.user.id,
        },
      });

      // Re-run the hallway now the sender is known. The raw payload is the
      // original; nothing was mutated, so this is a genuine replay.
      const replayed = await replayFromPayload(item.id, clientId, item.channel);

      return reply.send({
        ok: true,
        intakeItemId: item.id,
        clientId,
        rememberedIdentity: remember,
        replayed,
      });
    },
  );
}

/* -------------------------------------------------------------------------- */

/** STOP/START on a phone identity — TCPA, honoured immediately. */
async function applyConsentKeyword(
  channel: Channel,
  identity: string,
  keyword: 'stop' | 'start',
  req: FastifyRequest,
): Promise<void> {
  const rows = await db.query.channelIdentities.findMany({
    where: and(eq(channelIdentities.channel, channel), eq(channelIdentities.identity, identity)),
  });
  for (const row of rows) {
    await db
      .update(channelIdentities)
      .set(
        keyword === 'stop'
          ? { consentAt: null, revokedAt: new Date() }
          : { consentAt: new Date(), revokedAt: null },
      )
      .where(eq(channelIdentities.id, row.id));
    await audit(req, {
      action: keyword === 'stop' ? 'intake.consent_revoked' : 'intake.consent_granted',
      clientId: row.clientId,
      entity: 'channel_identity',
      entityId: row.id,
      meta: { channel, keyword },
    });
  }
}

/**
 * Re-run a claimed quarantine item through the pipeline from its retained raw
 * payload. Best effort by design: some payloads reference remote media that has
 * since expired, and a failure here leaves the item assigned for a human rather
 * than losing it.
 */
async function replayFromPayload(
  itemId: string,
  clientId: string,
  channel: Channel,
): Promise<boolean> {
  const item = await db.query.intakeItems.findFirst({ where: eq(intakeItems.id, itemId) });
  if (!item?.rawPayload) return false;
  const adapter = adapterFor(channel);
  try {
    const msg = adapter.parseWebhook({
      method: 'POST',
      url: `/webhooks/${channel}`,
      headers: { 'content-type': replayContentType(item.rawPayload) },
      rawBody: replayBody(item.rawPayload),
    });
    if (!msg) return false;
    await ingest({ ...msg, externalId: null }, { clientId, suppressConfirmation: true });
    return true;
  } catch {
    return false;
  }
}

/** Form-shaped payloads round-trip as urlencoded; everything else as JSON. */
function replayContentType(raw: unknown): string {
  return isFlatStringRecord(raw) ? 'application/x-www-form-urlencoded' : 'application/json';
}

function replayBody(raw: unknown): Buffer {
  if (isFlatStringRecord(raw)) {
    return Buffer.from(new URLSearchParams(raw).toString(), 'utf8');
  }
  return Buffer.from(JSON.stringify(raw), 'utf8');
}

function isFlatStringRecord(raw: unknown): raw is Record<string, string> {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    !Array.isArray(raw) &&
    Object.values(raw).every((v) => typeof v === 'string')
  );
}

/** A short, human-readable hint of what a quarantined payload contains. */
function previewOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = r['Body'] ?? r['text'] ?? r['TextBody'] ?? r['TranscriptionText'] ?? r['Subject'];
  return typeof text === 'string' ? text.slice(0, 200) : null;
}
