/**
 * The hallway (OMNICHANNEL-CAPTURE.md §1).
 *
 * ```
 *  SMS/MMS ┐
 * WhatsApp ┤
 *  PWA cam ┤
 *    Email ┤──▶  INTAKE QUEUE  ──▶ dedupe ──▶ extract ──▶ classify ──▶ match ──▶ file
 *   Portal ┤     (normalized)       (hash)     (OCR/AI)   (doc type)  (to txn)   │
 * Bank feed┤                                                                     ▼
 *    Voice ┘                                                      confident? auto-file
 *                                                                 unsure?    human queue
 * ```
 *
 * Five rules, and every one of them is enforced here rather than in an adapter,
 * because an adapter is written once per channel and this is written once,
 * full stop:
 *
 * 1. **The original is never mutated.** The raw payload and the raw bytes are
 *    stored immutably; every extraction is a separate append-only row pointing
 *    at the intake item. If the model gets it wrong, the truth is still there.
 * 2. **Idempotency at the door.** `(channel, external_id)` and
 *    `(client_id, content_hash)`, both backed by unique indexes. A client who
 *    texts the same photo three times gets one document, not three. Calling
 *    `ingest()` twice with the same message is safe by construction — the
 *    second call returns the first call's item.
 * 3. **Identity resolution is explicit.** Unknown sender → quarantine. Never
 *    guessed, ever.
 * 4. **Provenance on everything.** Channel, sender, timestamp, raw payload.
 * 5. **Confidence gates automation.** High confidence auto-files. Anything
 *    below the bar becomes `needs_review` plus a work item for a person.
 */

import crypto from 'node:crypto';
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  accounts,
  categories as categoriesTable,
  categorizationRules,
  clientQuestions,
  documents,
  extractions,
  intakeItems,
  transactions,
  txnMatches,
  workItems,
} from '../db/schema.js';
import { extractDocument, type ExtractedDocument } from '../ai/tasks/extractDocument.js';
import { suggestCategory } from '../ai/tasks/suggestCategory.js';
import type { CategoryRef, PriorDecision } from '../ai/payloads.js';
import type { CategorizationRuleRef } from '../ai/rules.js';
import type { Suggestion, ConfirmedSuggestion } from '../lib/ai-guard.js';
import { audit } from '../lib/audit.js';
import { saveBuffer } from '../lib/storage.js';
import { config } from '../config.js';
import { intakeConfig } from './config.js';
import { resolveClient } from './identity.js';
import { matchExtraction, type MatchCandidate, type MatchResult } from './matcher.js';
import { composeConfirmation, queueAndSend, type ConfirmationPrompt } from './confirm.js';
import { adapterFor } from './channels/index.js';
import type { Channel, InboundAttachment, InboundMessage } from './channels/types.js';
import { resolveAutomationActor } from '../services/systemActor.js';
import { handleInboundReply } from './inboundReply.js';

/**
 * The categorisation question a receipt raises, phrased for a one-character
 * reply at the moment of context (§3). One prompt, one keystroke, in the
 * channel the client already has open.
 */
export const JOB_PROMPT: ConfirmationPrompt = { token: 'J', text: 'if this was for a job' };

export interface IngestOptions {
  /**
   * `document` runs the full hallway. `note` records provenance only — used
   * for a text reply, which is an inbound artefact but not a document.
   */
  readonly mode?: 'document' | 'note';
  /** Skip the confirmation loop (bulk backfills should not text 300 times). */
  readonly suppressConfirmation?: boolean;
  /** Pre-resolved client, for channels that authenticate the sender (PWA). */
  readonly clientId?: string | null;
}

export interface IngestResult {
  readonly intakeItemId: string;
  readonly clientId: string | null;
  readonly status: 'received' | 'quarantined' | 'processing' | 'needs_review' | 'filed' | 'discarded';
  /** True when this call found an existing item instead of creating one. */
  readonly duplicate: boolean;
  readonly quarantined: boolean;
  readonly quarantineReason: string | null;
  readonly extractionId: string | null;
  readonly extracted: ExtractedDocument | null;
  readonly match: MatchResult | null;
  readonly matchedTransactionId: string | null;
  readonly documentId: string | null;
  readonly outboundMessageId: string | null;
  readonly workItemId: string | null;
  readonly questionId: string | null;
}

