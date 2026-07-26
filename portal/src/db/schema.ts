import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  bigserial,
  date,
  inet,
  jsonb,
  customType,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

/** Case-insensitive email column (requires `CREATE EXTENSION citext`). */
const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessName: text('business_name').notNull(),
  contactName: text('contact_name'),
  email: text('email'),
  phone: text('phone'),
  status: text('status').notNull().default('active'),
  stripeCustomerId: text('stripe_customer_id'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // null client_id = staff/admin (firm-side user)
  clientId: uuid('client_id').references(() => clients.id),
  email: citext('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  role: text('role', { enum: ['client', 'staff', 'admin'] }).notNull(),
  totpSecret: text('totp_secret'),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  disabled: boolean('disabled').notNull().default(false),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    // sha256(token + pepper) — the raw token never touches the database.
    tokenHash: text('token_hash').notNull().unique(),
    csrfToken: text('csrf_token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull(),
  clientId: uuid('client_id').references(() => clients.id),
  role: text('role', { enum: ['client', 'staff', 'admin'] }).notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdBy: uuid('created_by').notNull().references(() => users.id),
});

export const passwordResets = pgTable('password_resets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => clients.id),
    uploadedBy: uuid('uploaded_by').notNull().references(() => users.id),
    folder: text('folder').notNull().default('General'),
    filename: text('filename').notNull(),
    // Random uuid used as the on-disk name; original filename only in DB.
    storedName: uuid('stored_name').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('documents_client_idx').on(t.clientId)],
);

export const threads = pgTable(
  'threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => clients.id),
    subject: text('subject').notNull(),
    createdBy: uuid('created_by').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [index('threads_client_idx').on(t.clientId)],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id').notNull().references(() => threads.id),
    senderId: uuid('sender_id').notNull().references(() => users.id),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_thread_idx').on(t.threadId)],
);

export const threadReads = pgTable(
  'thread_reads',
  {
    threadId: uuid('thread_id').notNull().references(() => threads.id),
    userId: uuid('user_id').notNull().references(() => users.id),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.userId] })],
);

export const taskLists = pgTable(
  'task_lists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => clients.id),
    title: text('title').notNull(),
    createdBy: uuid('created_by').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('task_lists_client_idx').on(t.clientId)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listId: uuid('list_id').notNull().references(() => taskLists.id),
    title: text('title').notNull(),
    notes: text('notes'),
    owner: text('owner', { enum: ['client', 'firm'] }).notNull(),
    dueDate: date('due_date'),
    sortOrder: integer('sort_order').notNull().default(0),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: uuid('completed_by').references(() => users.id),
  },
  (t) => [index('tasks_list_idx').on(t.listId)],
);

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => clients.id),
    stripeInvoiceId: text('stripe_invoice_id').notNull().unique(),
    number: text('number'),
    amountDueCents: integer('amount_due_cents').notNull().default(0),
    amountPaidCents: integer('amount_paid_cents').notNull().default(0),
    currency: text('currency').notNull().default('usd'),
    status: text('status').notNull().default('draft'),
    hostedInvoiceUrl: text('hosted_invoice_url'),
    invoicePdf: text('invoice_pdf'),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
  },
  (t) => [index('invoices_client_idx').on(t.clientId)],
);

export const signatureRequests = pgTable(
  'signature_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => clients.id),
    title: text('title').notNull(),
    docusealSubmissionId: text('docuseal_submission_id').unique(),
    signerEmail: text('signer_email').notNull(),
    status: text('status').notNull().default('pending'),
    createdBy: uuid('created_by').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [index('signature_requests_client_idx').on(t.clientId)],
);

export const leads = pgTable('leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  form: text('form').notNull().default('contact'),
  name: text('name'),
  email: text('email'),
  phone: text('phone'),
  company: text('company'),
  businessType: text('business_type'),
  revenue: text('revenue'),
  message: text('message'),
  ip: inet('ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  handledAt: timestamp('handled_at', { withTimezone: true }),
});

