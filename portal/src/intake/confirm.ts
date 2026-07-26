/**
 * The confirmation loop (OMNICHANNEL-CAPTURE.md §3 — "do not skip this").
 *
 * > *"Got it — Home Depot, $412.83, matched to your Chase ••4021. Reply **J**
 * > if this was for a job."*
 *
 * That one message does four jobs: confirms receipt, shows the extraction so
 * errors surface immediately, closes the categorisation question at the moment
 * of context, and trains the client that the system works. Silence is the
 * reason clients abandon capture tools.
 *
 * ## The hard rule
 *
 * > "PII over SMS: confirm amounts and vendors, **never account numbers or
 * > balances**. Assume the phone is unlocked on a truck seat." (§5)
 *
 * {@link composeConfirmation} is a pure function so it can be tested in
 * isolation, and every string it produces is run through
 * {@link assertNoSensitiveFigures} before it can be persisted or sent. That
 * check throws rather than redacting: a confirmation that would have leaked an
 * account number is a bug to fix, not a message to quietly sanitise.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { outboundMessages } from '../db/schema.js';
import { money } from '../ai/format.js';
import { audit } from '../lib/audit.js';
import { adapterFor, outboundChannelFor, senderFor } from './channels/index.js';
import { ChannelNotConfiguredError, type Channel, type OutboundChannel } from './channels/types.js';
import { replyIdentityFor } from './identity.js';

export interface AccountMask {
  /** Institution or account name, e.g. "Chase". Never an account number. */
  readonly label: string | null;
  /** Last four digits only. Anything longer is rejected. */
  readonly mask: string | null;
}

export interface ConfirmationPrompt {
  /** The single character or short word the client replies with, e.g. "J". */
  readonly token: string;
  /** The condition, phrased to follow "Reply J ", e.g. "if this was for a job". */
  readonly text: string;
}

export interface ComposeInput {
  readonly vendor: string | null;
  readonly amountCents: number | null;
  readonly account?: AccountMask | null;
  /** Set when the item could not be matched to a transaction. */
  readonly unmatched?: boolean;
  /** The open question to close at the moment of context. */
  readonly prompt?: ConfirmationPrompt | null;
  /** Set when extraction could not read the document at all. */
  readonly unreadable?: boolean;
}

