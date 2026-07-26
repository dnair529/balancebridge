/**
 * Two-way, which is the whole point (OMNICHANNEL-CAPTURE.md §3):
 *
 * > "A client should be able to answer our open questions **by replying to a
 * > text**, not by logging in."
 *
 * A reply is matched to the client's **most recent open question**, and only
 * to that one. No fuzzy matching across a backlog, no "which of your four open
 * questions did you mean" — the question we just asked in this channel is the
 * one being answered, and if it is not, a bookkeeper sorts it out. Wrong
 * attribution of an answer is the same class of error as wrong attribution of
 * a document.
 *
 * The answer is recorded, the question is closed, and — because a one-word
 * answer usually still needs a person to act on it — a work item is raised so
 * the categorisation actually happens.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { clientQuestions, transactions, workItems } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { intakeConfig } from './config.js';
import type { Channel } from './channels/types.js';

export interface InboundReplyInput {
  readonly clientId: string;
  readonly channel: Channel;
  readonly text: string;
  readonly receivedAt?: Date;
  /** Answer a specific question (portal UI). Defaults to the most recent open one. */
  readonly questionId?: string | null;
}

export interface InboundReplyResult {
  readonly answered: boolean;
  readonly questionId: string | null;
  readonly transactionId: string | null;
  readonly answer: string | null;
  /** The choice the reply resolved to, when the question offered choices. */
  readonly matchedChoice: string | null;
  readonly workItemId: string | null;
  readonly reason: string;
}

/** `client_questions.answered_via` only accepts these. */
const VIA: Readonly<Record<string, 'portal' | 'sms' | 'whatsapp' | 'email' | 'staff'>> = {
  sms: 'sms',
  whatsapp: 'whatsapp',
  email: 'email',
  portal: 'portal',
  pwa: 'portal',
  voice: 'sms',
  cloud_folder: 'portal',
  bank_feed: 'portal',
};

export async function handleInboundReply(input: InboundReplyInput): Promise<InboundReplyResult> {
  const answer = input.text.trim();
  if (!answer) {
    return none('empty reply');
  }
  if (answer.length > intakeConfig.replyMaxChars) {
    return none(`reply is ${answer.length} characters — too long to be an answer to a question`);
  }
  if (!looksLikeAnswer(answer)) {
    return none('the message reads as a greeting or a new question, not an answer to ours');
  }

  const question = input.questionId
    ? await db.query.clientQuestions.findFirst({
        where: and(
          eq(clientQuestions.id, input.questionId),
          eq(clientQuestions.clientId, input.clientId),
          isNull(clientQuestions.answeredAt),
        ),
      })
    : await db.query.clientQuestions.findFirst({
        where: and(
          eq(clientQuestions.clientId, input.clientId),
          isNull(clientQuestions.answeredAt),
        ),
        orderBy: [desc(clientQuestions.createdAt)],
      });

  if (!question) {
    return none('no open question for this client — treating the message as a capture instead');
  }

  const choices = Array.isArray(question.choices) ? (question.choices as unknown[]).map(String) : [];
  const matchedChoice = resolveChoice(answer, choices);

  await db
    .update(clientQuestions)
    .set({
      answer: matchedChoice ? `${answer} (${matchedChoice})` : answer,
      answeredAt: input.receivedAt ?? new Date(),
      answeredVia: VIA[input.channel] ?? 'portal',
    })
    .where(eq(clientQuestions.id, question.id));

  // The client has told us what it was; a bookkeeper still has to post it.
  const workItemId = await raiseCategorisation({
    clientId: input.clientId,
    questionId: question.id,
    transactionId: question.transactionId,
    question: question.question,
    answer: matchedChoice ?? answer,
  });

  await audit(null, {
    action: 'intake.question_answered',
    clientId: input.clientId,
    entity: 'client_question',
    entityId: question.id,
    meta: {
      via: VIA[input.channel] ?? 'portal',
      transactionId: question.transactionId,
      matchedChoice,
      workItemId,
    },
  });

  return {
    answered: true,
    questionId: question.id,
    transactionId: question.transactionId,
    answer,
    matchedChoice,
    workItemId,
    reason: matchedChoice
      ? `Matched the reply to the offered choice "${matchedChoice}".`
      : 'Recorded the reply verbatim against the most recent open question.',
  };
}

