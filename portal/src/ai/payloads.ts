/**
 * The wire contract between a task module and a provider.
 *
 * A task builds a `*Payload`, the provider (real or stub) returns a `*Model`
 * shape, and the task validates it into its own public output type. Keeping
 * these in one file means the deterministic stub and the real providers are
 * held to exactly the same contract, and a change to one fails to compile
 * against the other.
 *
 * Everything here is plain data. Nothing in this file — or anything that
 * imports it — touches the database.
 */

/* --------------------------------- extract -------------------------------- */

export type DocType = 'receipt' | 'invoice' | 'bill' | 'statement' | 'w9' | 'contract' | 'other' | 'unknown';

export interface ExtractPayload {
  readonly clientId: string;
  readonly filename: string | null;
  readonly mime: string | null;
  /** OCR or plain text of the document. Never a file path or a storage key. */
  readonly text: string;
}

export interface LineItemModel {
  readonly description: string;
  readonly quantity: number | null;
  readonly amountCents: number | null;
}

export interface ExtractModel {
  readonly docType: DocType;
  readonly vendor: string | null;
  readonly date: string | null;
  readonly totalCents: number | null;
  readonly taxCents: number | null;
  readonly lineItems: readonly LineItemModel[];
  readonly confidence: number;
  readonly reasoning: string;
}

/* ------------------------------- categorize ------------------------------- */

export interface CategoryRef {
  readonly id: string;
  /** Null for a firm-wide default category (src/db/schema.ts categories). */
  readonly clientId: string | null;
  readonly name: string;
  readonly kind: 'income' | 'cogs' | 'expense' | 'asset' | 'liability' | 'equity';
}

export interface TransactionRef {
  readonly id: string;
  readonly clientId: string;
  readonly postedAt: string;
  readonly description: string;
  readonly counterparty: string | null;
  readonly amountCents: number;
}

/** A prior human decision for this client — the strongest evidence there is. */
export interface PriorDecision {
  readonly counterparty: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly count: number;
}

export interface CategorizePayload {
  readonly clientId: string;
  readonly transaction: TransactionRef;
  readonly categories: readonly CategoryRef[];
  readonly priorDecisions: readonly PriorDecision[];
  readonly businessType: string | null;
}

export interface CategorizeModel {
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly confidence: number;
  readonly reasoning: string;
  /** Set when the vendor is genuinely ambiguous for this client's business. */
  readonly ambiguous?: boolean;
  /** A question worth asking the client, when the model cannot resolve it. */
  readonly suggestedQuestion?: string | null;
}

/* -------------------------------- narrative ------------------------------- */

export interface PeriodRef {
  readonly start: string;
  readonly end: string;
  readonly label: string;
}

export interface NarrativeFigures {
  readonly revenueCents: number;
  readonly priorRevenueCents: number | null;
  readonly expensesCents: number;
  readonly priorExpensesCents: number | null;
  readonly netCents: number;
  readonly priorNetCents: number | null;
  readonly cashOnHandCents: number | null;
  readonly receivablesCents: number | null;
  readonly payablesCents: number | null;
}

export interface CategoryMovement {
  readonly name: string;
  readonly amountCents: number;
  readonly priorAmountCents: number | null;
}

export interface NarrativeDriver {
  readonly label: string;
  readonly detail: string;
  readonly amountCents: number | null;
}

export interface NarrativePayload {
  readonly clientId: string;
  readonly businessName: string;
  readonly period: PeriodRef;
  readonly figures: NarrativeFigures;
  readonly topCategories: readonly CategoryMovement[];
  readonly drivers: readonly NarrativeDriver[];
  readonly watchItems: readonly string[];
}

export interface NarrativeModel {
  readonly narrative: string;
  readonly highlights: readonly string[];
  readonly watchItems: readonly string[];
  readonly confidence: number;
  readonly reasoning: string;
}

/* ------------------------------- reply_draft ------------------------------ */

