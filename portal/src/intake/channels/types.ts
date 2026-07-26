/**
 * The channel adapter contract — "many front doors, one hallway"
 * (OMNICHANNEL-CAPTURE.md §1).
 *
 * An adapter does exactly two things and knows nothing else:
 *
 *   1. `parseWebhook()` turns one provider's payload into an
 *      {@link InboundMessage}, the single normalised shape the pipeline sees.
 *   2. `send()` puts a line of text back out through the same channel.
 *
 * Everything downstream of `parseWebhook` — dedupe, extraction, matching,
 * filing, the audit trail — is channel-agnostic and is written once. Adding
 * WhatsApp in year two is a new file in this directory and a row in the
 * registry, and touches nothing in `pipeline.ts`.
 *
 * ## Unconfigured adapters
 *
 * Every adapter is constructible with no credentials at all. An unconfigured
 * adapter reports `configured: false`, still parses payloads (so a webhook can
 * be replayed the moment credentials land), and throws a typed
 * {@link ChannelNotConfiguredError} from `send()` — which callers treat as
 * "leave the outbound_messages row queued", never as a crash.
 */

import type { intakeItems } from '../../db/schema.js';

/**
 * The channels an intake item can arrive on. Derived from the schema enum so
 * the two can never drift — a channel added to `src/db/schema.ts` is a
 * compile error here until an adapter exists for it.
 */
export type Channel = NonNullable<(typeof intakeItems.$inferInsert)['channel']>;

/** Channels we can send *out* on (schema: `outbound_messages.channel`). */
export type OutboundChannel = 'sms' | 'whatsapp' | 'email' | 'portal' | 'push';

export interface InboundAttachment {
  readonly filename: string;
  readonly mime: string;
  readonly buffer: Buffer;
}

/**
 * One inbound artefact, normalised. `raw` is retained verbatim on the
 * `intake_items` row: this is financial data and "where did this come from"
 * must be answerable a year later (OMNICHANNEL-CAPTURE.md §1).
 */
export interface InboundMessage {
  readonly channel: Channel;
  /** Provider message id. Half of the idempotency key; null when absent. */
  readonly externalId?: string | null;
  /** Normalised sender: E.164 phone, lowercase email, WhatsApp id, folder id. */
  readonly senderIdentity: string;
  readonly receivedAt: Date;
  readonly text?: string | null;
  readonly attachments: readonly InboundAttachment[];
  /** Verbatim provider payload. Never trusted, always kept. */
  readonly raw: unknown;
  /**
   * Remote media the provider referenced but did not inline. Resolved by
   * {@link ChannelAdapter.hydrate} before ingestion, because fetching is async
   * and `parseWebhook` is deliberately synchronous and side-effect free.
   */
  readonly mediaRefs?: readonly MediaRef[];
  /** Set by adapters that carry a subject line (email). */
  readonly subject?: string | null;
}

export interface MediaRef {
  readonly url: string;
  readonly mime?: string | null;
  readonly filename?: string | null;
  /** Provider media id, for APIs that require a second call to resolve a URL. */
  readonly id?: string | null;
}

/**
 * The minimal request shape an adapter needs. Deliberately not
 * `FastifyRequest`: adapters are pure functions of (method, url, headers,
 * body) and are unit-testable without booting a server.
 */
export interface WebhookRequest {
  readonly method: string;
  /** Path + query as received, e.g. `/webhooks/sms`. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Exact bytes as received — required for any HMAC over the raw body. */
  readonly rawBody: Buffer;
  /** Convenience: parsed query string. */
  readonly query?: Readonly<Record<string, string | undefined>>;
}

export interface SendResult {
  readonly externalId?: string | null;
}

export interface ChannelAdapter {
  readonly channel: Channel;
  /** True when this adapter has everything it needs to send. */
  readonly configured: boolean;
  /** Provider payload -> normalised message. Null = nothing actionable. */
  parseWebhook(req: WebhookRequest): InboundMessage | null;
  /** Outbound. Throws {@link ChannelNotConfiguredError} when unconfigured. */
  send(to: string, body: string): Promise<SendResult>;
  /** Present only where the provider signs its webhooks. */
  verifySignature?(req: WebhookRequest): boolean;
  /** Resolve `mediaRefs` into real attachments. Optional; identity by default. */
  hydrate?(msg: InboundMessage): Promise<InboundMessage>;
  /** The `outbound_messages.channel` value replies go out on, if any. */
  readonly outboundChannel?: OutboundChannel;
}

/**
 * A channel that has no credentials cannot send. This is a normal operating
 * state — 10DLC registration takes weeks — so it is a *typed* error the
 * confirmation loop catches and leaves the message queued, not an exception
 * that takes a request down.
 */
export class ChannelNotConfiguredError extends Error {
  override readonly name = 'ChannelNotConfiguredError';
  constructor(
    readonly channel: Channel,
    readonly missing: string,
  ) {
    super(
      `Channel "${channel}" is not configured (${missing}). ` +
        'The message stays queued; nothing is lost and nothing is sent.',
    );
  }
}

/** A webhook arrived that this adapter cannot make sense of. */
export class WebhookParseError extends Error {
  override readonly name = 'WebhookParseError';
  constructor(
    readonly channel: Channel,
    reason: string,
  ) {
    super(`Could not parse a ${channel} webhook: ${reason}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Shared helpers for adapters                                                 */
/* -------------------------------------------------------------------------- */

/** First value of a header, lowercased key lookup, always a string. */
export function header(req: WebhookRequest, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

/** Parse an `application/x-www-form-urlencoded` body into a flat record. */
export function parseForm(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  const params = new URLSearchParams(body.toString('utf8'));
  for (const [k, v] of params) out[k] = v;
  return out;
}

/** Parse a JSON body, returning null rather than throwing on garbage. */
export function parseJson<T>(body: Buffer): T | null {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    return parsed as T;
  } catch {
    return null;
  }
}

/** `data:` URLs are decoded inline; everything else is a remote fetch. */
export function decodeDataUrl(url: string): InboundAttachment | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(url);
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  const buffer = m[2]
    ? Buffer.from(m[3] ?? '', 'base64')
    : Buffer.from(decodeURIComponent(m[3] ?? ''), 'utf8');
  return { filename: filenameForMime(mime), mime, buffer };
}

const MIME_EXT: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
};

/** A stable, extension-correct filename for media that arrived without one. */
export function filenameForMime(mime: string, stem = 'capture'): string {
  const ext = MIME_EXT[mime.toLowerCase().split(';')[0]?.trim() ?? ''] ?? 'bin';
  return `${stem}.${ext}`;
}
