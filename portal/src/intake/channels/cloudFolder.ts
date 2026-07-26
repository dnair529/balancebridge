/**
 * Watched cloud folder — channel #8 (OMNICHANNEL-CAPTURE.md §2: Google Drive /
 * Dropbox "for clients who already scan. Meets existing behavior").
 *
 * STUB. The adapter contract is satisfied end to end — it parses a
 * change-notification payload into an `InboundMessage`, and `send()` throws the
 * typed `ChannelNotConfiguredError` the confirmation loop expects — so the
 * channel can be registered, exercised and rate-limited today without pulling
 * in an OAuth dependency. Nothing about the pipeline changes when it lands.
 *
 * TODO(cloud-folder), in this order:
 *   1. OAuth: per-client Drive/Dropbox grant, refresh tokens sealed with
 *      `lib/crypto` (never in the database as plaintext), stored against
 *      `integrations` with `provider` extended to include the vendor.
 *   2. Change notifications: Drive `files.watch` channels expire (max 7 days)
 *      and must be renewed on a schedule; Dropbox `/files/list_folder/continue`
 *      cursors persist per folder. Both need a durable cursor store.
 *   3. `verifySignature`: Drive sends `X-Goog-Channel-Token` (a shared secret
 *      we mint per channel); Dropbox signs with `X-Dropbox-Signature`
 *      (HMAC-SHA256 over the raw body with the app secret).
 *   4. `hydrate()`: download the file bytes; a change notification carries only
 *      an id, exactly like WhatsApp media.
 *   5. Identity: `channel_identities.identity` = the folder id, so a folder
 *      resolves to a client the same explicit way a phone number does.
 */

import {
  ChannelNotConfiguredError,
  parseJson,
  type ChannelAdapter,
  type InboundMessage,
  type MediaRef,
  type SendResult,
  type WebhookRequest,
} from './types.js';
import { intakeConfig } from '../config.js';

interface FolderChangeNotification {
  /** The watched folder — this is the identity that resolves to a client. */
  folderId?: string;
  fileId?: string;
  name?: string;
  mimeType?: string;
  /** Present on providers that hand back a direct (short-lived) download URL. */
  downloadUrl?: string;
  modifiedTime?: string;
}

export class CloudFolderAdapter implements ChannelAdapter {
  readonly channel = 'cloud_folder' as const;
  readonly outboundChannel = 'portal' as const;

  /** Always false until step 1 of the TODO above lands. */
  get configured(): boolean {
    return intakeConfig.cloudFolder.configured;
  }

  parseWebhook(req: WebhookRequest): InboundMessage | null {
    const p = parseJson<FolderChangeNotification>(req.rawBody);
    if (!p?.folderId || !p.fileId) return null;

    const mediaRefs: MediaRef[] = [
      {
        url: p.downloadUrl ?? '',
        id: p.fileId,
        mime: p.mimeType ?? null,
        filename: p.name ?? null,
      },
    ];
    const modified = p.modifiedTime ? new Date(p.modifiedTime) : null;

    return {
      channel: this.channel,
      // File id + revision-free: a re-notification for the same file dedupes.
      externalId: p.fileId,
      senderIdentity: p.folderId,
      receivedAt: modified && !Number.isNaN(modified.getTime()) ? modified : new Date(),
      text: null,
      attachments: [],
      mediaRefs,
      raw: p,
    };
  }

  /** TODO(cloud-folder): authenticated download of `mediaRefs[].id`. */
  async hydrate(msg: InboundMessage): Promise<InboundMessage> {
    return msg;
  }

  async send(_to: string, _body: string): Promise<SendResult> {
    throw new ChannelNotConfiguredError(
      this.channel,
      'CLOUD_FOLDER_PROVIDER — Drive/Dropbox OAuth is not built yet',
    );
  }
}

export const cloudFolderAdapter = new CloudFolderAdapter();
