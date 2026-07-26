/**
 * "What we still need from you" — computed, not remembered.
 *
 * The metric the omnichannel work is judged on is *the percentage of documents
 * arriving without a human asking for them* (OMNICHANNEL-CAPTURE.md §6). This
 * service is the other half of that: what is genuinely still missing, derived
 * from the ledger every time rather than from somebody's memory, and chased on
 * a schedule nobody has to run.
 *
 * Three sources, all deterministic:
 *
 *   1. **Statements** — one per open account per closed period in the lookback
 *      window, unless a statement for that period already arrived.
 *   2. **Receipts** — every transaction flagged `needs_receipt` with no live
 *      matched extraction against it.
 *   3. **W-9s** — any counterparty paid more than the threshold in the trailing
 *      year with no W-9 on file. Chase it in July, not in January when 1099
 *      season makes it urgent.
 *
 * ## The nudge rule
 *
 * > **One digest per client per interval. Never scattered messages.**
 *
 * Eleven open requests produce one message listing eleven things, not eleven
 * messages. `nudge()` is the only thing in this module that sends, it batches
 * unconditionally, it respects `consent_at` on the channel identity (TCPA,
 * §5), and it will not send twice inside `INTAKE_NUDGE_INTERVAL_HOURS` no
 * matter how often it is called.
 */

import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  accounts,
  documentRequests,
  extractions,
  intakeItems,
  outboundMessages,
  transactions,
  txnMatches,
} from '../db/schema.js';
import { money, normalizeVendor } from '../ai/format.js';
import { audit } from '../lib/audit.js';
import { intakeConfig } from '../intake/config.js';
import { replyIdentityFor } from '../intake/identity.js';
import { assertNoSensitiveFigures, queueAndSend } from '../intake/confirm.js';
import type { Channel } from '../intake/channels/types.js';

export interface MissingItem {
  readonly kind: 'statement' | 'receipt' | 'w9';
  readonly label: string;
  readonly accountId: string | null;
  readonly transactionId: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly why: string;
}

export interface BuildResult {
  readonly missing: readonly MissingItem[];
  readonly created: number;
  readonly alreadyOpen: number;
  readonly closed: number;
}

export interface NudgeResult {
  readonly sent: boolean;
  readonly reason: string;
  readonly outboundMessageId: string | null;
  readonly requestIds: readonly string[];
  readonly body: string | null;
}

/* ========================================================================== */
/* What is missing                                                             */
/* ========================================================================== */

/**
 * Compute the missing-document list for a client. Pure read; nothing is
 * written. `syncRequests()` is what turns it into `document_requests` rows.
 */
export async function computeMissing(clientId: string, asOf = new Date()): Promise<MissingItem[]> {
  const [statements, receipts, w9s] = await Promise.all([
    missingStatements(clientId, asOf),
    missingReceipts(clientId),
    missingW9s(clientId, asOf),
  ]);
  return [...statements, ...receipts, ...w9s];
}

async function missingStatements(clientId: string, asOf: Date): Promise<MissingItem[]> {
  const openAccounts = await db.query.accounts.findMany({
    where: and(eq(accounts.clientId, clientId), isNull(accounts.closedAt)),
  });
  if (openAccounts.length === 0) return [];

  const periods = closedMonthsBefore(asOf, intakeConfig.nudge.statementLookbackMonths);

  // Statements that already arrived, by the period they cover.
  const filed = await db
    .select({ docType: extractions.docType, extracted: extractions.extracted })
    .from(extractions)
    .innerJoin(intakeItems, eq(extractions.intakeItemId, intakeItems.id))
    .where(and(eq(intakeItems.clientId, clientId), eq(extractions.docType, 'statement')));

  const filedMonths = new Set<string>();
  for (const row of filed) {
    const date = (row.extracted as { date?: string } | null)?.date;
    if (typeof date === 'string' && /^\d{4}-\d{2}/.test(date)) filedMonths.add(date.slice(0, 7));
  }

  const satisfied = await db.query.documentRequests.findMany({
    where: and(
      eq(documentRequests.clientId, clientId),
      inArray(documentRequests.status, ['received', 'waived']),
    ),
  });
  const satisfiedKeys = new Set(
    satisfied.map((r) => `${r.accountId ?? ''}:${r.periodStart ?? ''}`),
  );

  const out: MissingItem[] = [];
  for (const account of openAccounts) {
    // Cash accounts have no institution to send a statement.
    if (account.kind === 'cash') continue;
    for (const period of periods) {
      if (filedMonths.has(period.start.slice(0, 7))) continue;
      if (satisfiedKeys.has(`${account.id}:${period.start}`)) continue;
      const name = account.mask ? `${account.name} ••${account.mask}` : account.name;
      out.push({
        kind: 'statement',
        label: `${name} statement — ${period.label}`,
        accountId: account.id,
        transactionId: null,
        periodStart: period.start,
        periodEnd: period.end,
        why: `No ${period.label} statement has arrived for this account, and the period is closed.`,
      });
    }
  }
  return out;
}

