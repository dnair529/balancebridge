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
