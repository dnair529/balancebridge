/**
 * Mobile PWA camera — channel #2 (OMNICHANNEL-CAPTURE.md §2).
 *
 * The highest-fidelity capture path: installable, auto-crop, multi-page, and
 * an **offline queue** for job sites with no signal. The offline queue is why
 * this adapter looks different from the others — a phone that has been out of
 * signal for six hours replays its whole queue at once, so:
 *
 *   * the client generates a stable `captureId` per photo and sends it as the
 *     external id, making a replay idempotent at the door, and
 *   * `capturedAt` (when the photo was taken) is preserved as `receivedAt`
 *     rather than being overwritten with the sync time — the expense happened
 *     on the job, not in the parking lot with LTE.
 *
 * There is no signature: this endpoint is behind the portal session, so the
 * sender is the authenticated user and the route passes their client's
 * identity in directly. `parseWebhook` therefore reads an already-assembled
 * JSON envelope rather than a provider payload.
 */

import { config } from '../../config.js';
import {
  ChannelNotConfiguredError,
  filenameForMime,
  parseJson,
  type ChannelAdapter,
  type InboundAttachment,
  type InboundMessage,
  type SendResult,
  type WebhookRequest,
} from './types.js';

export interface PwaCaptureEnvelope {
  /** The authenticated client's own identity — set server-side, never trusted from the body. */
  senderIdentity: string;
  captureId?: string | null;
  capturedAt?: string | null;
  note?: string | null;
  files?: { filename?: string; mime?: string; base64?: string }[];
}

export class PwaAdapter implements ChannelAdapter {
  readonly channel = 'pwa' as const;
  /** Replies land in the portal's own message surface, not out over a carrier. */
  readonly outboundChannel = 'portal' as const;

  /** Always available: it is the portal itself. */
  readonly configured = true;

  parseWebhook(req: WebhookRequest): InboundMessage | null {
    const p = parseJson<PwaCaptureEnvelope>(req.rawBody);
    if (!p?.senderIdentity) return null;
    return this.fromEnvelope(p);
  }

  /** Used directly by the multipart upload route, which streams its own files. */
  fromEnvelope(p: PwaCaptureEnvelope, attachments: InboundAttachment[] = []): InboundMessage {
    const files: InboundAttachment[] = [...attachments];
    for (const f of p.files ?? []) {
      if (!f.base64) continue;
      const buffer = Buffer.from(f.base64, 'base64');
      if (buffer.length === 0 || buffer.length > config.upload.maxBytes) continue;
      const mime = f.mime ?? 'image/jpeg';
      files.push({ filename: f.filename ?? filenameForMime(mime, 'capture'), mime, buffer });
    }

    const captured = p.capturedAt ? new Date(p.capturedAt) : null;
    return {
      channel: this.channel,
      externalId: p.captureId ?? null,
      senderIdentity: p.senderIdentity,
      // Offline queue: the capture time is the truth, the sync time is noise.
      receivedAt: captured && !Number.isNaN(captured.getTime()) ? captured : new Date(),
      text: p.note?.trim() || null,
      attachments: files,
      raw: {
        captureId: p.captureId ?? null,
        capturedAt: p.capturedAt ?? null,
        note: p.note ?? null,
        files: files.map((f) => ({ filename: f.filename, mime: f.mime, bytes: f.buffer.length })),
      },
    };
  }

  /**
   * Confirmations for a PWA capture surface in-app. There is nothing to POST
   * to a carrier, so this throws the same typed error an unconfigured channel
   * would: the `outbound_messages` row stays queued and the PWA reads it.
   */
  async send(_to: string, _body: string): Promise<SendResult> {
    throw new ChannelNotConfiguredError(
      this.channel,
      'PWA confirmations are delivered in-app from outbound_messages, not pushed',
    );
  }
}

export const pwaAdapter = new PwaAdapter();
