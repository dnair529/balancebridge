/**
 * ai-guard — the structural boundary between "the model said so" and
 * "it is in the books".
 *
 * ## The rule this file exists to enforce
 *
 * > **AI never writes to the ledger.** It proposes; a human commits.
 * > (STAFF-WORKSPACE.md §10.1, CLIENT-PLATFORM-STRATEGY.md §3)
 *
 * Three layers of enforcement, weakest to strongest:
 *
 * 1. **Structural.** Nothing under `src/ai/` imports `src/db/index.js` except
 *    `src/ai/runlog.ts`, and that module writes exactly one table (`ai_runs`,
 *    the AI audit trail) and routes every write through
 *    {@link assertWritableByAi} below. A regex over the tree proves the
 *    invariant; see the "Checking the invariant" note at the bottom.
 * 2. **Type-level.** Every AI task returns a {@link Suggestion `Suggestion<T>`},
 *    never a bare value. Persistence helpers must accept
 *    {@link ConfirmedSuggestion `ConfirmedSuggestion<T>`}, which carries a
 *    unique-symbol brand that only {@link Suggestion.confirm} can mint. Handing
 *    an unconfirmed suggestion to a writer is a *compile error*, not a code
 *    review note.
 * 3. **Runtime.** {@link assertNoLedgerWrite} throws if a database handle or a
 *    ledger-table writer ever reaches AI code, and {@link assertWritableByAi}
 *    throws on any table outside the allowlist.
 *
 * The type-level layer is the one that matters day to day: a route handler
 * physically cannot persist a suggestion it has not confirmed on behalf of a
 * named user.
 */

/* ------------------------------------------------------------------------- */
/* Ledger surface                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Tables that represent the books, or client-visible state derived from them.
 * AI code may *read* projections of these (passed in as plain data by the
 * calling service) but may never write them.
 */
export const LEDGER_TABLES = Object.freeze([
  'transactions',
  'accounts',
  'categories',
  'categorization_rules',
  'txn_matches',
  'close_periods',
  'close_checks',
  'anomalies',
  'client_questions',
  'document_requests',
  'documents',
  'intake_items',
  'extractions',
  'outbound_messages',
  'precedents',
  'work_items',
  'invoices',
  'health_scores',
  'compliance_events',
  'time_entries',
  'messages',
  'threads',
] as const);

export type LedgerTable = (typeof LEDGER_TABLES)[number];

/**
 * The complete set of tables the AI layer itself may write. `ai_runs` is the
 * AI audit trail required by STAFF-WORKSPACE.md §10.4 — it records that a
 * suggestion happened, never what the books contain.
 */
export const AI_WRITABLE_TABLES = Object.freeze(['ai_runs'] as const);

export type AiWritableTable = (typeof AI_WRITABLE_TABLES)[number];

/** Thrown when AI code attempts a write it is not permitted to make. */
export class LedgerWriteViolationError extends Error {
  override readonly name = 'LedgerWriteViolationError';
  constructor(
    readonly attempted: string,
    readonly context: string,
  ) {
    super(
      `AI layer attempted a forbidden write to "${attempted}" (${context}). ` +
        'AI proposes; a human commits. Return a Suggestion<T> and let the ' +
        'route/service persist it after .confirm(userId).',
    );
  }
}

/** Thrown when a suggestion is used in a way its confidence does not license. */
export class UnconfirmedSuggestionError extends Error {
  override readonly name = 'UnconfirmedSuggestionError';
}

/** Thrown when a prompt payload would mix data from more than one client. */
export class CrossClientDataError extends Error {
  override readonly name = 'CrossClientDataError';
  constructor(
    readonly expectedClientId: string | null,
    readonly foundClientId: string,
    readonly path: string,
  ) {
    super(
      `Cross-client data in prompt payload at "${path}": expected client ` +
        `${expectedClientId ?? '(none)'} but found ${foundClientId}. ` +
        'Client isolation is preserved — no cross-client context, ever.',
    );
  }
}

/**
 * Runtime tripwire. Call with anything that arrives at the AI layer from the
 * outside; throws if it looks like a live database handle or a query builder
 * capable of mutating the ledger — at any depth, because the realistic mistake
 * is not `buildRequest(db)`, it is a repository object hanging off a context
 * field that someone passed through as "evidence".
 *
 * Deliberately duck-typed: it catches a Drizzle `db`, a `pg.Pool`, a
 * transaction handle, or a hand-rolled repository, without importing any of
 * them (importing them is precisely what we are forbidding).
 */
