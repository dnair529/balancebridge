/**
 * Portal drag-and-drop — channel #6, already live, now rewired
 * (OMNICHANNEL-CAPTURE.md §4: "Existing portal uploads become just another
 * channel — backfill them as `channel='portal'` so there is exactly one code
 * path").
 *
 * This adapter does not replace `POST /documents/upload`; that route keeps
 * working exactly as it does today. It wraps it: `fromPortalUpload()` builds
 * the normalised message for a file that has *already* been accepted by the
 * portal, so the same dedupe → extract → classify → match → file hallway runs
 * over it. A year-end dump of 300 receipts gets the same treatment as one text
 * message, and neither has a second implementation to keep in sync.
 */

import {
  ChannelNotConfiguredError,
  parseJson,
  type ChannelAdapter,
  type InboundAttachment,
  type InboundMessage,
  type SendResult,
  type WebhookRequest,
} from './types.js';

export interface PortalUploadRef {
  /** The uploading user's id — the sender identity for this channel. */
  userId: string;
  /** `documents.id` when the row already exists (the live upload route). */
  documentId?: string | null;
  filename: string;
  mime: string;
  /** sha256 of the plaintext, as recorded by `lib/storage`. */
  sha256: string;
  sizeBytes: number;
  /** `documents.stored_name` — the encrypted object key. */
  storedName: string;
  folder?: string | null;
  uploadedAt?: Date | null;
}

export class PortalAdapter implements ChannelAdapter {
  readonly channel = 'portal' as const;
  readonly outboundChannel = 'portal' as const;

  readonly configured = true;

  parseWebhook(req: WebhookRequest): InboundMessage | null {
    const p = parseJson<PortalUploadRef>(req.rawBody);
    if (!p?.userId || !p.storedName) return null;
    return this.fromPortalUpload(p);
  }

  /**
   * Normalise an accepted portal upload. Note there are no `attachments`: the
   * bytes are already stored and encrypted, so the pipeline is told to reuse
   * the existing object rather than write a second copy of the same file.
   */
  fromPortalUpload(ref: PortalUploadRef, attachments: InboundAttachment[] = []): InboundMessage {
    return {
      channel: this.channel,
      // Stable per stored object, so re-running a backfill is a no-op.
      externalId: ref.documentId ? `document:${ref.documentId}` : `stored:${ref.storedName}`,
      senderIdentity: ref.userId,
      receivedAt: ref.uploadedAt ?? new Date(),
      text: null,
      attachments,
      raw: {
        documentId: ref.documentId ?? null,
        filename: ref.filename,
        mime: ref.mime,
        sha256: ref.sha256,
        sizeBytes: ref.sizeBytes,
        storedName: ref.storedName,
        folder: ref.folder ?? null,
      },
    };
  }

  async send(_to: string, _body: string): Promise<SendResult> {
    throw new ChannelNotConfiguredError(
      this.channel,
      'portal confirmations are read from outbound_messages in the portal UI, not pushed',
    );
  }
}

export const portalAdapter = new PortalAdapter();