/**
 * Field separator for composite hash and grouping keys. A control character
 * cannot occur in a vendor name or an identity, so `"AB" + "C"` can never
 * collide with `"A" + "BC"`.
 */
const SEP = '\u001f';

/** Postgres unique-violation. The idempotency race lands here. */
const UNIQUE_VIOLATION = '23505';

/* ========================================================================== */
/* Entry points                                                                */
/* ========================================================================== */

/**
 * Route an inbound message to the right handler.
 *
 * A text with no attachment, short enough to be an answer, and arriving from a
 * client with an open question, is a *reply* — "two-way is the point: a client
 * should be able to answer our open questions by replying to a text, not by
 * logging in" (§3). Everything else is a capture.
 */
export async function routeInbound(msg: InboundMessage, opts: IngestOptions = {}): Promise<IngestResult> {
  const hydrated = await hydrate(msg);
  const hasFile = hydrated.attachments.length > 0 || (hydrated.mediaRefs?.length ?? 0) > 0;
  const text = (hydrated.text ?? '').trim();

  if (!hasFile && text && text.length <= intakeConfig.replyMaxChars) {
    const resolved = opts.clientId
      ? { clientId: opts.clientId }
      : await resolveClient(hydrated.channel, hydrated.senderIdentity);

    if (resolved) {
      const reply = await handleInboundReply({
        clientId: resolved.clientId,
        channel: hydrated.channel,
        text,
        receivedAt: hydrated.receivedAt,
      });
      if (reply.answered) {
        // Record the inbound artefact for provenance, then acknowledge.
        const item = await ingest(hydrated, { ...opts, mode: 'note', suppressConfirmation: true });
        if (!item.duplicate && !opts.suppressConfirmation) {
          await queueAndSend({
            clientId: resolved.clientId,
            inboundChannel: hydrated.channel,
            body: 'Got it — thanks, that answer is on file.',
            purpose: 'question',
            relatedEntity: 'client_questions',
            relatedId: reply.questionId,
          });
        }
        return { ...item, questionId: reply.questionId };
      }
    }
  }

  return ingest(hydrated, opts);
}

/**
 * Run one inbound message through the whole hallway.
 *
 * Safe to call twice with the same message: the second call short-circuits on
 * the idempotency keys and returns the first call's item untouched.
 */