/** Append-only. App code inserts; nothing in app code updates or deletes. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    userId: uuid('user_id').references(() => users.id),
    clientId: uuid('client_id').references(() => clients.id),
    action: text('action').notNull(),
    entity: text('entity'),
    entityId: text('entity_id'),
    ip: inet('ip'),
    meta: jsonb('meta'),
  },
  (t) => [index('audit_log_at_idx').on(t.at)],
);

// ============================================================================
// v1: omnichannel intake, ledger, rules engine, work queue, AI audit
// ----------------------------------------------------------------------------
// Design rules enforced here:
//  * Originals are immutable. Extractions are append-only rows pointing at an
//    intake_item; a re-run adds a row, it never overwrites.
//  * Every inbound artefact carries provenance (channel, sender, raw payload).
//  * A sender is resolved to a client through channel_identities — never guessed.
//  * AI never writes to the ledger. It writes suggestions; a human confirms.
// ============================================================================

/** Bank / credit / loan accounts belonging to a client. */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => clients.id),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['bank', 'credit_card', 'loan', 'cash', 'other'] })
      .notNull()
      .default('bank'),
    institution: text('institution'),
    /** Last 4 only — never store a full account number. */
    mask: text('mask'),
    currency: text('currency').notNull().default('usd'),
    /** External feed linkage (Plaid item/account id, QBO id, …). */
    externalSource: text('external_source'),
    externalId: text('external_id'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('accounts_client_idx').on(t.clientId)],
);

/** Chart of accounts. Global rows (client_id null) are firm defaults. */
export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').references(() => clients.id),
    name: text('name').notNull(),
    kind: text('kind', {
      enum: ['income', 'cogs', 'expense', 'asset', 'liability', 'equity'],
    }).notNull(),
    parentId: uuid('parent_id'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('categories_client_idx').on(t.clientId)],
);

/** A ledger transaction awaiting (or holding) a categorisation. */
export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => clients.id),
    accountId: uuid('account_id').notNull().references(() => accounts.id),
    postedAt: date('posted_at').notNull(),
    description: text('description').notNull(),
    /** Signed minor units. Negative = money out. Integers only — never floats. */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('usd'),
    counterparty: text('counterparty'),
    categoryId: uuid('category_id').references(() => categories.id),
    /** How the current category was decided. */
    categorizedBy: text('categorized_by', { enum: ['ai', 'rule', 'human', 'import'] }),
    categorizedById: uuid('categorized_by_id').references(() => users.id),
    categorizedAt: timestamp('categorized_at', { withTimezone: true }),
    /** 0..1 when categorised by ai/rule; null for human. */
    categoryConfidence: integer('category_confidence'),
    needsReceipt: boolean('needs_receipt').notNull().default(false),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    /** Feed idempotency: stable id from the source system. */
    externalId: text('external_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('transactions_client_posted_idx').on(t.clientId, t.postedAt),
    index('transactions_uncategorized_idx').on(t.clientId, t.categoryId),
    uniqueIndex('transactions_external_uq').on(t.accountId, t.externalId),
  ],
);

/**
 * How an inbound sender resolves to a client. Nothing is ever inferred:
 * an unknown identity sends its intake item to quarantine instead.
 */
