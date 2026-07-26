/**
 * WhatsApp via the Meta Cloud API — channel #5
 * (OMNICHANNEL-CAPTURE.md §2: "significant among TX small-business owners,
 * especially El Paso, San Antonio, Houston").
 *
 * Two Meta-specific facts shape this adapter:
 *
 *   1. **Webhooks are batched.** One POST carries
 *      `entry[].changes[].value.messages[]`. We take the first message and
 *      report the rest through `additionalMessages` on the raw payload — the
 *      route re-enters the pipeline per message, so idempotency does the work.
 *   2. **Media is never inlined.** A message carries a media *id*; resolving it
 *      is a GET for a short-lived URL and then a second, authenticated GET.
 *      Both happen in `hydrate()`.
 */

import crypto from 'node:crypto';
import { intakeConfig } from '../config.js';
import { normalizePhone } from '../identity.js';
import {
  ChannelNotConfiguredError,
  filenameForMime,
  header,
  parseJson,
  type ChannelAdapter,
  type InboundAttachment,
  type InboundMessage,
  type MediaRef,
  type SendResult,
  type WebhookRequest,
} from './types.js';

interface MetaMedia {
  id?: string;
  mime_type?: string;
  filename?: string;
  caption?: string;
}

interface MetaMessage {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: MetaMedia;
  document?: MetaMedia;
  audio?: MetaMedia;
  video?: MetaMedia;
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
}

interface MetaWebhook {
  object?: string;
  entry?: {
    id?: string;
    changes?: { field?: string; value?: { messages?: MetaMessage[]; statuses?: unknown[] } }[];
  }[];
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel = 'whatsapp' as const;
  readonly outboundChannel = 'whatsapp' as const;

  get configured(): boolean {
    return intakeConfig.whatsapp.configured;
  }

  /** `X-Hub-Signature-256: sha256=<hmac>` over the exact request bytes. */
  verifySignature(req: WebhookRequest): boolean {
    const secret = intakeConfig.whatsapp.appSecret;
    if (!secret) return false;
    const presented = header(req, 'x-hub-signature-256');
    if (!presented.startsWith('sha256=')) return false;
    const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    const a = Buffer.from(presented.slice('sha256='.length), 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || a.length === 0) {
      crypto.timingSafeEqual(b, b);
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  }

  /** The GET handshake Meta performs when a webhook URL is first saved. */
  verifyChallenge(req: WebhookRequest): string | null {
    const q = req.query ?? {};
    const token = intakeConfig.whatsapp.verifyToken;
    if (!token) return null;
    if (q['hub.mode'] !== 'subscribe') return null;
    const presented = q['hub.verify_token'] ?? '';
    const a = Buffer.from(presented);
    const b = Buffer.from(token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return q['hub.challenge'] ?? '';
  }

  parseWebhook(req: WebhookRequest): InboundMessage | null {
    const payload = parseJson<MetaWebhook>(req.rawBody);
    if (!payload) return null;

    const messages: MetaMessage[] = [];
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const m of change.value?.messages ?? []) messages.push(m);
      }
    }
    const first = messages[0];
    // Delivery/read receipts carry `statuses` and no `messages` — nothing to do.
    if (!first?.from) return null;

    const media = first.image ?? first.document ?? first.audio ?? first.video;
    const mediaRefs: MediaRef[] = media?.id
      ? [
          {
            url: '', // resolved from the id in hydrate()
            id: media.id,
            mime: media.mime_type ?? null,
            filename: media.filename ?? filenameForMime(media.mime_type ?? '', 'whatsapp'),
          },
        ]
      : [];

    const text =
      first.text?.body ??
      media?.caption ??
      first.button?.text ??
      first.interactive?.button_reply?.title ??
      first.interactive?.list_reply?.title ??
      null;

    const ts = Number.parseInt(first.timestamp ?? '', 10);

    return {
      channel: this.channel,
      externalId: first.id ?? null,
      senderIdentity: normalizePhone(first.from),
      receivedAt: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date(),
      text: text?.trim() || null,
      attachments: [],
      mediaRefs,
      // Keep every message in the batch on the item's provenance record, and
      // let the route re-enter the pipeline for the tail.
      raw: { message: first, additionalMessages: messages.slice(1), envelope: payload },
    };
  }

  /** Meta media: id → short-lived URL → authenticated download. */
  async hydrate(msg: InboundMessage): Promise<InboundMessage> {
    if (!msg.mediaRefs?.length || !this.configured) return msg;
    const { accessToken, apiBaseUrl } = intakeConfig.whatsapp;
    const auth = { Authorization: `Bearer ${accessToken}` };

    const fetched: InboundAttachment[] = [];
    for (const ref of msg.mediaRefs) {
      let url = ref.url;
      if (!url && ref.id) {
        const meta = await fetch(`${apiBaseUrl}/${encodeURIComponent(ref.id)}`, { headers: auth });
        if (!meta.ok) continue;
        url = ((await meta.json()) as { url?: string }).url ?? '';
      }
      if (!url) continue;
      const res = await fetch(url, { headers: auth });
      if (!res.ok) continue;
      const mime = ref.mime || res.headers.get('content-type') || 'application/octet-stream';
      fetched.push({
        filename: ref.filename ?? filenameForMime(mime, 'whatsapp'),
        mime,
        buffer: Buffer.from(await res.arrayBuffer()),
      });
    }
    return { ...msg, attachments: [...msg.attachments, ...fetched], mediaRefs: [] };
  }

  async send(to: string, body: string): Promise<SendResult> {
    if (!this.configured) {
      throw new ChannelNotConfiguredError(
        this.channel,
        'WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN',
      );
    }
    const { phoneNumberId, accessToken, apiBaseUrl } = intakeConfig.whatsapp;
    const res = await fetch(`${apiBaseUrl}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to.replace(/^\+/, ''),
        type: 'text',
        text: { preview_url: false, body },
      }),
    });
    if (!res.ok) {
      throw new Error(`WhatsApp send failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as { messages?: { id?: string }[] };
    return { externalId: json.messages?.[0]?.id ?? null };
  }
}

export const whatsappAdapter = new WhatsAppAdapter();