export async function ingest(msg: InboundMessage, opts: IngestOptions = {}): Promise<IngestResult> {
  const hydrated = await hydrate(msg);
  const channel = hydrated.channel;

  // ---- 1. Idempotency, part one: the provider's message id ----------------
  if (hydrated.externalId) {
    const existing = await db.query.intakeItems.findFirst({
      where: and(eq(intakeItems.channel, channel), eq(intakeItems.externalId, hydrated.externalId)),
    });
    if (existing) return duplicateOf(existing);
  }

  // ---- 2. Identity. Unknown sender → quarantine, never guessed ------------
  const resolved = opts.clientId
    ? { clientId: opts.clientId }
    : await resolveClient(channel, hydrated.senderIdentity);

  if (!resolved) {
    return quarantine(hydrated);
  }
  const clientId = resolved.clientId;

  // ---- 3. Store the original, immutably and encrypted --------------------
  const primary = pickPrimaryAttachment(hydrated);
  const stored = await storeOriginal(hydrated, primary);
  const contentHash = stored?.sha256 ?? textHash(hydrated);

  // ---- 1b. Idempotency, part two: the content hash ------------------------
  const byHash = await db.query.intakeItems.findFirst({
    where: and(eq(intakeItems.clientId, clientId), eq(intakeItems.contentHash, contentHash)),
  });
  if (byHash) return duplicateOf(byHash);

  // ---- 4. The intake item. Everything else hangs off this row -------------
  let item: typeof intakeItems.$inferSelect;
  try {
    const [created] = await db
      .insert(intakeItems)
      .values({
        clientId,
        channel,
        externalId: hydrated.externalId ?? null,
        senderIdentity: hydrated.senderIdentity,
        receivedAt: hydrated.receivedAt,
        rawPayload: toJsonb(hydrated.raw),
        storageKey: stored?.storedName ?? null,
        mime: primary?.mime ?? null,
        sizeBytes: stored?.sizeBytes ?? null,
        contentHash,
        status: 'processing',
      })
      .returning();
    item = created!;
  } catch (err) {
    // Two identical messages in flight at once. The index wins; we re-read.
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      const raced = await findExisting(channel, hydrated.externalId ?? null, clientId, contentHash);
      if (raced) return duplicateOf(raced);
    }
    throw err;
  }

  await audit(null, {
    action: 'intake.received',
    clientId,
    entity: 'intake_item',
    entityId: item.id,
    meta: {
      channel,
      externalId: hydrated.externalId ?? null,
      hasAttachment: Boolean(stored),
      contentHash,
    },
  });

  // A note (a text reply) is provenance only — no extraction, no filing.
  if (opts.mode === 'note') {
    await db
      .update(intakeItems)
      .set({ status: 'filed', processedAt: new Date() })
      .where(eq(intakeItems.id, item.id));
    return {
      ...emptyResult(item.id, clientId),
      status: 'filed',
    };
  }

  // ---- 5-6. Extract + classify -------------------------------------------
  const text = extractableText(hydrated, primary);
  if (!text) {
    return finishWithoutExtraction(item, clientId, hydrated, opts);
  }

  const actor = await resolveAutomationActor();
  let suggestion: Suggestion<ExtractedDocument>;
  try {
    suggestion = await extractDocument({
      clientId,
      userId: actor.id,
      text,
      filename: primary?.filename ?? null,
      mime: primary?.mime ?? null,
      intakeItemId: item.id,
    });
  } catch (err) {
    await audit(null, {
      action: 'intake.extract_failed',
      clientId,
      entity: 'intake_item',
      entityId: item.id,
      meta: { error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) },
    });
    return finishWithoutExtraction(item, clientId, hydrated, opts);
  }

  // Recording *what the model read* is attributed to the automation actor; it
  // is an append-only note, not a ledger write. Committing to the ledger below
  // is gated separately on confidence.
  const confirmed = confirmForRecord(suggestion, actor.id);
  const extracted = confirmed.value;

  const [extraction] = await db
    .insert(extractions)
    .values({
      intakeItemId: item.id,
      provider: confirmed.meta.provider,
      model: confirmed.meta.model,
      docType: extracted.docType,
      extracted: {
        vendor: extracted.vendor,
        date: extracted.date,
        totalCents: extracted.totalCents,
        taxCents: extracted.taxCents,
        lineItems: extracted.lineItems,
        reasoning: extracted.reasoning,
        needsHuman: extracted.needsHuman,
        recordedBy: confirmed.confirmedBy,
        recordedAt: confirmed.confirmedAt.toISOString(),
        overrodeLowConfidence: confirmed.overrodeLowConfidence,
      },
      confidence: confirmed.meta.confidence,
    })
    .returning();

  await audit(null, {
    action: 'intake.extracted',
    clientId,
    entity: 'extraction',
    entityId: extraction!.id,
    meta: {
      intakeItemId: item.id,
      docType: extracted.docType,
      confidence: confirmed.meta.confidence,
      needsHuman: suggestion.needsHuman,
      provider: confirmed.meta.provider,
    },
  });

  // ---- 7. Match to a transaction. Deterministic, no AI --------------------
  const match = await matchExtraction({
    clientId,
    amountCents: extracted.totalCents,
    date: extracted.date,
    vendor: extracted.vendor,
  });

  await audit(null, {
    action: 'intake.matched',
    clientId,
    entity: 'extraction',
    entityId: extraction!.id,
    meta: {
      candidates: match.candidates.length,
      best: match.best?.transactionId ?? null,
      confidence: match.best?.confidence ?? null,
      confident: match.confident,
      reasoning: match.reasoning,
    },
  });

  // ---- 8. Confident → file. Unsure → a person --------------------------
  const autoFile = match.confident && !suggestion.needsHuman;
  let documentId: string | null = null;
  let matchedTransactionId: string | null = null;
  let workItemId: string | null = null;
  let questionId: string | null = null;
  let account: { label: string | null; mask: string | null } | null = null;

  if (autoFile && match.best) {
    documentId = await fileDocument({
      clientId,
      actorId: actor.id,
      item,
      stored,
      primary,
      docType: extracted.docType,
      vendor: extracted.vendor,
    });

    await db.insert(txnMatches).values({
      extractionId: extraction!.id,
      transactionId: match.best.transactionId,
      confidence: match.best.confidence,
      // The matcher is arithmetic, not a model. Say so on the row.
      matchedBy: 'rule',
      confirmedAt: new Date(),
      confirmedBy: actor.id,
    });
    matchedTransactionId = match.best.transactionId;

    // The receipt exists now; stop chasing it.
    await db
      .update(transactions)
      .set({ needsReceipt: false })
      .where(eq(transactions.id, match.best.transactionId));

    await db
      .update(intakeItems)
      .set({ status: 'filed', documentId, processedAt: new Date() })
      .where(eq(intakeItems.id, item.id));

    account = await accountMaskFor(match.best.accountId);

    await audit(null, {
      action: 'intake.filed',
      clientId,
      entity: 'intake_item',
      entityId: item.id,
      meta: {
        documentId,
        transactionId: match.best.transactionId,
        confidence: match.best.confidence,
      },
    });

    // Close the categorisation question at the moment of context.
    const categorised = await categoriseMatch({
      clientId,
      actorId: actor.id,
      candidate: match.best,
    });
    questionId = categorised.questionId;
    workItemId = categorised.workItemId;
  } else {
    const reason = !suggestion.needsHuman
      ? match.reasoning
      : `Extraction confidence ${confirmed.meta.confidence} is below the threshold. ${match.reasoning}`;

    await db
      .update(intakeItems)
      .set({ status: 'needs_review', processedAt: new Date() })
      .where(eq(intakeItems.id, item.id));

    workItemId = await raiseWorkItem({
      clientId,
      kind: 'review',
      title: reviewTitle(extracted, match.best),
      detail: reason,
      priority: match.best ? 40 : 30,
      relatedEntity: 'intake_items',
      relatedId: item.id,
    });

    await audit(null, {
      action: 'intake.needs_review',
      clientId,
      entity: 'intake_item',
      entityId: item.id,
      meta: { workItemId, reason },
    });
  }

  // ---- 9. The confirmation loop ------------------------------------------
  let outboundMessageId: string | null = null;
  if (!opts.suppressConfirmation) {
    const body = composeConfirmation({
      vendor: extracted.vendor,
      amountCents: extracted.totalCents,
      account,
      unmatched: !autoFile,
      prompt: questionId ? JOB_PROMPT : null,
    });
    const queued = await queueAndSend({
      clientId,
      inboundChannel: channel,
      body,
      purpose: 'capture_confirmation',
      relatedEntity: 'intake_items',
      relatedId: item.id,
    });
    outboundMessageId = queued.id;
  }

  return {
    intakeItemId: item.id,
    clientId,
    status: autoFile ? 'filed' : 'needs_review',
    duplicate: false,
    quarantined: false,
    quarantineReason: null,
    extractionId: extraction!.id,
    extracted,
    match,
    matchedTransactionId,
    documentId,
    outboundMessageId,
    workItemId,
    questionId,
  };
}

