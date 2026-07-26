/**
 * SMS / MMS via Twilio — channel #1 in the build order, and the reason the
 * whole thing exists: a contractor texts a photo from the truck, no app, no
 * login, no password (OMNICHANNEL-CAPTURE.md §2).
 *
 * Operational constraints that are *not* optional (§5):
 *   * 10DLC brand + campaign registration before production traffic.
 *   * TCPA opt-in captured at onboarding; STOP handled here and honoured by
 *     the confirmation loop (a revoked identity never receives a message).
 *   * The reply must never contain an account number or a balance — enforced
 *     in `confirm.ts`, not here, so every channel inherits it.
 */

import crypto from 'node:crypto';
import { intakeConfig } from '../config.js';
import { normalizePhone } from '../identity.js';
import {
  ChannelNotConfiguredError,
  decodeDataUrl,
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

/** Words that opt a number out. Twilio handles these too; we mirror it. */
export const STOP_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
/** Words that opt back in. */
export const START_KEYWORDS = new Set(['start', 'yes', 'unstop']);

/** Twilio caps MMS at 10 media per message. */
const MAX_MEDIA = 10;

export class SmsAdapter implements ChannelAdapter {
  readonly channel = 'sms' as const;
  readonly outboundChannel = 'sms' as const;

  get configured(): boolean {
    return intakeConfig.twilio.configured;
  }

  /**
   * Twilio request validation (X-Twilio-Signature).
   *
   * The scheme, verbatim from Twilio's spec:
   *   1. Take the full URL Twilio requested, including the query string.
   *   2. Sort the POST parameters by key, and append `key + value` for each,
   *      with no separators, directly onto the URL string.
   *   3. HMAC-SHA1 that string with the account's auth token.
   *   4. Base64 the digest and compare, constant time, to the header.
   */
  verifySignature(req: WebhookRequest): boolean {
    const token = intakeConfig.twilio.authToken;
    if (!token) return false;
    const presented = header(req, 'x-twilio-signature');
    if (!presented) return false;

    const url = absoluteUrl(req.url);
    const params = isFormEncoded(req) ? parseForm(req.rawBody) : {};
    const expected = twilioSignature(token, url, params);
    return timingSafeEqualB64(presented, expected);
  }

  parseWebhook(req: WebhookRequest): InboundMessage | null {
    const form = isFormEncoded(req) ? parseForm(req.rawBody) : {};
    const from = form['From'] ?? form['from'] ?? '';
    if (!from) return null;

    const body = (form['Body'] ?? form['body'] ?? '').trim();
    const numMedia = Number.parseInt(form['NumMedia'] ?? '0', 10);
    const attachments: InboundAttachment[] = [];
    const mediaRefs: MediaRef[] = [];

    for (let i = 0; i < Math.min(Number.isFinite(numMedia) ? numMedia : 0, MAX_MEDIA); i += 1) {
      const url = form[`MediaUrl${i}`];
      if (!url) continue;
      const mime = form[`MediaContentType${i}`] ?? 'application/octet-stream';
      // `data:` media is decoded inline (PWA relay + replayed fixtures);
      // https media is fetched in hydrate(), which is async by necessity.
      const inline = url.startsWith('data:') ? decodeDataUrl(url) : null;
      if (inline) {
        attachments.push({ ...inline, filename: filenameForMime(mime, `mms-${i}`), mime });
      } else {
        mediaRefs.push({ url, mime, filename: filenameForMime(mime, `mms-${i}`) });
      }
    }

    return {
      channel: this.channel,
      externalId: form['MessageSid'] ?? form['SmsMessageSid'] ?? form['SmsSid'] ?? null,
      senderIdentity: normalizePhone(from),
      receivedAt: new Date(),
      text: body || null,
      attachments,
      mediaRefs,
      raw: form,
    };
  }

  /** Fetch any MMS media Twilio referenced by URL. Media is auth-protected. */
  async hydrate(msg: InboundMessage): Promise<InboundMessage> {
    if (!msg.mediaRefs?.length) return msg;
    if (!this.configured) return msg; // nothing to authenticate with; leave refs
    const auth = Buffer.from(
      `${intakeConfig.twilio.accountSid}:${intakeConfig.twilio.authToken}`,
    ).toString('base64');

    const fetched: InboundAttachment[] = [];
    for (const ref of msg.mediaRefs) {
      const res = await fetch(ref.url, { headers: { Authorization: `Basic ${auth}` } });
      if (!res.ok) continue; // a missing image is a human problem, not a crash
      const mime = ref.mime || res.headers.get('content-type') || 'application/octet-stream';
      fetched.push({
        filename: ref.filename ?? filenameForMime(mime),
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
        'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER',
      );
    }
    const { accountSid, authToken, fromNumber } = intakeConfig.twilio;
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: fromNumber, Body: body }).toString(),
      },
    );
    if (!res.ok) {
      throw new Error(`Twilio send failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as { sid?: string };
    return { externalId: json.sid ?? null };
  }
}

/* -------------------------------------------------------------------------- */
/* Signature computation — exported so it is unit-testable on its own          */
/* -------------------------------------------------------------------------- */

/**
 * Compute the Twilio request signature for a URL + POST parameter set.
 * Exported because "we think the signature check works" is not good enough for
 * a public, unauthenticated endpoint carrying client financial documents.
 */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>>,
): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + (params[key] ?? '');
  }
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

/** Constant-time base64 comparison that tolerates a wrong-length input. */
export function timingSafeEqualB64(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'base64');
  const b = Buffer.from(expected, 'base64');
  if (a.length !== b.length || a.length === 0) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/** The absolute URL Twilio signed: the public origin plus the request path. */
export function absoluteUrl(pathAndQuery: string): string {
  if (/^https?:\/\//i.test(pathAndQuery)) return pathAndQuery;
  return `${intakeConfig.publicBaseUrl}${pathAndQuery.startsWith('/') ? '' : '/'}${pathAndQuery}`;
}

function isFormEncoded(req: WebhookRequest): boolean {
  return header(req, 'content-type').includes('application/x-www-form-urlencoded');
}

/** STOP / START handling for TCPA compliance. Null = not a keyword. */
export function consentKeyword(text: string | null | undefined): 'stop' | 'start' | null {
  const word = (text ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return null;
  if (STOP_KEYWORDS.has(word)) return 'stop';
  if (START_KEYWORDS.has(word)) return 'start';
  return null;
}

export const smsAdapter = new SmsAdapter();
