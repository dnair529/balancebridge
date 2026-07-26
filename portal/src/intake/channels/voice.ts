/**
 * Voice note — channel #9 (OMNICHANNEL-CAPTURE.md §2).
 *
 * > Call a number, leave context: "that $4,300 was Johnson job materials."
 * > Transcribed, attached to the transaction. Genuinely differentiating for
 * > drivers.
 *
 * Twilio posts twice for one call: the recording callback (`RecordingUrl`,
 * `RecordingSid`) and, later, the transcription callback (`TranscriptionText`,
 * `TranscriptionStatus`). Both are handled here and both key on the same
 * `CallSid`, so the pair collapses to one intake item — the transcription
 * arrives as an update to the item the recording created, not a second one.
 *
 * The recording *audio* is the immutable original; the transcript is text the
 * pipeline can extract from and match against. A voice note usually answers an
 * open question rather than carrying a document, which is why the pipeline
 * routes text-only voice items into `inboundReply.ts` first.
 */

import { intakeConfig } from '../config.js';
import { normalizePhone } from '../identity.js';
import {
  ChannelNotConfiguredError,
  filenameForMime,
  header,
  parseForm,
  type ChannelAdapter,
  type InboundAttachment,
  type InboundMessage,
  type MediaRef,
  type SendResult,
  type WebhookRequest,
} from './types.js';
import { absoluteUrl, timingSafeEqualB64, twilioSignature } from './sms.js';

export class VoiceAdapter implements ChannelAdapter {
  readonly channel = 'voice' as const;
  /** A voice note is answered by text — the caller is driving. */
  readonly outboundChannel = 'sms' as const;

  get configured(): boolean {
    return intakeConfig.twilio.configured;
  }

  /** Same Twilio request-validation scheme as SMS. */
  verifySignature(req: WebhookRequest): boolean {
    const token = intakeConfig.twilio.authToken;
    if (!token) return false;
    const presented = header(req, 'x-twilio-signature');
    if (!presented) return false;
    const form = header(req, 'content-type').includes('application/x-www-form-urlencoded')
      ? parseForm(req.rawBody)
      : {};
    return timingSafeEqualB64(presented, twilioSignature(token, absoluteUrl(req.url), form));
  }

  parseWebhook(req: WebhookRequest): InboundMessage | null {
    const f = header(req, 'content-type').includes('application/x-www-form-urlencoded')
      ? parseForm(req.rawBody)
      : {};
    const from = f['From'] ?? f['Caller'] ?? '';
    if (!from) return null;

    const transcript = (f['TranscriptionText'] ?? '').trim();
    const recordingUrl = f['RecordingUrl'] ?? '';
    // Nothing usable yet (e.g. an in-progress status callback).
    if (!transcript && !recordingUrl) return null;

    const mediaRefs: MediaRef[] = recordingUrl
      ? [
          {
            // Twilio serves the recording media by extension.
            url: recordingUrl.endsWith('.mp3') ? recordingUrl : `${recordingUrl}.mp3`,
            mime: 'audio/mpeg',
            filename: filenameForMime('audio/mpeg', 'voice-note'),
            id: f['RecordingSid'] ?? null,
          },
        ]
      : [];

    return {
      channel: this.channel,
      // Key on the call, not the callback: recording and transcription for the
      // same call must collapse to one intake item.
      externalId: f['CallSid'] ?? f['RecordingSid'] ?? null,
      senderIdentity: normalizePhone(from),
      receivedAt: new Date(),
      text: transcript || null,
      attachments: [],
      mediaRefs,
      raw: f,
    };
  }

  /** Download the recording so the original audio is retained, encrypted. */
  async hydrate(msg: InboundMessage): Promise<InboundMessage> {
    if (!msg.mediaRefs?.length || !this.configured) return msg;
    const auth = Buffer.from(
      `${intakeConfig.twilio.accountSid}:${intakeConfig.twilio.authToken}`,
    ).toString('base64');

    const fetched: InboundAttachment[] = [];
    for (const ref of msg.mediaRefs) {
      const res = await fetch(ref.url, { headers: { Authorization: `Basic ${auth}` } });
      if (!res.ok) continue;
      fetched.push({
        filename: ref.filename ?? 'voice-note.mp3',
        mime: ref.mime ?? 'audio/mpeg',
        buffer: Buffer.from(await res.arrayBuffer()),
      });
    }
    return { ...msg, attachments: [...msg.attachments, ...fetched], mediaRefs: [] };
  }

  /**
   * We do not call people back with a robot. A voice note is answered by SMS,
   * so the confirmation loop is told to use the SMS adapter instead.
   */
  async send(_to: string, _body: string): Promise<SendResult> {
    throw new ChannelNotConfiguredError(
      this.channel,
      'voice notes are answered over SMS — see outboundChannel',
    );
  }
}

/** MP3 audio with no transcript is nothing the extractor can read yet. */
export function hasUsableTranscript(msg: InboundMessage): boolean {
  return Boolean(msg.text && msg.text.trim().length > 0);
}

export const voiceAdapter = new VoiceAdapter();