/* ========================================================================== */
/* Steps                                                                       */
/* ========================================================================== */

async function hydrate(msg: InboundMessage): Promise<InboundMessage> {
  if (!msg.mediaRefs?.length) return msg;
  const adapter = adapterFor(msg.channel);
  if (!adapter.hydrate) return msg;
  try {
    return await adapter.hydrate(msg);
  } catch {
    // A media fetch failure must not lose the message; the text still lands and
    // the item goes to a human (§5: "let OCR fail gracefully to a human").
    return msg;
  }
}

/** Quarantine: an unrecognised sender is never attached to a client. */
async function quarantine(msg: InboundMessage): Promise<IngestResult> {
  const reason =
    `Unrecognised ${msg.channel} sender "${msg.senderIdentity || '(empty)'}" — ` +
    'no channel_identities row maps it to a client. Held for a human to claim; never guessed.';

  const [item] = await db
    .insert(intakeItems)
    .values({
      clientId: null,
      channel: msg.channel,
      externalId: msg.externalId ?? null,
      senderIdentity: msg.senderIdentity,
      receivedAt: msg.receivedAt,
      rawPayload: toJsonb(msg.raw),
      // The original bytes are deliberately NOT stored yet: we will not write a
      // client's encrypted object store on behalf of a sender we cannot name.
      // The raw payload keeps enough to re-fetch once a human claims the item.
      storageKey: null,
      mime: pickPrimaryAttachment(msg)?.mime ?? null,
      contentHash: null,
      status: 'quarantined',
      quarantineReason: reason,
    })
    .returning();

  await audit(null, {
    action: 'intake.quarantined',
    clientId: null,
    entity: 'intake_item',
    entityId: item!.id,
    meta: { channel: msg.channel, senderIdentity: msg.senderIdentity, reason },
  });

  return {
    ...emptyResult(item!.id, null),
    status: 'quarantined',
    quarantined: true,
    quarantineReason: reason,
  };
}