async function missingReceipts(clientId: string): Promise<MissingItem[]> {
  const flagged = await db.query.transactions.findMany({
    where: and(eq(transactions.clientId, clientId), eq(transactions.needsReceipt, true)),
    orderBy: [desc(transactions.postedAt)],
    limit: 500,
  });
  if (flagged.length === 0) return [];

  // A transaction with a live (non-rejected) match already has its receipt.
  const matched = await db
    .select({ transactionId: txnMatches.transactionId })
    .from(txnMatches)
    .where(
      and(
        isNull(txnMatches.rejectedAt),
        inArray(
          txnMatches.transactionId,
          flagged.map((t) => t.id),
        ),
      ),
    );
  const covered = new Set(matched.map((m) => m.transactionId));

  return flagged
    .filter((t) => !covered.has(t.id))
    .map((t) => ({
      kind: 'receipt' as const,
      label: `Receipt for ${t.counterparty ?? t.description} — ${money(Math.abs(t.amountCents))} on ${t.postedAt}`,
      accountId: t.accountId,
      transactionId: t.id,
      periodStart: t.postedAt,
      periodEnd: t.postedAt,
      why: 'The charge is flagged as needing a receipt and no document is matched to it.',
    }));
}

async function missingW9s(clientId: string, asOf: Date): Promise<MissingItem[]> {
  const from = new Date(asOf);
  from.setUTCFullYear(from.getUTCFullYear() - 1);
  const fromIso = from.toISOString().slice(0, 10);

  const rows = await db.query.transactions.findMany({
    where: and(eq(transactions.clientId, clientId), gte(transactions.postedAt, fromIso)),
    limit: 5000,
  });

  const spend = new Map<string, { label: string; cents: number }>();
  for (const t of rows) {
    if (t.amountCents >= 0) continue; // money out only
    const label = (t.counterparty ?? t.description).trim();
    const key = normalizeVendor(label);
    if (!key) continue;
    const prev = spend.get(key);
    spend.set(key, {
      label: prev?.label ?? label,
      cents: (prev?.cents ?? 0) + Math.abs(t.amountCents),
    });
  }

  const onFile = await db
    .select({ extracted: extractions.extracted })
    .from(extractions)
    .innerJoin(intakeItems, eq(extractions.intakeItemId, intakeItems.id))
    .where(and(eq(intakeItems.clientId, clientId), eq(extractions.docType, 'w9')));

  const haveW9 = new Set(
    onFile
      .map((r) => normalizeVendor((r.extracted as { vendor?: string } | null)?.vendor ?? ''))
      .filter(Boolean),
  );

  const out: MissingItem[] = [];
  for (const [key, v] of spend) {
    if (v.cents < intakeConfig.nudge.w9ThresholdCents) continue;
    if (haveW9.has(key)) continue;
    out.push({
      kind: 'w9',
      label: `W-9 from ${v.label}`,
      accountId: null,
      transactionId: null,
      periodStart: fromIso,
      periodEnd: asOf.toISOString().slice(0, 10),
      why:
        `${money(v.cents)} paid to ${v.label} in the last 12 months and no W-9 on file. ` +
        'Worth collecting now rather than in January.',
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/* ========================================================================== */
/* Persisting the list                                                         */
/* ========================================================================== */

/**
 * Reconcile `document_requests` with what is actually missing right now:
 * open a row for anything new, and close any open row whose need has been met
 * (the receipt arrived, the statement landed). Idempotent.
 */
export async function syncRequests(clientId: string, asOf = new Date()): Promise<BuildResult> {
  const missing = await computeMissing(clientId, asOf);

  const open = await db.query.documentRequests.findMany({
    where: and(eq(documentRequests.clientId, clientId), eq(documentRequests.status, 'open')),
  });
  const openByKey = new Map(open.map((r) => [requestKey(r), r]));
  const missingKeys = new Set(missing.map(keyOf));

  let created = 0;
  let alreadyOpen = 0;
  for (const item of missing) {
    if (openByKey.has(keyOf(item))) {
      alreadyOpen += 1;
      continue;
    }
    await db.insert(documentRequests).values({
      clientId,
      label: item.label.slice(0, 300),
      periodStart: item.periodStart,
      periodEnd: item.periodEnd,
      accountId: item.accountId,
      transactionId: item.transactionId,
      status: 'open',
    });
    created += 1;
  }

  // Anything open that is no longer missing has been satisfied.
  const stale = open.filter((r) => !missingKeys.has(requestKey(r)));
  for (const r of stale) {
    await db
      .update(documentRequests)
      .set({ status: 'received' })
      .where(eq(documentRequests.id, r.id));
  }

  if (created || stale.length) {
    await audit(null, {
      action: 'document_requests.synced',
      clientId,
      entity: 'client',
      entityId: clientId,
      meta: { created, alreadyOpen, closed: stale.length, missing: missing.length },
    });
  }

  return { missing, created, alreadyOpen, closed: stale.length };
}

function keyOf(item: MissingItem): string {
  return [item.kind, item.accountId ?? '', item.transactionId ?? '', item.periodStart ?? '', item.label]
    .join('|')
    .toLowerCase();
}

function requestKey(row: typeof documentRequests.$inferSelect): string {
  const kind = row.transactionId ? 'receipt' : row.accountId ? 'statement' : 'w9';
  return [kind, row.accountId ?? '', row.transactionId ?? '', row.periodStart ?? '', row.label]
    .join('|')
    .toLowerCase();
}

/* ========================================================================== */
/* The digest                                                                  */
/* ========================================================================== */

export interface NudgeOptions {
  /** Reply channel. Defaults to SMS, then email, then the portal. */
  readonly channel?: Channel;
  /** Recompute the list before composing. Default true. */
  readonly sync?: boolean;
  /** Ignore the interval. For a staff member pressing "chase now". */
  readonly force?: boolean;
  readonly asOf?: Date;
  /** Compose and record the decision without sending. */
  readonly dryRun?: boolean;
}

/**
 * Send **one** digest of everything outstanding, or explain why it did not.
 *
 * Suppression is never silent: every refusal returns a reason and is auditable.
 */
export async function nudge(clientId: string, opts: NudgeOptions = {}): Promise<NudgeResult> {
  const asOf = opts.asOf ?? new Date();
  if (opts.sync !== false) await syncRequests(clientId, asOf);

  const open = await db.query.documentRequests.findMany({
    where: and(
      eq(documentRequests.clientId, clientId),
      eq(documentRequests.status, 'open'),
      or(isNull(documentRequests.dueAt), lte(documentRequests.dueAt, new Date(asOf.getTime() + DAY))),
    ),
    orderBy: [desc(documentRequests.createdAt)],
    limit: 100,
  });

  if (open.length === 0) {
    return { sent: false, reason: 'nothing outstanding', outboundMessageId: null, requestIds: [], body: null };
  }

  // ---- The batching rule: one digest per client per interval -------------
  if (!opts.force) {
    const since = new Date(asOf.getTime() - intakeConfig.nudge.intervalHours * HOUR);
    const recent = await db.query.outboundMessages.findFirst({
      where: and(
        eq(outboundMessages.clientId, clientId),
        eq(outboundMessages.purpose, 'digest'),
        gte(outboundMessages.createdAt, since),
      ),
    });
    if (recent) {
      return {
        sent: false,
        reason:
          `a digest already went out at ${recent.createdAt.toISOString()} — ` +
          `one per ${intakeConfig.nudge.intervalHours}h, never scattered`,
        outboundMessageId: null,
        requestIds: [],
        body: null,
      };
    }
  }

  // ---- TCPA: no documented consent, no outbound nudge --------------------
  const channel = opts.channel ?? (await preferredChannel(clientId));
  if (!channel) {
    return {
      sent: false,
      reason: 'no consented channel identity on file for this client',
      outboundMessageId: null,
      requestIds: [],
      body: null,
    };
  }

  const body = composeDigest(open.map((r) => r.label));
  if (opts.dryRun) {
    return { sent: false, reason: 'dry run', outboundMessageId: null, requestIds: open.map((r) => r.id), body };
  }

  const queued = await queueAndSend({
    clientId,
    inboundChannel: channel,
    body,
    purpose: 'digest',
    relatedEntity: 'document_requests',
    relatedId: open[0]!.id,
    // A nudge is us initiating contact, not replying to the client. Consent
    // is mandatory here in a way it is not for a capture confirmation.
    requireConsent: true,
  });

  if (queued.status === 'suppressed') {
    return {
      sent: false,
      reason: queued.failureReason ?? 'suppressed',
      outboundMessageId: queued.id,
      requestIds: [],
      body,
    };
  }

  const now = new Date();
  await db
    .update(documentRequests)
    .set({ lastNudgedAt: now, nudgeCount: sql`${documentRequests.nudgeCount} + 1` })
    .where(
      inArray(
        documentRequests.id,
        open.map((r) => r.id),
      ),
    );

  await audit(null, {
    action: 'document_requests.nudged',
    clientId,
    entity: 'outbound_message',
    entityId: queued.id,
    meta: { channel, items: open.length, status: queued.status },
  });

  return {
    sent: queued.status === 'sent',
    reason: queued.status === 'sent' ? 'sent' : 'queued until the channel is configured',
    outboundMessageId: queued.id,
    requestIds: open.map((r) => r.id),
    body,
  };
}

/** Nudge every client that has something outstanding. One digest each. */
export async function nudgeAll(opts: NudgeOptions = {}): Promise<readonly (NudgeResult & { clientId: string })[]> {
  const rows = await db
    .selectDistinct({ clientId: documentRequests.clientId })
    .from(documentRequests)
    .where(eq(documentRequests.status, 'open'));

  const out: (NudgeResult & { clientId: string })[] = [];
  for (const r of rows) {
    out.push({ clientId: r.clientId, ...(await nudge(r.clientId, opts)) });
  }
  return out;
}

/**
 * The digest body. Unit-testable, and subject to the same no-account-numbers
 * tripwire as every other outbound message — a statement request names the
 * account by its last four, never by its number.
 */
export function composeDigest(labels: readonly string[], max = 8): string {
  const shown = labels.slice(0, max);
  const extra = labels.length - shown.length;
  const lead =
    labels.length === 1
      ? 'One thing we still need from you:'
      : `${labels.length} things we still need from you:`;
  const list = shown.map((l) => `• ${l}`).join('\n');
  const tail = extra > 0 ? `\n• …and ${extra} more in the portal` : '';
  const body = `${lead}\n${list}${tail}\n\nText a photo of any of these back and we'll file it.`;
  assertNoSensitiveFigures(body);
  return body;
}

async function preferredChannel(clientId: string): Promise<Channel | null> {
  for (const channel of ['sms', 'whatsapp', 'email'] as const) {
    const identity = await replyIdentityFor(clientId, channel, { requireConsent: true });
    if (identity) return channel;
  }
  return null;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** The closed months before `asOf`, most recent first. */
export function closedMonthsBefore(
  asOf: Date,
  count: number,
): readonly { start: string; end: string; label: string }[] {
  const out: { start: string; end: string; label: string }[] = [];
  for (let i = 1; i <= count; i += 1) {
    const start = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    out.push({
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
      label: start.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    });
  }
  return out;
}
