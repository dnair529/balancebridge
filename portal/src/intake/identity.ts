/**
 * Identity resolution — explicit, never inferred.
 *
 * > "An unrecognized sender must never be auto-attached to a client. Wrong
 * > client attribution in financial records is a serious incident."
 * > — OMNICHANNEL-CAPTURE.md §5
 *
 * So this module does exactly one thing: normalise the sender, look it up in
 * `channel_identities`, and return either a client or `null`. There is no
 * fuzzy fallback, no "closest match", no inference from the message body. A
 * `null` return means the caller quarantines.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { channelIdentities } from '../db/schema.js';
import type { Channel } from './channels/types.js';

export interface ResolvedIdentity {
  readonly clientId: string;
  readonly identityId: string;
  /** The normalised identity actually matched. */
  readonly identity: string;
  readonly verifiedAt: Date | null;
  /** TCPA: outbound messaging is only allowed when this is set. */
  readonly consentAt: Date | null;
  readonly label: string | null;
}

/** Channels whose identity is a phone number and normalises to E.164. */
const PHONE_CHANNELS = new Set<Channel>(['sms', 'whatsapp', 'voice']);

/**
 * Normalise a raw sender string to the canonical form stored in
 * `channel_identities.identity`.
 *
 *  * phone-ish channels → E.164 (`+15125550147`)
 *  * email             → trimmed, lowercased, display name stripped
 *  * everything else   → trimmed
 *
 * Returns `''` when the input cannot be normalised — an empty identity never
 * matches anything, which is the correct (quarantining) outcome.
 */
export function normalizeIdentity(channel: Channel, raw: string | null | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  if (PHONE_CHANNELS.has(channel)) return normalizePhone(value);
  if (channel === 'email') return normalizeEmail(value);
  return value;
}

/**
 * Best-effort E.164. Deliberately conservative: anything it cannot place with
 * confidence is returned digits-only with a leading `+`, which will simply
 * fail to match and quarantine rather than resolve to the wrong client.
 *
 * Handles the shapes that actually arrive: `+1 512 555 0147`,
 * `(512) 555-0147`, `whatsapp:+15125550147`, `tel:+15125550147`, `15125550147`.
 */
export function normalizePhone(raw: string): string {
  let s = raw.trim().toLowerCase();
  // Channel prefixes used by Twilio/Meta.
  s = s.replace(/^(whatsapp|sms|tel|voice):\s*/, '');
  // Twilio sometimes sends `+1 (512) 555-0147 ext. 3` — extensions are not
  // part of an identity and must not silently change which client matches.
  s = s.replace(/\b(ext|x|extension)\.?\s*\d+\s*$/, '');

  const hadPlus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';

  if (hadPlus) return `+${digits}`;
  // Bare North American forms. Anything else keeps its digits and gets a `+`,
  // which is honest about what we know rather than guessing a country code.
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/** Lowercase, trimmed, display name and angle brackets removed. */
export function normalizeEmail(raw: string): string {
  const s = raw.trim();
  // `"Dana Ruiz" <dana@acme.com>` → `dana@acme.com`
  const angled = /<([^>]+)>/.exec(s);
  const addr = (angled?.[1] ?? s).trim().toLowerCase();
  // Never strip plus-addressing: `dana+receipts@acme.com` is a different
  // identity from `dana@acme.com` and the firm may have registered either.
  return addr.replace(/^mailto:/, '');
}

/**
 * Resolve an inbound sender to a client.
 *
 * @returns the identity row when it resolves, or `null` — and `null` means
 *   quarantine. Revoked identities never resolve.
 */
export async function resolveClient(
  channel: Channel,
  senderIdentity: string | null | undefined,
): Promise<ResolvedIdentity | null> {
  const identity = normalizeIdentity(channel, senderIdentity);
  if (!identity) return null;

  const row = await db.query.channelIdentities.findFirst({
    where: and(
      eq(channelIdentities.channel, channel),
      eq(channelIdentities.identity, identity),
      isNull(channelIdentities.revokedAt),
    ),
  });
  if (!row) return null;

  return {
    clientId: row.clientId,
    identityId: row.id,
    identity: row.identity,
    verifiedAt: row.verifiedAt,
    consentAt: row.consentAt,
    label: row.label,
  };
}

/**
 * The identity to reply on for a client + channel, or null when there is none
 * we are allowed to use. `requireConsent` enforces the TCPA rule: no
 * documented consent, no outbound message (OMNICHANNEL-CAPTURE.md §5).
 */
export async function replyIdentityFor(
  clientId: string,
  channel: Channel,
  opts: { requireConsent?: boolean } = {},
): Promise<ResolvedIdentity | null> {
  const rows = await db.query.channelIdentities.findMany({
    where: and(
      eq(channelIdentities.clientId, clientId),
      eq(channelIdentities.channel, channel),
      isNull(channelIdentities.revokedAt),
    ),
  });

  // Prefer a verified identity with consent, then verified, then anything live.
  const ranked = [...rows].sort((a, b) => score(b) - score(a));
  const pick = ranked[0];
  if (!pick) return null;
  if (opts.requireConsent && !pick.consentAt) return null;

  return {
    clientId: pick.clientId,
    identityId: pick.id,
    identity: pick.identity,
    verifiedAt: pick.verifiedAt,
    consentAt: pick.consentAt,
    label: pick.label,
  };
}

function score(row: { verifiedAt: Date | null; consentAt: Date | null }): number {
  return (row.consentAt ? 2 : 0) + (row.verifiedAt ? 1 : 0);
}

/**
 * Attach an identity to a client — how a quarantined item gets claimed by a
 * human. Idempotent: re-pointing an existing identity at the same client is a
 * no-op, and moving it to a different client is an explicit update, recorded
 * by the caller in the audit log.
 */
export async function linkIdentity(input: {
  clientId: string;
  channel: Channel;
  identity: string;
  label?: string | null;
  verified?: boolean;
  consent?: boolean;
}): Promise<ResolvedIdentity> {
  const identity = normalizeIdentity(input.channel, input.identity);
  if (!identity) {
    throw new Error(`Cannot link an empty ${input.channel} identity.`);
  }
  const now = new Date();

  const existing = await db.query.channelIdentities.findFirst({
    where: and(
      eq(channelIdentities.channel, input.channel),
      eq(channelIdentities.identity, identity),
    ),
  });

  if (existing) {
    const [updated] = await db
      .update(channelIdentities)
      .set({
        clientId: input.clientId,
        label: input.label ?? existing.label,
        verifiedAt: input.verified ? (existing.verifiedAt ?? now) : existing.verifiedAt,
        consentAt: input.consent ? (existing.consentAt ?? now) : existing.consentAt,
        revokedAt: null,
      })
      .where(eq(channelIdentities.id, existing.id))
      .returning();
    return toResolved(updated!);
  }

  const [created] = await db
    .insert(channelIdentities)
    .values({
      clientId: input.clientId,
      channel: input.channel,
      identity,
      label: input.label ?? null,
      verifiedAt: input.verified ? now : null,
      consentAt: input.consent ? now : null,
    })
    .returning();
  return toResolved(created!);
}

function toResolved(row: typeof channelIdentities.$inferSelect): ResolvedIdentity {
  return {
    clientId: row.clientId,
    identityId: row.id,
    identity: row.identity,
    verifiedAt: row.verifiedAt,
    consentAt: row.consentAt,
    label: row.label,
  };
}