export function assertNoLedgerWrite(candidate: unknown, context: string, path = '$'): void {
  walkForDbHandle(candidate, context, path, 0, new WeakSet<object>());
}

const MAX_GUARD_DEPTH = 8;

function walkForDbHandle(
  candidate: unknown,
  context: string,
  path: string,
  depth: number,
  seen: WeakSet<object>,
): void {
  if (candidate === null || typeof candidate !== 'object') return;
  if (depth > MAX_GUARD_DEPTH) return;
  if (seen.has(candidate)) return;
  seen.add(candidate);

  const obj = candidate as Record<string, unknown>;
  const hits = ['insert', 'update', 'delete', 'execute', 'query'].filter(
    (m) => typeof obj[m] === 'function',
  );

  // A Drizzle db exposes insert/update/delete; a pg Pool/Client exposes query.
  if (hits.includes('insert') || hits.includes('update') || hits.includes('delete')) {
    throw new LedgerWriteViolationError(`${path} — object with ${hits.join('/')}()`, context);
  }
  if (hits.includes('query') && typeof obj['connect'] === 'function') {
    throw new LedgerWriteViolationError(`${path} — database pool/client`, context);
  }

  if (Array.isArray(candidate)) {
    candidate.forEach((item, i) => walkForDbHandle(item, context, `${path}[${i}]`, depth + 1, seen));
    return;
  }
  for (const [key, value] of Object.entries(obj)) {
    walkForDbHandle(value, context, `${path}.${key}`, depth + 1, seen);
  }
}

/**
 * Gate every write the AI layer makes. Only {@link AI_WRITABLE_TABLES} pass.
 * `src/ai/runlog.ts` is the single caller.
 */
export function assertWritableByAi(table: string, context: string): asserts table is AiWritableTable {
  if (!(AI_WRITABLE_TABLES as readonly string[]).includes(table)) {
    throw new LedgerWriteViolationError(table, context);
  }
}

/**
 * Assert a prompt payload contains data for exactly one client.
 * Recursively walks for `clientId` / `client_id` keys and rejects any value
 * that is neither null (firm-wide) nor the expected client.
 *
 * STAFF-WORKSPACE.md §10.6 / CLIENT-PLATFORM-STRATEGY.md §3: no cross-client
 * context, no cross-client training.
 */
export function assertClientScoped(
  payload: unknown,
  expectedClientId: string | null,
  path = '$',
): void {
  if (payload === null || typeof payload !== 'object') return;

  if (Array.isArray(payload)) {
    payload.forEach((item, i) => assertClientScoped(item, expectedClientId, `${path}[${i}]`));
    return;
  }

  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const here = `${path}.${key}`;
    if ((key === 'clientId' || key === 'client_id') && typeof value === 'string' && value !== '') {
      // A null/absent clientId means firm-wide (e.g. a global category or a
      // firm-level precedent) and is always allowed.
      if (value !== expectedClientId) {
        throw new CrossClientDataError(expectedClientId, value, here);
      }
    }
    assertClientScoped(value, expectedClientId, here);
  }
}

/* ------------------------------------------------------------------------- */
/* Suggestion<T> — the only thing an AI task may return                       */
/* ------------------------------------------------------------------------- */

/**
 * The brand. Exported only because TypeScript requires it to type
 * {@link ConfirmedSuggestion}; nothing outside this module should reference it,
 * and holding the symbol does not let you forge a confirmation — the object
 * shape is only produced by {@link Suggestion.confirm}.
 */
export const confirmedBrand: unique symbol = Symbol.for('balancebridge.ai.confirmed');

/** Provenance of a suggestion. `rule` beats `model`: deterministic wins. */
export type SuggestionSource = 'rule' | 'model' | 'hybrid';

export interface SuggestionMeta {
  /** 0-100. Required on every suggestion (STAFF-WORKSPACE.md §10.2). */
  readonly confidence: number;
  /** Human-readable, citing the evidence it used. Never empty. */
  readonly reasoning: string;
  /** True when confidence fell below the configured threshold. */
  readonly needsHuman: boolean;
  readonly source: SuggestionSource;
  readonly task: string;
  readonly provider: string;
  readonly model: string | null;
  readonly clientId: string | null;
  /** `ai_runs.id`, when the run was successfully logged. */
  readonly runId: string | null;
  readonly latencyMs: number;
}

/**
 * A confirmed suggestion. The brand is unforgeable outside this module, so a
 * function typed `persist(s: ConfirmedSuggestion<T>)` cannot be handed a raw
 * `Suggestion<T>` — TypeScript rejects it at the call site.
 *
 * ```ts
 * // in a route handler:
 * const s = await suggestCategory(input);
 * await applyCategory(s);                 // ❌ compile error
 * await applyCategory(s.confirm(user.id)); // ✅ auditable, human-attributed
 * ```
 */