export const channelIdentities = pgTable(
  'channel_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => clients.id),
    channel: text('channel', {
      enum: ['sms', 'whatsapp', 'email', 'portal', 'pwa', 'voice', 'cloud_folder', 'bank_feed'],
    }).notNull(),
    /** E.164 phone, email address, WhatsApp id, folder id, … */
    identity: citext('identity').notNull(),
    label: text('label'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** TCPA: documented consent for outbound messaging on this identity. */
    consentAt: timestamp('consent_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('channel_identities_uq').on(t.channel, t.identity)],
);

/** Every front door writes here. One hallway. */
export const intakeItems = pgTable(
  'intake_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null until the sender is resolved. Null + quarantined = needs a human. */
    clientId: uuid('client_id').references(() => clients.id),
    channel: text('channel', {
      enum: ['sms', 'whatsapp', 'email', 'portal', 'pwa', 'voice', 'cloud_folder', 'bank_feed'],
    }).notNull(),
    /** Provider message id — half of the idempotency key. */
    externalId: text('external_id'),
    senderIdentity: text('sender_identity'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** Verbatim provider payload, retained for provenance. */
    rawPayload: jsonb('raw_payload'),
    /** Encrypted object key for the original artefact, if any. */
    storageKey: text('storage_key'),
    mime: text('mime'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /** sha256 of the content — the other half of the idempotency key. */
    contentHash: text('content_hash'),
    status: text('status', {
      enum: ['received', 'quarantined', 'processing', 'needs_review', 'filed', 'discarded'],
    })
      .notNull()
      .default('received'),
    quarantineReason: text('quarantine_reason'),
    documentId: uuid('document_id').references(() => documents.id),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('intake_external_uq').on(t.channel, t.externalId),
    uniqueIndex('intake_content_uq').on(t.clientId, t.contentHash),
    index('intake_status_idx').on(t.status, t.receivedAt),
  ],
);

/** Append-only. A re-run adds a row; nothing is ever overwritten. */
export const extractions = pgTable(
  'extractions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    intakeItemId: uuid('intake_item_id').notNull().references(() => intakeItems.id),
    provider: text('provider').notNull(),
    model: text('model'),
    docType: text('doc_type', {
      enum: ['receipt', 'invoice', 'bill', 'statement', 'w9', 'contract', 'other', 'unknown'],
    })
      .notNull()
      .default('unknown'),
    /** { vendor, date, total_cents, tax_cents, line_items[], … } */
    extracted: jsonb('extracted').notNull(),
    /** 0..100 */
    confidence: integer('confidence').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('extractions_item_idx').on(t.intakeItemId)],
);

/** Extraction ↔ transaction linkage, proposed by AI and confirmed by a human. */
export const txnMatches = pgTable(
  'txn_matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    extractionId: uuid('extraction_id').notNull().references(() => extractions.id),
    transactionId: uuid('transaction_id').notNull().references(() => transactions.id),
    confidence: integer('confidence').notNull().default(0),
    matchedBy: text('matched_by', { enum: ['ai', 'rule', 'human'] }).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: uuid('confirmed_by').references(() => users.id),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
  },
  (t) => [index('txn_matches_txn_idx').on(t.transactionId)],
);

/** The confirmation loop — auditable record of everything we sent out. */
export const outboundMessages = pgTable(
  'outbound_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => clients.id),
    channel: text('channel', {
      enum: ['sms', 'whatsapp', 'email', 'portal', 'push'],
    }).notNull(),
    toIdentity: text('to_identity').notNull(),
    body: text('body').notNull(),
    purpose: text('purpose', {
      enum: ['capture_confirmation', 'question', 'document_request', 'alert', 'digest', 'other'],
    })
      .notNull()
      .default('other'),
    inReplyTo: uuid('in_reply_to'),
    relatedEntity: text('related_entity'),
    relatedId: text('related_id'),
    status: text('status', { enum: ['queued', 'sent', 'failed', 'suppressed'] })
      .notNull()
      .default('queued'),
    failureReason: text('failure_reason'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('outbound_client_idx').on(t.clientId, t.createdAt)],
);

/**
 * The compounding asset: every human correction becomes a durable rule, so a
 * client costs materially less to serve in year two than in year one.
 */
export const categorizationRules = pgTable(
  'categorization_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').references(() => clients.id),
    matchType: text('match_type', { enum: ['contains', 'equals', 'regex', 'counterparty'] })
      .notNull()
      .default('contains'),
    pattern: text('pattern').notNull(),
    /** Optional amount window in minor units. */
    minAmountCents: bigint('min_amount_cents', { mode: 'number' }),
    maxAmountCents: bigint('max_amount_cents', { mode: 'number' }),
    categoryId: uuid('category_id').notNull().references(() => categories.id),
    /** Provenance: learned from a correction, or authored by a human. */
    source: text('source', { enum: ['learned', 'manual'] }).notNull().default('learned'),
    createdBy: uuid('created_by').references(() => users.id),
    hitCount: integer('hit_count').notNull().default(0),
    lastHitAt: timestamp('last_hit_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rules_client_idx').on(t.clientId)],
);