/** Greetings and acknowledgements. Not answers; closing a question on one is a bug. */
const NOT_AN_ANSWER = new Set([
  'hi', 'hey', 'hello', 'thanks', 'thank you', 'thx', 'ty', 'ok', 'okay', 'k', 'cool',
  'got it', 'sure', 'np', 'sounds good', 'morning', 'good morning', 'afternoon',
]);

const INTERROGATIVE = /^(who|what|when|where|why|how|can|could|would|will|do|does|did|is|are|should|any)\b/i;

/**
 * A cheap, explainable guard against the one failure mode that matters here:
 * closing an open question with a message that was never an answer to it.
 *
 * A client texting "can you send me the P&L?" must not silently resolve
 * "what was the Home Depot charge for?" — it becomes a capture instead, and a
 * bookkeeper sees it. Deliberately conservative and deterministic: two closed
 * lists, no inference.
 */
export function looksLikeAnswer(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, '');
  if (!t) return false;
  if (NOT_AN_ANSWER.has(t)) return false;
  if (t.endsWith('?')) return false;
  // "Do you need the receipt too?" is a question; "Do it" is not — but the
  // interrogative test only fires alongside a question mark or a bare opener.
  if (INTERROGATIVE.test(t) && t.split(/\s+/).length > 2) return false;
  return true;
}

/**
 * Resolve a short reply to one of the offered choices.
 *
 * Three ways, strictest first: the whole choice, its first letter (the
 * "Reply **J**" convention), or a distinctive word from it. Ambiguity — a
 * letter that fits two choices — resolves to nothing rather than to a coin
 * flip; the verbatim answer is still recorded either way.
 */
export function resolveChoice(reply: string, choices: readonly string[]): string | null {
  if (choices.length === 0) return null;
  const norm = reply.trim().toLowerCase().replace(/[.!,]+$/, '');
  if (!norm) return null;

  const exact = choices.filter((c) => c.toLowerCase() === norm);
  if (exact.length === 1) return exact[0]!;

  if (norm.length === 1) {
    const initial = choices.filter((c) => c[0]?.toLowerCase() === norm);
    return initial.length === 1 ? initial[0]! : null;
  }

  const contains = choices.filter(
    (c) => c.toLowerCase().includes(norm) || norm.includes(c.toLowerCase()),
  );
  if (contains.length === 1) return contains[0]!;

  // Word overlap, e.g. "it was for the johnson job" → "Job materials".
  const words = new Set(norm.split(/\W+/).filter((w) => w.length > 2));
  const scored = choices
    .map((c) => ({
      choice: c,
      hits: c
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 2 && words.has(w)).length,
    }))
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits);

  if (scored.length === 1) return scored[0]!.choice;
  if (scored.length > 1 && scored[0]!.hits > scored[1]!.hits) return scored[0]!.choice;
  return null;
}

async function raiseCategorisation(input: {
  clientId: string;
  questionId: string;
  transactionId: string | null;
  question: string;
  answer: string;
}): Promise<string | null> {
  if (!input.transactionId) return null;

  const txn = await db.query.transactions.findFirst({
    where: eq(transactions.id, input.transactionId),
  });
  // Already categorised by a human since we asked — nothing left to do.
  if (txn?.categoryId && txn.categorizedBy === 'human') return null;

  const existing = await db.query.workItems.findFirst({
    where: and(
      eq(workItems.relatedEntity, 'client_questions'),
      eq(workItems.relatedId, input.questionId),
      eq(workItems.kind, 'categorize'),
      eq(workItems.status, 'open'),
    ),
  });
  if (existing) return existing.id;

  const [row] = await db
    .insert(workItems)
    .values({
      clientId: input.clientId,
      kind: 'categorize',
      title: `Client answered: "${input.answer}" — post it`.slice(0, 300),
      detail: `Question: ${input.question}\nAnswer: ${input.answer}`.slice(0, 4000),
      // The client is waiting on this one; it jumps the general queue.
      priority: 60,
      relatedEntity: 'client_questions',
      relatedId: input.questionId,
    })
    .returning();

  // Close the "waiting on the client" item now the client has replied.
  await db
    .update(workItems)
    .set({ status: 'done', completedAt: new Date() })
    .where(
      and(
        eq(workItems.relatedEntity, 'client_questions'),
        eq(workItems.relatedId, input.questionId),
        eq(workItems.kind, 'answer'),
        eq(workItems.status, 'open'),
      ),
    );

  return row!.id;
}

function none(reason: string): InboundReplyResult {
  return {
    answered: false,
    questionId: null,
    transactionId: null,
    answer: null,
    matchedChoice: null,
    workItemId: null,
    reason,
  };
}