interface StoredOriginal {
  storedName: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * Write the original to encrypted storage. The portal channel is special: its
 * bytes are already stored by the upload route, so we reuse the object rather
 * than writing a second encrypted copy of the same file.
 */
async function storeOriginal(
  msg: InboundMessage,
  primary: InboundAttachment | null,
): Promise<StoredOriginal | null> {
  if (msg.channel === 'portal') {
    const raw = msg.raw as { storedName?: string; sha256?: string; sizeBytes?: number };
    if (raw?.storedName && raw.sha256) {
      return {
        storedName: raw.storedName,
        sha256: raw.sha256,
        sizeBytes: raw.sizeBytes ?? 0,
      };
    }
  }
  if (!primary) return null;
  if (primary.buffer.length > config.upload.maxBytes) return null;

  const saved = await saveBuffer(primary.buffer);
  return { storedName: saved.storedName, sha256: saved.sha256, sizeBytes: saved.sizeBytes };
}

/** Largest attachment wins — an MMS often carries a thumbnail alongside. */
function pickPrimaryAttachment(msg: InboundMessage): InboundAttachment | null {
  if (msg.attachments.length === 0) return null;
  return [...msg.attachments].sort((a, b) => b.buffer.length - a.buffer.length)[0] ?? null;
}

/** Content hash for a text-only item: stable, channel-scoped, sender-scoped. */
function textHash(msg: InboundMessage): string {
  return crypto
    .createHash('sha256')
    .update(msg.channel)
    .update(SEP)
    .update(msg.senderIdentity)
    .update(SEP)
    .update((msg.subject ?? '').trim())
    .update(SEP)
    .update((msg.text ?? '').trim())
    .digest('hex');
}

const TEXTUAL = /^(text\/|application\/(json|xml|csv))/i;

/**
 * What the extractor can actually read. Images are handed to the model as
 * whatever text came with them (an MMS caption, an email body); real OCR is a
 * provider concern and its absence must degrade to a human, not to a guess
 * (§5: "MMS image quality is often poor — let OCR fail gracefully").
 */
function extractableText(msg: InboundMessage, primary: InboundAttachment | null): string {
  const parts: string[] = [];
  if (msg.subject) parts.push(msg.subject);
  if (primary && TEXTUAL.test(primary.mime)) {
    parts.push(primary.buffer.toString('utf8').slice(0, 40_000));
  }
  if (msg.text) parts.push(msg.text);
  return parts.join('\n').trim();
}

/** Nothing readable arrived. Record it honestly and hand it to a person. */
async function finishWithoutExtraction(
  item: typeof intakeItems.$inferSelect,
  clientId: string,
  msg: InboundMessage,
  opts: IngestOptions,
): Promise<IngestResult> {
  await db
    .update(intakeItems)
    .set({ status: 'needs_review', processedAt: new Date() })
    .where(eq(intakeItems.id, item.id));

  const detail = item.storageKey
    ? 'The file arrived and is stored, but there was no readable text to extract from (image without OCR, or an unsupported type).'
    : 'Nothing readable arrived — no attachment and no usable text.';

  const workItemId = await raiseWorkItem({
    clientId,
    kind: 'review',
    title: `Unreadable ${msg.channel} capture needs filing by hand`,
    detail,
    priority: 35,
    relatedEntity: 'intake_items',
    relatedId: item.id,
  });

  await audit(null, {
    action: 'intake.needs_review',
    clientId,
    entity: 'intake_item',
    entityId: item.id,
    meta: { workItemId, reason: detail },
  });

  let outboundMessageId: string | null = null;
  if (!opts.suppressConfirmation) {
    const queued = await queueAndSend({
      clientId,
      inboundChannel: msg.channel,
      body: composeConfirmation({ vendor: null, amountCents: null, unreadable: true }),
      purpose: 'capture_confirmation',
      relatedEntity: 'intake_items',
      relatedId: item.id,
    });
    outboundMessageId = queued.id;
  }

  return { ...emptyResult(item.id, clientId), status: 'needs_review', workItemId, outboundMessageId };
}

/** Create the `documents` row an auto-filed capture becomes. */
async function fileDocument(input: {
  clientId: string;
  actorId: string;
  item: typeof intakeItems.$inferSelect;
  stored: StoredOriginal | null;
  primary: InboundAttachment | null;
  docType: string;
  vendor: string | null;
}): Promise<string | null> {
  if (!input.stored) return null;

  // The portal channel already has a documents row; don't create a second.
  const raw = input.item.rawPayload as { documentId?: string } | null;
  if (input.item.channel === 'portal' && raw?.documentId) return raw.documentId;

  const filename =
    input.primary?.filename ??
    `${input.vendor ? slug(input.vendor) : input.docType}-${input.item.receivedAt.toISOString().slice(0, 10)}`;

  const [doc] = await db
    .insert(documents)
    .values({
      clientId: input.clientId,
      uploadedBy: input.actorId,
      folder: folderFor(input.docType),
      filename: filename.slice(0, 300),
      storedName: input.stored.storedName,
      mime: (input.primary?.mime ?? 'application/octet-stream').slice(0, 200),
      sizeBytes: input.stored.sizeBytes,
      sha256: input.stored.sha256,
    })
    .returning();
  return doc!.id;
}

const FOLDER_BY_DOCTYPE: Readonly<Record<string, string>> = {
  receipt: 'Receipts',
  invoice: 'Receipts',
  bill: 'Receipts',
  statement: 'Bank statements',
  w9: 'Tax',
  contract: 'General',
};

function folderFor(docType: string): string {
  return FOLDER_BY_DOCTYPE[docType] ?? 'General';
}

/**
 * Suggest a category for the matched transaction, applying it only when the
 * decision is safe to make without a person: a deterministic rule hit, or a
 * model suggestion above the confidence threshold. Otherwise the client gets
 * the question, in-channel, while they still remember the charge.
 */
async function categoriseMatch(input: {
  clientId: string;
  actorId: string;
  candidate: MatchCandidate;
}): Promise<{ questionId: string | null; workItemId: string | null }> {
  if (input.candidate.categoryId) return { questionId: null, workItemId: null };

  const [cats, rules, priors] = await Promise.all([
    loadCategories(input.clientId),
    loadRules(input.clientId),
    loadPriorDecisions(input.clientId),
  ]);

  const suggestion = await suggestCategory({
    clientId: input.clientId,
    userId: input.actorId,
    transaction: {
      id: input.candidate.transactionId,
      clientId: input.clientId,
      postedAt: input.candidate.postedAt,
      description: input.candidate.description,
      counterparty: input.candidate.counterparty,
      amountCents: input.candidate.amountCents,
    },
    categories: cats,
    rules,
    priorDecisions: priors,
  });

  if (!suggestion.needsHuman && suggestion.value.categoryId) {
    const applied = suggestion.confirm(input.actorId);
    await db
      .update(transactions)
      .set({
        categoryId: applied.value.categoryId,
        categorizedBy: applied.value.source === 'rule' ? 'rule' : 'ai',
        categorizedById: input.actorId,
        categorizedAt: applied.confirmedAt,
        categoryConfidence: applied.meta.confidence,
      })
      .where(eq(transactions.id, input.candidate.transactionId));

    await audit(null, {
      action: 'intake.categorized',
      clientId: input.clientId,
      entity: 'transaction',
      entityId: input.candidate.transactionId,
      meta: {
        categoryId: applied.value.categoryId,
        source: applied.value.source,
        confidence: applied.meta.confidence,
      },
    });
    return { questionId: null, workItemId: null };
  }

  // Below the bar: ask, don't guess.
  const question =
    suggestion.value.suggestedQuestion ??
    `What was the ${input.candidate.description} charge on ${input.candidate.postedAt} for?`;

  const [row] = await db
    .insert(clientQuestions)
    .values({
      clientId: input.clientId,
      transactionId: input.candidate.transactionId,
      question,
      choices: ['Job materials', 'Shop supplies', 'Personal'],
      askedBy: input.actorId,
    })
    .returning();

  const workItemId = await raiseWorkItem({
    clientId: input.clientId,
    kind: 'answer',
    title: `Waiting on the client: ${question.slice(0, 120)}`,
    detail: suggestion.reasoning,
    priority: 25,
    relatedEntity: 'client_questions',
    relatedId: row!.id,
  });

  await audit(null, {
    action: 'intake.question_raised',
    clientId: input.clientId,
    entity: 'client_question',
    entityId: row!.id,
    meta: { transactionId: input.candidate.transactionId, confidence: suggestion.confidence },
  });

  return { questionId: row!.id, workItemId };
}

export async function loadCategories(clientId: string): Promise<CategoryRef[]> {
  const rows = await db.query.categories.findMany({
    where: and(
      or(eq(categoriesTable.clientId, clientId), isNull(categoriesTable.clientId)),
      isNull(categoriesTable.archivedAt),
    ),
  });
  return rows.map((c) => ({ id: c.id, clientId: c.clientId, name: c.name, kind: c.kind }));
}

export async function loadRules(clientId: string): Promise<CategorizationRuleRef[]> {
  const rows = await db.query.categorizationRules.findMany({
    where: and(
      or(eq(categorizationRules.clientId, clientId), isNull(categorizationRules.clientId)),
      isNull(categorizationRules.disabledAt),
    ),
  });
  return rows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    matchType: r.matchType,
    pattern: r.pattern,
    minAmountCents: r.minAmountCents,
    maxAmountCents: r.maxAmountCents,
    categoryId: r.categoryId,
    source: r.source,
    hitCount: r.hitCount,
    disabledAt: null,
  }));
}

