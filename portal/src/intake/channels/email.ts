/**
 * Inbound email — channel #3, and the cheapest one to build
 * (OMNICHANNEL-CAPTURE.md §2: "`receipts+acme@balancebridge.us`. Forward a bill
 * from Gmail — zero new habits").
 *
 * Inbound-parse payload shapes differ per vendor, so this adapter is written
 * against the *union* of the three common ones and picks whichever fields are
 * present:
 *
 *   * Postmark    — JSON: `From`, `Subject`, `TextBody`, `Attachments[]`
 *                   (`Name`, `ContentType`, base64 `Content`)
 *   * Mailgun     — form: `sender`, `subject`, `body-plain`, `attachment-N`
 *   * SendGrid    — form: `from`, `subject`, `text`, `attachments` + `attachment-info`
 *
 * Providers authenticate inbound hooks very differently and several offer only
 * a URL secret. We require a shared secret header (constant-time compared),
 * which every provider can send, rather than pretending to verify a signature
 * we may not have.
 */

import { config } from '../../config.js';
import { intakeConfig } from '../config.js';
import { normalizeEmail } from '../identity.js';
import { sendMail } from '../../lib/mail.js';
import { safeEqual } from '../../auth/tokens.js';
import {
  ChannelNotConfiguredError,
  header,
  parseForm,
  parseJson,
  type ChannelAdapter,
  type InboundAttachment,
  type InboundMessage,
  type SendResult,
  type WebhookRequest,
} from './types.js';

/** Attachments bigger than the upload cap are dropped, not truncated. */
const MAX_ATTACHMENTS = 10;

interface PostmarkAttachment {
  Name?: string;
  ContentType?: string;
  Content?: string;
  ContentLength?: number;
}

interface PostmarkInbound {
  MessageID?: string;
  From?: string;
  FromFull?: { Email?: string; Name?: string };
  Subject?: string;
  TextBody?: string;
  HtmlBody?: string;
  To?: string;
  Attachments?: PostmarkAttachment[];
}

export class EmailAdapter implements ChannelAdapter {
  readonly channel = 'email' as const;
  readonly outboundChannel = 'email' as const;

  /** Outbound email rides the portal's existing SMTP transport. */
  get configured(): boolean {
    return Boolean(config.SMTP_HOST);
  }

  /** Shared secret on the inbound-parse hook, constant-time compared. */
  verifySignature(req: WebhookRequest): boolean {
    const secret = intakeConfig.email.inboundSecret;
    if (!secret) return false;
    const presented = header(req, 'x-intake-secret');
    return Boolean(presented) && safeEqual(presented, secret);
  }

  parseWebhook(req: WebhookRequest): InboundMessage | null {
    const contentType = header(req, 'content-type');
    return contentType.includes('application/json')
      ? this.parseJsonPayload(req)
      : this.parseFormPayload(req);
  }

  private parseJsonPayload(req: WebhookRequest): InboundMessage | null {
    const p = parseJson<PostmarkInbound>(req.rawBody);
    if (!p) return null;
    const from = p.FromFull?.Email ?? p.From ?? '';
    if (!from) return null;

    const attachments: InboundAttachment[] = [];
    for (const a of (p.Attachments ?? []).slice(0, MAX_ATTACHMENTS)) {
      if (!a.Content) continue;
      const buffer = Buffer.from(a.Content, 'base64');
      if (buffer.length === 0 || buffer.length > config.upload.maxBytes) continue;
      attachments.push({
        filename: sanitizeFilename(a.Name ?? 'attachment'),
        mime: a.ContentType ?? 'application/octet-stream',
        buffer,
      });
    }

    const text = p.TextBody?.trim() || stripHtml(p.HtmlBody ?? '');

    return {
      channel: this.channel,
      externalId: p.MessageID ?? null,
      senderIdentity: normalizeEmail(from),
      receivedAt: new Date(),
      subject: p.Subject?.trim() || null,
      text: text || null,
      attachments,
      raw: redactBodies(p),
    };
  }

  private parseFormPayload(req: WebhookRequest): InboundMessage | null {
    const f = parseForm(req.rawBody);
    const from = f['sender'] ?? f['from'] ?? f['From'] ?? '';
    if (!from) return null;

    const subject = (f['subject'] ?? f['Subject'] ?? '').trim();
    const text = (f['body-plain'] ?? f['text'] ?? f['stripped-text'] ?? '').trim();

    // Mailgun/SendGrid urlencoded hooks carry attachment *metadata* here; the
    // bytes arrive as multipart parts we do not accept on this endpoint. Rather
    // than half-parse them, record them on the raw payload so a human can see
    // exactly what was dropped.
    const attachmentInfo = f['attachment-info'] ?? f['attachments'] ?? null;

    return {
      channel: this.channel,
      externalId: f['Message-Id'] ?? f['message-id'] ?? f['message_id'] ?? null,
      senderIdentity: normalizeEmail(from),
      receivedAt: new Date(),
      subject: subject || null,
      text: text || null,
      attachments: [],
      raw: { ...f, 'body-html': undefined, attachmentInfo },
    };
  }

  async send(to: string, body: string): Promise<SendResult> {
    if (!this.configured) {
      throw new ChannelNotConfiguredError(this.channel, 'SMTP_HOST');
    }
    await sendMail({ to, subject: 'Balance Bridge — we got it', text: body });
    return { externalId: null };
  }
}

/** `receipts+acme@balancebridge.us` → `acme`. The routing hint, not an identity. */
export function mailboxTag(address: string | null | undefined): string | null {
  const addr = normalizeEmail(address ?? '');
  const m = /^[^+@]+\+([^@]+)@/.exec(addr);
  return m?.[1] ?? null;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\\r\n\0]/g, '_').slice(0, 200) || 'attachment';
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Keep provenance without storing a second copy of every attachment blob. */
function redactBodies(p: PostmarkInbound): unknown {
  return {
    ...p,
    HtmlBody: undefined,
    Attachments: (p.Attachments ?? []).map((a) => ({
      Name: a.Name,
      ContentType: a.ContentType,
      ContentLength: a.ContentLength ?? (a.Content ? Buffer.from(a.Content, 'base64').length : 0),
    })),
  };
}

export const emailAdapter = new EmailAdapter();