/** The unified cross-client staff queue. Work items, not folders. */
export const workItems = pgTable(
  'work_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => clients.id),
    kind: text('kind', {
      enum: ['categorize', 'reconcile', 'answer', 'review', 'chase', 'quarantine', 'close'],
    }).notNull(),
    title: text('title').notNull(),
    detail: text('detail'),
    /** Higher runs first. Derived from SLA risk, blocked state, value. */
    priority: integer('priority').notNull().default(0),
    dueAt: timestamp('due_at', { withTimezone: true }),
    assignedTo: uuid('assigned_to').references(() => users.id),
    status: text('status', { enum: ['open', 'snoozed', 'blocked', 'done'] })
      .notNull()
      .default('open'),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    relatedEntity: text('related_entity'),
    relatedId: text('related_id'),
    /** Item count for grouped work ("47 transactions from Shell"). */
    itemCount: integer('item_count').notNull().default(1),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: uuid('completed_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('work_items_queue_idx').on(t.status, t.priority),
    index('work_items_client_idx').on(t.clientId),
  ],
);

/** Month-end close tracking, per client per period. */
export const closePeriods = pgTable(
  'close_periods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => clients.id),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    /** Contractual delivery date — what the SLA is measured against. */
    targetDate: date('target_date'),
    status: text('status', {
      enum: ['not_started', 'in_progress', 'preflight', 'in_review', 'delivered'],
    })
      .notNull()
      .default('not_started'),
    ownerId: uuid('owner_id').references(() => users.id),
    reviewerId: uuid('reviewer_id').references(() => users.id),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    /** AI-drafted, human-approved plain-English summary. */
    narrative: text('narrative'),
    narrativeApprovedBy: uuid('narrative_approved_by').references(() => users.id),
    narrativeApprovedAt: timestamp('narrative_approved_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('close_periods_uq').on(t.clientId, t.periodStart)],
);

/** Pre-flight results. Only a clean pass reaches a human reviewer. */
export const closeChecks = pgTable(
  'close_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    closePeriodId: uuid('close_period_id').notNull().references(() => closePeriods.id),
    code: text('code').notNull(),
    label: text('label').notNull(),
    severity: text('severity', { enum: ['info', 'warn', 'block'] }).notNull().default('warn'),
    passed: boolean('passed').notNull().default(false),
    detail: text('detail'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('close_checks_period_idx').on(t.closePeriodId)],
);

/** Open questions to the client, answerable in-portal or by replying to a text. */
export const clientQuestions = pgTable(
  'client_questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => clients.id),
    transactionId: uuid('transaction_id').references(() => transactions.id),
    question: text('question').notNull(),
    /** Optional one-tap choices, e.g. ["Job materials","Shop supplies","Personal"]. */
    choices: jsonb('choices'),
    answer: text('answer'),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    answeredVia: text('answered_via', { enum: ['portal', 'sms', 'whatsapp', 'email', 'staff'] }),
    askedBy: uuid('asked_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('client_questions_open_idx').on(t.clientId, t.answeredAt)],
);

/** What we still need from the client, tracked so nobody has to chase manually. */
export const documentRequests = pgTable(
  'document_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => clients.id),
    label: text('label').notNull(),
    periodStart: date('period_start'),
    periodEnd: date('period_end'),
    accountId: uuid('account_id').references(() => accounts.id),
    transactionId: uuid('transaction_id').references(() => transactions.id),
    status: text('status', { enum: ['open', 'received', 'waived'] }).notNull().default('open'),
    fulfilledByIntakeId: uuid('fulfilled_by_intake_id').references(() => intakeItems.id),
    lastNudgedAt: timestamp('last_nudged_at', { withTimezone: true }),
    nudgeCount: integer('nudge_count').notNull().default(0),
    dueAt: timestamp('due_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('doc_requests_client_idx').on(t.clientId, t.status)],
);

/** Detected anomalies — surfaced to staff before the client ever asks. */
export const anomalies = pgTable(
  'anomalies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => clients.id),
    kind: text('kind', {
      enum: [
        'duplicate_payment',
        'price_increase',
        'unusual_amount',
        'new_vendor',
        'slow_paying_customer',
        'missing_deposit',
        'other',
      ],
    }).notNull(),
    severity: text('severity', { enum: ['low', 'medium', 'high'] }).notNull().default('medium'),
    summary: text('summary').notNull(),
    detail: jsonb('detail'),
    transactionIds: jsonb('transaction_ids'),
    detectedBy: text('detected_by', { enum: ['ai', 'rule'] }).notNull().default('rule'),
    status: text('status', { enum: ['open', 'confirmed', 'dismissed', 'shared'] })
      .notNull()
      .default('open'),
    sharedWithClientAt: timestamp('shared_with_client_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('anomalies_client_idx').on(t.clientId, t.status)],
);

/** Firm memory: how we handled something, so it survives staff turnover. */
export const precedents = pgTable(
  'precedents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').references(() => clients.id),
    industry: text('industry'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    tags: jsonb('tags'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('precedents_client_idx').on(t.clientId)],
);

/** Compliance calendar — deadlines with what we need and by when. */
export const complianceEvents = pgTable(
  'compliance_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => clients.id),
    code: text('code').notNull(),
    label: text('label').notNull(),
    dueOn: date('due_on').notNull(),
    /** Informational only — Balance Bridge is not a CPA firm. */
    notes: text('notes'),
    status: text('status', { enum: ['upcoming', 'in_progress', 'done', 'na'] })
      .notNull()
      .default('upcoming'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [index('compliance_client_due_idx').on(t.clientId, t.dueOn)],
);

/** The 20-point books health checklist, live. */
export const healthScores = pgTable(
  'health_scores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => clients.id),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    score: integer('score').notNull(),
    maxScore: integer('max_score').notNull().default(20),
    checks: jsonb('checks').notNull(),
  },
  (t) => [index('health_client_idx').on(t.clientId, t.computedAt)],
);

/** Effort per client, so the firm knows who it is losing money on. */
export const timeEntries = pgTable(
  'time_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => clients.id),
    userId: uuid('user_id').notNull().references(() => users.id),
    workItemId: uuid('work_item_id').references(() => workItems.id),
    minutes: integer('minutes').notNull(),
    /** True when derived from queue activity rather than typed in. */
    automatic: boolean('automatic').notNull().default(true),
    occurredOn: date('occurred_on').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('time_entries_client_idx').on(t.clientId, t.occurredOn)],
);

/**
 * Every AI invocation, logged. Cost, latency, confidence and whether a human
 * accepted the suggestion — this is how we prove the system is safe and
 * measure whether it is actually getting better.
 */
export const aiRuns = pgTable(
  'ai_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').references(() => clients.id),
    userId: uuid('user_id').references(() => users.id),
    task: text('task', {
      enum: [
        'extract',
        'categorize',
        'narrative',
        'reply_draft',
        'anomaly',
        'precedent_search',
        'reconcile',
        'preflight',
      ],
    }).notNull(),
    provider: text('provider').notNull(),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms'),
    confidence: integer('confidence'),
    /** Did a human accept the suggestion? Null = not yet reviewed. */
    accepted: boolean('accepted'),
    relatedEntity: text('related_entity'),
    relatedId: text('related_id'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_runs_task_idx').on(t.task, t.createdAt)],
);

/** Integration configuration and live status, firm-wide or per client. */
export const integrations = pgTable(
  'integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').references(() => clients.id),
    provider: text('provider', {
      enum: ['stripe', 'twilio', 'whatsapp', 'plaid', 'qbo', 'smtp', 'docuseal', 'ai', 'storage'],
    }).notNull(),
    status: text('status', { enum: ['not_configured', 'configured', 'error', 'disabled'] })
      .notNull()
      .default('not_configured'),
    /** Non-secret settings only. Credentials live in env, never in the database. */
    settings: jsonb('settings'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastError: text('last_error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('integrations_uq').on(t.clientId, t.provider)],
);