/** Prior *human* decisions only — that is what makes them evidence. */
export async function loadPriorDecisions(clientId: string): Promise<PriorDecision[]> {
  const rows = await db
    .select({
      counterparty: transactions.counterparty,
      description: transactions.description,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.clientId, clientId),
        isNotNull(transactions.categoryId),
        eq(transactions.categorizedBy, 'human'),
      ),
    )
    .limit(2000);

  const names = new Map((await loadCategories(clientId)).map((c) => [c.id, c.name]));
  const grouped = new Map<string, PriorDecision>();
  for (const r of rows) {
    if (!r.categoryId) continue;
    const counterparty = (r.counterparty ?? r.description).trim();
    if (!counterparty) continue;
    const key = `${counterparty}${SEP}${r.categoryId}`;
    const existing = grouped.get(key);
    if (existing) {
      grouped.set(key, { ...existing, count: existing.count + 1 });
    } else {
      grouped.set(key, {
        counterparty,
        categoryId: r.categoryId,
        categoryName: names.get(r.categoryId) ?? 'Uncategorised',
        count: 1,
      });
    }
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count).slice(0, 200);
}

async function raiseWorkItem(input: {
  clientId: string;
  kind: 'categorize' | 'reconcile' | 'answer' | 'review' | 'chase' | 'quarantine' | 'close';
  title: string;
  detail: string;
  priority: number;
  relatedEntity: string;
  relatedId: string;
}): Promise<string> {
  // Idempotency: re-running the pipeline for the same entity must not stack
  // duplicate work on a bookkeeper's queue.
  const existing = await db.query.workItems.findFirst({
    where: and(
      eq(workItems.relatedEntity, input.relatedEntity),
      eq(workItems.relatedId, input.relatedId),
      eq(workItems.kind, input.kind),
      eq(workItems.status, 'open'),
    ),
  });
  if (existing) return existing.id;

  const [row] = await db
    .insert(workItems)
    .values({
      clientId: input.clientId,
      kind: input.kind,
      title: input.title.slice(0, 300),
      detail: input.detail.slice(0, 4000),
      priority: input.priority,
      relatedEntity: input.relatedEntity,
      relatedId: input.relatedId,
    })
    .returning();
  return row!.id;
}