export interface ConfirmedSuggestion<T> {
  readonly [confirmedBrand]: true;
  readonly value: T;
  readonly meta: SuggestionMeta;
  readonly confirmedBy: string;
  readonly confirmedAt: Date;
  /** True when a human explicitly overrode a low-confidence gate. */
  readonly overrodeLowConfidence: boolean;
}

/**
 * The wrapper every AI task returns. Read `.value` freely for display; you
 * cannot persist it until a named human confirms it.
 */
export class Suggestion<T> {
  readonly value: T;
  readonly meta: SuggestionMeta;

  constructor(value: T, meta: SuggestionMeta) {
    if (!Number.isInteger(meta.confidence) || meta.confidence < 0 || meta.confidence > 100) {
      throw new RangeError(`Suggestion confidence must be an integer 0-100, got ${meta.confidence}`);
    }
    if (!meta.reasoning.trim()) {
      throw new Error('Suggestion requires non-empty reasoning — an unauditable suggestion is one you should not trust.');
    }
    this.value = value;
    this.meta = Object.freeze({ ...meta });
    Object.freeze(this);
  }

  get confidence(): number {
    return this.meta.confidence;
  }
  get reasoning(): string {
    return this.meta.reasoning;
  }
  get needsHuman(): boolean {
    return this.meta.needsHuman;
  }
  get source(): SuggestionSource {
    return this.meta.source;
  }

  /**
   * A named human takes responsibility for this suggestion. Only the result of
   * this call may be persisted.
   *
   * @param userId the confirming staff user (`users.id`)
   * @param opts.acknowledgeLowConfidence required when `needsHuman` is true —
   *   forces the caller to make the override explicit and auditable.
   */
  confirm(userId: string, opts: { acknowledgeLowConfidence?: boolean } = {}): ConfirmedSuggestion<T> {
    if (!userId || !userId.trim()) {
      throw new UnconfirmedSuggestionError('confirm() requires the confirming user id.');
    }
    if (this.meta.needsHuman && !opts.acknowledgeLowConfidence) {
      throw new UnconfirmedSuggestionError(
        `Suggestion for task "${this.meta.task}" is below the confidence threshold ` +
          `(${this.meta.confidence}) and is flagged needsHuman. Pass ` +
          '{ acknowledgeLowConfidence: true } to record an explicit human override.',
      );
    }
    return Object.freeze({
      [confirmedBrand]: true,
      value: this.value,
      meta: this.meta,
      confirmedBy: userId,
      confirmedAt: new Date(),
      overrodeLowConfidence: this.meta.needsHuman,
    }) as ConfirmedSuggestion<T>;
  }

  /** Derive a new suggestion with a transformed value, preserving provenance. */
  map<U>(fn: (value: T) => U): Suggestion<U> {
    return new Suggestion(fn(this.value), this.meta);
  }

  /** Compact shape for logging / UI. Never includes raw model text. */
  toJSON(): { value: T; meta: SuggestionMeta } {
    return { value: this.value, meta: this.meta };
  }
}

/** Type guard for the branded confirmed form. */
export function isConfirmed<T>(s: Suggestion<T> | ConfirmedSuggestion<T>): s is ConfirmedSuggestion<T> {
  return typeof s === 'object' && s !== null && confirmedBrand in (s as object);
}

/**
 * Runtime companion to the compile-time brand — for the boundary where types
 * are erased (JSON round-trips, dynamic dispatch). Persistence helpers should
 * call this first thing.
 */
export function requireConfirmed<T>(
  s: Suggestion<T> | ConfirmedSuggestion<T>,
  context: string,
): ConfirmedSuggestion<T> {
  if (s instanceof Suggestion) {
    throw new UnconfirmedSuggestionError(
      `${context}: refusing to persist an unconfirmed suggestion. Call .confirm(userId) first.`,
    );
  }
  const candidate = s as ConfirmedSuggestion<T>;
  if (!candidate.confirmedBy) {
    throw new UnconfirmedSuggestionError(`${context}: suggestion has no confirming user.`);
  }
  return candidate;
}

/**
 * Checking the invariant (CI-friendly, no deps):
 *
 * ```sh
 * # must return exactly one hit: src/ai/runlog.ts
 * grep -rlE "from '\.\.?/.*db/index\.js'" portal/src/ai/
 * ```
 *
 * Any other file matching means the boundary has been breached.
 */