export interface ReplyContextItem {
  readonly label: string;
  readonly value: string;
}

export interface ReplyPayload {
  readonly clientId: string;
  readonly clientName: string | null;
  readonly clientMessage: string;
  readonly threadSummary: string | null;
  /** Grounding facts. The draft may not state anything that is not in here. */
  readonly context: readonly ReplyContextItem[];
  readonly openQuestions: readonly string[];
}

export interface ReplyModel {
  readonly reply: string;
  readonly confidence: number;
  readonly reasoning: string;
  readonly deflected: boolean;
  readonly deflectionReason: string | null;
  /** Facts from context the draft actually leaned on. */
  readonly grounding: readonly string[];
}

/* --------------------------------- anomaly -------------------------------- */

export type AnomalyKind =
  | 'duplicate_payment'
  | 'price_increase'
  | 'unusual_amount'
  | 'new_vendor'
  | 'slow_paying_customer'
  | 'missing_deposit'
  | 'other';

export type Severity = 'low' | 'medium' | 'high';

export interface AnomalyPayload {
  readonly clientId: string;
  readonly period: PeriodRef | null;
  readonly transactions: readonly TransactionRef[];
}

export interface AnomalyModel {
  readonly kind: AnomalyKind;
  readonly severity: Severity;
  readonly summary: string;
  readonly detail: string;
  readonly transactionIds: readonly string[];
  readonly confidence: number;
  readonly reasoning: string;
}

export interface AnomalyResultModel {
  readonly anomalies: readonly AnomalyModel[];
  readonly confidence: number;
  readonly reasoning: string;
}

/* ----------------------------- precedent_search --------------------------- */

export interface PrecedentRef {
  readonly id: string;
  /** Null = firm-wide precedent, available to every client. */
  readonly clientId: string | null;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly industry: string | null;
  readonly createdAt: string | null;
}

export interface PrecedentPayload {
  readonly clientId: string;
  readonly query: string;
  readonly industry: string | null;
  readonly precedents: readonly PrecedentRef[];
  readonly limit: number;
}

export interface PrecedentMatchModel {
  readonly precedentId: string;
  readonly title: string;
  readonly score: number;
  readonly whyMatched: string;
  readonly snippet: string;
}

export interface PrecedentResultModel {
  readonly matches: readonly PrecedentMatchModel[];
  readonly confidence: number;
  readonly reasoning: string;
}

/* -------------------------------- preflight ------------------------------- */

export interface PreflightFacts {
  readonly totalTransactions: number;
  readonly uncategorizedCount: number;
  readonly unreconciledAccounts: readonly { name: string; varianceCents: number }[];
  readonly negativeBalances: readonly { name: string; balanceCents: number }[];
  readonly missingDocuments: readonly { label: string; amountCents: number | null }[];
  readonly unansweredQuestions: number;
  readonly openAnomalies: number;
  readonly periodSwings: readonly {
    category: string;
    amountCents: number;
    priorAmountCents: number;
  }[];
}

export interface PreflightPayload {
  readonly clientId: string;
  readonly closePeriodId: string;
  readonly period: PeriodRef;
  readonly facts: PreflightFacts;
}

export interface CheckModel {
  readonly code: string;
  readonly label: string;
  readonly severity: 'info' | 'warn' | 'block';
  readonly passed: boolean;
  readonly detail: string;
}

export interface PreflightResultModel {
  readonly checks: readonly CheckModel[];
  readonly confidence: number;
  readonly reasoning: string;
}

/* -------------------------------- reconcile ------------------------------- */

export interface ReconcilePayload {
  readonly clientId: string;
  readonly accountName: string;
  readonly statementBalanceCents: number;
  readonly ledgerBalanceCents: number;
  readonly openItems: readonly TransactionRef[];
}

export interface ReconcileModel {
  readonly varianceCents: number;
  readonly explanation: string;
  readonly candidateTransactionIds: readonly string[];
  readonly confidence: number;
  readonly reasoning: string;
}