/** Last-4 only. The full number is never in the database to begin with. */
async function accountMaskFor(accountId: string): Promise<{ label: string | null; mask: string | null } | null> {
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
  if (!account) return null;
  return { label: account.institution ?? account.name, mask: account.mask };
}

/* ========================================================================== */
/* Small helpers                                                               */
/* ========================================================================== */

/**
 * Record a suggestion, attributed to the automation actor.
 *
 * A low-confidence suggestion is still *recorded* — `extractions` is an
 * append-only log of what the model read, and losing it would make the review
 * queue useless. The acknowledgement is explicit and lands on the row
 * (`overrodeLowConfidence`), and the ledger writes that follow are gated
 * separately on confidence, so nothing is quietly committed.
 */
function confirmForRecord<T>(suggestion: Suggestion<T>, actorId: string): ConfirmedSuggestion<T> {
  return suggestion.needsHuman
    ? suggestion.confirm(actorId, { acknowledgeLowConfidence: true })
    : suggestion.confirm(actorId);
}

function reviewTitle(extracted: ExtractedDocument, best: MatchCandidate | null): string {
  const vendor = extracted.vendor ?? 'Unknown vendor';
  const amount =
    extracted.totalCents === null ? 'amount unread' : `$${(Math.abs(extracted.totalCents) / 100).toFixed(2)}`;
  return best
    ? `Confirm ${vendor} ${amount} against ${best.postedAt} ${best.description}`
    : `File ${vendor} ${amount} — no transaction matched`;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'capture';
}