/** Thrown when a would-be outbound message contains something it must not. */
export class SensitiveContentError extends Error {
  override readonly name = 'SensitiveContentError';
  constructor(reason: string, readonly body: string) {
    super(`Refusing to send an outbound message: ${reason}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Composition — pure, unit-testable                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build the in-channel reply. Never includes an account number or a balance;
 * an account is referenced only as `Chase ••4021`.
 */
export function composeConfirmation(input: ComposeInput): string {
  const parts: string[] = [];

  if (input.unreadable) {
    parts.push("Got it — we've got your file but couldn't read it clearly.");
    parts.push('A bookkeeper will take a look and file it.');
    return finish(parts.join(' '), input.prompt);
  }

  const vendor = cleanVendor(input.vendor);
  const amount = input.amountCents === null || input.amountCents === undefined
    ? null
    : money(Math.abs(input.amountCents));

  const head = [vendor, amount].filter(Boolean).join(', ');
  parts.push(head ? `Got it — ${head}` : 'Got it — receipt received');

  const account = formatAccount(input.account);
  if (account && !input.unmatched) {
    parts.push(`, matched to your ${account}.`);
  } else if (input.unmatched) {
    parts.push(". We couldn't match it to a transaction yet — we'll take it from here.");
  } else {
    parts.push('.');
  }

  return finish(parts.join(''), input.prompt);
}

function finish(body: string, prompt?: ConfirmationPrompt | null): string {
  const text = prompt ? `${body} Reply ${prompt.token} ${stripTrailingPeriod(prompt.text)}.` : body;
  assertNoSensitiveFigures(text);
  return text;
}

/** `{ label: 'Chase', mask: '4021' }` → `Chase ••4021`. */
export function formatAccount(account: AccountMask | null | undefined): string | null {
  if (!account) return null;
  const mask = (account.mask ?? '').replace(/\D/g, '');
  const label = (account.label ?? '').trim();
  if (mask.length > 4) {
    throw new SensitiveContentError(
      `account mask "${account.mask}" is longer than 4 digits — that is an account number, not a mask`,
      label,
    );
  }
  if (!mask) return label || null;
  return label ? `${label} ••${mask}` : `••${mask}`;
}

const BALANCE_WORDS =
  /\b(balance|available funds|routing|account (?:number|no\.?|#)|acct\s*#|iban|sort code|ssn|ein|card number)\b/i;

/**
 * Tripwire, not a sanitiser. Rejects anything that looks like an account
 * number or a balance disclosure.
 *
 * Money is always rendered by `money()` with thousands separators, so a
 * legitimate amount never contains a run of more than three digits. Once the
 * two other things that legitimately carry digits — a `••1234` mask and a date
 * — are removed, a surviving run of four or more is, by construction, not an
 * amount, and the only four-plus-digit numbers we handle are the ones this
 * function exists to keep out of a text message.
 */
export function assertNoSensitiveFigures(body: string): void {
  if (BALANCE_WORDS.test(body)) {
    throw new SensitiveContentError('it mentions a balance or an account identifier', body);
  }
  const withoutMasks = body
    .replace(/••\d{1,4}/g, '') // the masks we deliberately allow
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '') // 2026-07-14
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, '') // 07/14/2026
    .replace(/\b(?:19|20)\d{2}\b/g, ''); // a bare year, e.g. "June 2026"
  const longRun = /\d{4,}/.exec(withoutMasks);
  if (longRun) {
    throw new SensitiveContentError(
      `it contains a ${longRun[0].length}-digit run ("${longRun[0]}") — amounts never look like that`,
      body,
    );
  }
}

function cleanVendor(vendor: string | null): string | null {
  const v = (vendor ?? '').trim();
  if (!v) return null;
  return v.length > 60 ? `${v.slice(0, 57)}…` : v;
}

function stripTrailingPeriod(s: string): string {
  return s.trim().replace(/\.$/, '');
}

/* -------------------------------------------------------------------------- */
/* Persistence + delivery                                                      */
/* -------------------------------------------------------------------------- */

export interface QueueInput {
  readonly clientId: string;
  /** The channel the item arrived on; the reply channel is derived from it. */
  readonly inboundChannel: Channel;
  readonly body: string;
  readonly purpose?: 'capture_confirmation' | 'question' | 'document_request' | 'alert' | 'digest' | 'other';
  readonly relatedEntity?: string | null;
  readonly relatedId?: string | null;
  readonly inReplyTo?: string | null;
  /** Override the recipient (default: the client's identity on that channel). */
  readonly toIdentity?: string | null;
  /** TCPA: outbound marketing/nudges require consent. Confirmations reply to
   *  a message the client just sent, which is consent by conduct. */
  readonly requireConsent?: boolean;
}

export interface QueuedMessage {
  readonly id: string;
  readonly channel: OutboundChannel;
  readonly toIdentity: string;
  readonly body: string;
  readonly status: 'queued' | 'sent' | 'failed' | 'suppressed';
  readonly failureReason: string | null;
}

/**
 * Persist the message first, then try to send it. In that order, deliberately:
 * an outbound row that never sent is recoverable, a send with no record is not.
 *
 * An unconfigured channel is a normal state (10DLC takes weeks) — the row
 * stays `queued` and nothing throws.
 */
export async function queueAndSend(input: QueueInput): Promise<QueuedMessage> {
  assertNoSensitiveFigures(input.body);

  const outChannel = outboundChannelFor(input.inboundChannel) ?? 'portal';
  const replyOn = outChannel === 'push' || outChannel === 'portal' ? input.inboundChannel : outChannel;

  let to = input.toIdentity ?? null;
  if (!to) {
    const identity = await replyIdentityFor(input.clientId, replyOn as Channel, {
      requireConsent: input.requireConsent === true,
    });
    to = identity?.identity ?? null;
  }

  // No usable identity (or no consent) is a suppression, recorded as such —
  // never a silent drop.
  const suppressed = !to;

  const [row] = await db
    .insert(outboundMessages)
    .values({
      clientId: input.clientId,
      channel: outChannel,
      toIdentity: to ?? '(none on file)',
      body: input.body,
      purpose: input.purpose ?? 'capture_confirmation',
      relatedEntity: input.relatedEntity ?? null,
      relatedId: input.relatedId ?? null,
      inReplyTo: input.inReplyTo ?? null,
      status: suppressed ? 'suppressed' : 'queued',
      failureReason: suppressed
        ? input.requireConsent
          ? 'no consented identity on file for this channel'
          : 'no identity on file for this channel'
        : null,
    })
    .returning();

  const message = row!;
  if (suppressed || !to) {
    await audit(null, {
      action: 'intake.confirmation_suppressed',
      clientId: input.clientId,
      entity: 'outbound_message',
      entityId: message.id,
      meta: { channel: outChannel, reason: message.failureReason },
    });
    return toQueued(message);
  }

  const sender = senderFor(input.inboundChannel) ?? adapterFor(replyOn as Channel);
  try {
    const res = await sender.send(to, input.body);
    const [sent] = await db
      .update(outboundMessages)
      .set({ status: 'sent', sentAt: new Date(), failureReason: null, inReplyTo: message.inReplyTo })
      .where(eq(outboundMessages.id, message.id))
      .returning();
    await audit(null, {
      action: 'intake.confirmation_sent',
      clientId: input.clientId,
      entity: 'outbound_message',
      entityId: message.id,
      meta: { channel: outChannel, providerId: res.externalId ?? null },
    });
    return toQueued(sent!);
  } catch (err) {
    const notConfigured = err instanceof ChannelNotConfiguredError;
    const reason = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
    // Unconfigured stays `queued` (it will go the moment credentials land);
    // a real failure is marked `failed` so it shows up in the queue.
    const [updated] = await db
      .update(outboundMessages)
      .set({ status: notConfigured ? 'queued' : 'failed', failureReason: reason })
      .where(eq(outboundMessages.id, message.id))
      .returning();
    await audit(null, {
      action: notConfigured ? 'intake.confirmation_queued' : 'intake.confirmation_failed',
      clientId: input.clientId,
      entity: 'outbound_message',
      entityId: message.id,
      meta: { channel: outChannel, reason },
    });
    return toQueued(updated!);
  }
}

function toQueued(row: typeof outboundMessages.$inferSelect): QueuedMessage {
  return {
    id: row.id,
    channel: row.channel,
    toIdentity: row.toIdentity,
    body: row.body,
    status: row.status,
    failureReason: row.failureReason,
  };
}