/** jsonb columns reject `undefined`; normalise through JSON. */
function toJsonb(raw: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(raw ?? null));
  } catch {
    return { unserializable: true };
  }
}

async function findExisting(
  channel: Channel,
  externalId: string | null,
  clientId: string,
  contentHash: string,
): Promise<typeof intakeItems.$inferSelect | undefined> {
  if (externalId) {
    const byExternal = await db.query.intakeItems.findFirst({
      where: and(eq(intakeItems.channel, channel), eq(intakeItems.externalId, externalId)),
    });
    if (byExternal) return byExternal;
  }
  return db.query.intakeItems.findFirst({
    where: and(eq(intakeItems.clientId, clientId), eq(intakeItems.contentHash, contentHash)),
  });
}

function duplicateOf(item: typeof intakeItems.$inferSelect): IngestResult {
  return {
    ...emptyResult(item.id, item.clientId),
    status: item.status,
    duplicate: true,
    quarantined: item.status === 'quarantined',
    quarantineReason: item.quarantineReason,
    documentId: item.documentId,
  };
}

function emptyResult(intakeItemId: string, clientId: string | null): IngestResult {
  return {
    intakeItemId,
    clientId,
    status: 'received',
    duplicate: false,
    quarantined: false,
    quarantineReason: null,
    extractionId: null,
    extracted: null,
    match: null,
    matchedTransactionId: null,
    documentId: null,
    outboundMessageId: null,
    workItemId: null,
    questionId: null,
  };
}
