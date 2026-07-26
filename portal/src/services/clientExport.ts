/**
 * One-click client data export.
 *
 * DECISIONS.md §10: "Clients own their data. Build a one-click export
 * (documents, transactions, reports) from day one. It costs little, it's the
 * right thing, and being visibly unafraid of a client leaving is itself a trust
 * signal."
 *
 * What it produces: a single zip containing every dataset twice — once as JSON
 * (complete, typed, machine-readable) and once as CSV (openable in Excel by the
 * owner who just wants to look at it). Plus a manifest explaining what each file
 * is and when it was generated.
 *
 * ## Rules
 *
 * 1. **The client id is a parameter, never a request value.** Callers resolve it
 *    from the session (`resolveClientId`), and every query in here filters on it.
 *    There is no code path that exports two clients.
 * 2. **Nothing sensitive leaves in the clear.** The EIN is masked to its last
 *    four; financial accounts carry last four only (that is all we ever stored);
 *    password hashes, tokens and session rows are not in the export at all.
 * 3. **Document *files* are not in the bundle, their metadata is.** The zip is
 *    built in memory and streamed; putting 25MB attachments in it would turn a
 *    click into an outage. The metadata carries a download URL per document.
 *
 * The zip is written by hand (deflate + central directory) rather than by adding
 * a dependency: the format is 60 lines and the alternative is a supply-chain
 * risk for a feature that runs a few times a year.
 */

import zlib from 'node:zlib';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  clientFinancialAccounts,
  clientOnboarding,
  clientQuestions,
  closePeriods,
  documents,
  invoices,
  transactions,
  accounts,
  categories,
  clients,
} from '../db/schema.js';
/**
 * The mask the wizard stored when the EIN was typed (`••-•••1234`). Reading it
 * back is the only "EIN" this module ever handles — there is no decrypt call in
 * the export path at all.
 */
function einMaskFrom(answers: unknown): string | null {
  if (!answers || typeof answers !== 'object') return null;
  const a = (answers as Record<string, unknown>)['a'];
  if (!a || typeof a !== 'object') return null;
  const m = (a as Record<string, unknown>)['einMasked'];
  return typeof m === 'string' && m ? m : null;
}

/* ========================================================================== */
/* Gathering                                                                   */
/* ========================================================================== */

/** Hard ceiling per dataset, so one enormous client cannot exhaust memory. */
const MAX_ROWS = 20000;

export interface ExportBundle {
  filename: string;
  zip: Buffer;
  /** Row counts per dataset — logged to the audit trail. */
  counts: Record<string, number>;
}

export async function buildClientExport(clientId: string): Promise<ExportBundle> {
  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client) throw new Error('client not found');

  const [docRows, txnRows, questionRows, invoiceRows, closeRows, finAccounts, onboardingRow] =
    await Promise.all([
      db
        .select({
          id: documents.id,
          folder: documents.folder,
          filename: documents.filename,
          mime: documents.mime,
          sizeBytes: documents.sizeBytes,
          sha256: documents.sha256,
          createdAt: documents.createdAt,
          deletedAt: documents.deletedAt,
        })
        .from(documents)
        .where(eq(documents.clientId, clientId))
        .orderBy(desc(documents.createdAt))
        .limit(MAX_ROWS),

      db
        .select({
          id: transactions.id,
          postedAt: transactions.postedAt,
          description: transactions.description,
          amountCents: transactions.amountCents,
          currency: transactions.currency,
          counterparty: transactions.counterparty,
          account: accounts.name,
          // Last four only — the full number was never stored, and the external
          // feed ids are deliberately not selected.
          accountMask: accounts.mask,
          category: categories.name,
          categorizedBy: transactions.categorizedBy,
          reconciledAt: transactions.reconciledAt,
        })
        .from(transactions)
        .leftJoin(accounts, eq(transactions.accountId, accounts.id))
        .leftJoin(categories, eq(transactions.categoryId, categories.id))
        .where(eq(transactions.clientId, clientId))
        .orderBy(desc(transactions.postedAt))
        .limit(MAX_ROWS),

      db
        .select({
          id: clientQuestions.id,
          question: clientQuestions.question,
          answer: clientQuestions.answer,
          answeredAt: clientQuestions.answeredAt,
          answeredVia: clientQuestions.answeredVia,
          createdAt: clientQuestions.createdAt,
        })
        .from(clientQuestions)
        .where(eq(clientQuestions.clientId, clientId))
        .orderBy(desc(clientQuestions.createdAt))
        .limit(MAX_ROWS),

      db
        .select({
          id: invoices.id,
          number: invoices.number,
          status: invoices.status,
          amountDueCents: invoices.amountDueCents,
          amountPaidCents: invoices.amountPaidCents,
          currency: invoices.currency,
          issuedAt: invoices.issuedAt,
          dueAt: invoices.dueAt,
          paidAt: invoices.paidAt,
          hostedInvoiceUrl: invoices.hostedInvoiceUrl,
        })
        .from(invoices)
        .where(eq(invoices.clientId, clientId))
        .orderBy(desc(invoices.issuedAt))
        .limit(MAX_ROWS),

      // Only approved narratives. A draft is firm-side work in progress and is
      // not the client's record of anything (routes/client.ts, rule 2).
      db
        .select({
          id: closePeriods.id,
          periodStart: closePeriods.periodStart,
          periodEnd: closePeriods.periodEnd,
          status: closePeriods.status,
          deliveredAt: closePeriods.deliveredAt,
          narrative: closePeriods.narrative,
          narrativeApprovedAt: closePeriods.narrativeApprovedAt,
        })
        .from(closePeriods)
        .where(eq(closePeriods.clientId, clientId))
        .orderBy(desc(closePeriods.periodEnd))
        .limit(MAX_ROWS),

      db
        .select({
          institution: clientFinancialAccounts.institution,
          nickname: clientFinancialAccounts.nickname,
          kind: clientFinancialAccounts.kind,
          last4: clientFinancialAccounts.last4,
          active: clientFinancialAccounts.active,
        })
        .from(clientFinancialAccounts)
        .where(eq(clientFinancialAccounts.clientId, clientId))
        .orderBy(asc(clientFinancialAccounts.createdAt)),

      db.query.clientOnboarding.findFirst({ where: eq(clientOnboarding.clientId, clientId) }),
    ]);

  const approvedNarratives = closeRows.filter((c) => c.narrativeApprovedAt !== null);

  const profile = {
    id: client.id,
    businessName: client.businessName,
    legalName: client.legalName,
    contactName: client.contactName,
    email: client.email,
    phone: client.phone,
    status: client.status,
    entityType: client.entityType,
    // Masked. The ciphertext is never exported and is never decrypted here —
    // the mask was computed once, at the moment the client typed it.
    ein: client.einEncrypted ? (einMaskFrom(onboardingRow?.answers) ?? 'on file (masked)') : null,
    industry: client.industry,
    formationState: client.formationState,
    address: {
      line1: client.addressLine1,
      line2: client.addressLine2,
      city: client.city,
      state: client.state,
      postalCode: client.postalCode,
    },
    website: client.website,
    fiscalYearEnd: client.fiscalYearEnd,
    booksStatus: client.booksStatus,
    monthsBehind: client.monthsBehind,
    txnVolumeBand: client.txnVolumeBand,
    revenueBand: client.revenueBand,
    currentSoftware: client.currentSoftware,
    plan: client.plan,
    monthlyFeeCents: client.monthlyFeeCents,
    closeTargetDay: client.closeTargetDay,
    createdAt: client.createdAt,
  };

  const onboardingAnswers = scrubOnboarding(onboardingRow?.answers);

  const counts = {
    documents: docRows.length,
    transactions: txnRows.length,
    questions: questionRows.length,
    invoices: invoiceRows.length,
    close_narratives: approvedNarratives.length,
    financial_accounts: finAccounts.length,
  };

  const generatedAt = new Date();
  const manifest = {
    generatedAt: generatedAt.toISOString(),
    client: { id: client.id, businessName: client.businessName },
    note:
      'Your data, exported in full. Every dataset appears twice: a .json file (complete) and a .csv (opens in Excel). Document files themselves are not in this bundle — download them from the portal using the download_url in documents.json.',
    contents: {
      'client-profile.json': 'Your business profile. The EIN is masked; we never export it.',
      'financial-accounts.(json|csv)': 'The accounts we reconcile. Last four digits only — we never held more.',
      'documents.(json|csv)': 'Every document, with its size, checksum and download link.',
      'transactions.(json|csv)': 'The ledger, with account, category and reconciliation state.',
      'questions.(json|csv)': 'Questions we asked you and the answers you gave.',
      'invoices.(json|csv)': 'Billing history.',
      'close-narratives.(json|csv)': 'Approved monthly close summaries. Drafts are excluded.',
      'onboarding.json': 'Everything you told us in the onboarding wizard.',
    },
    counts,
  };

  const files: ZipEntry[] = [
    json('manifest.json', manifest),
    json('client-profile.json', profile),
    json('financial-accounts.json', finAccounts),
    csv('financial-accounts.csv', ['institution', 'nickname', 'kind', 'last4', 'active'], finAccounts),
    json(
      'documents.json',
      docRows.map((d) => ({ ...d, download_url: `/documents/${d.id}/download` })),
    ),
    csv(
      'documents.csv',
      ['id', 'folder', 'filename', 'mime', 'sizeBytes', 'sha256', 'createdAt', 'deletedAt'],
      docRows,
    ),
    json('transactions.json', txnRows),
    csv(
      'transactions.csv',
      [
        'id',
        'postedAt',
        'description',
        'amountCents',
        'currency',
        'counterparty',
        'account',
        'accountMask',
        'category',
        'categorizedBy',
        'reconciledAt',
      ],
      txnRows,
    ),
    json('questions.json', questionRows),
    csv(
      'questions.csv',
      ['id', 'question', 'answer', 'answeredAt', 'answeredVia', 'createdAt'],
      questionRows,
    ),
    json('invoices.json', invoiceRows),
    csv(
      'invoices.csv',
      [
        'id',
        'number',
        'status',
        'amountDueCents',
        'amountPaidCents',
        'currency',
        'issuedAt',
        'dueAt',
        'paidAt',
        'hostedInvoiceUrl',
      ],
      invoiceRows,
    ),
    json('close-narratives.json', approvedNarratives),
    csv(
      'close-narratives.csv',
      ['id', 'periodStart', 'periodEnd', 'status', 'deliveredAt', 'narrativeApprovedAt', 'narrative'],
      approvedNarratives,
    ),
    json('onboarding.json', {
      completedSections: onboardingRow?.completedSections ?? [],
      submittedAt: onboardingRow?.submittedAt ?? null,
      lastSavedAt: onboardingRow?.lastSavedAt ?? null,
      answers: onboardingAnswers,
    }),
  ];

  const slug =
    client.businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'client';

  return {
    filename: `balancebridge-export-${slug}-${generatedAt.toISOString().slice(0, 10)}.zip`,
    zip: createZip(files),
    counts,
  };
}

/**
 * Onboarding answers are free-form jsonb written by the wizard. The wizard never
 * stores an EIN there (it goes to `clients.ein_encrypted`), but this strips any
 * key that looks like one anyway — an export is exactly the wrong place to
 * discover that an earlier version was careless.
 */
function scrubOnboarding(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubOnboarding);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/ein|ssn|password|secret|token/i.test(k)) continue;
      out[k] = scrubOnboarding(v);
    }
    return out;
  }
  return value;
}

/* ========================================================================== */
/* Serialisation                                                               */
/* ========================================================================== */

function json(name: string, value: unknown): ZipEntry {
  return { name, data: Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8') };
}

/** RFC 4180 CSV. Quotes everything that could possibly need it. */
export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

function csv(name: string, columns: string[], rows: Array<Record<string, unknown>>): ZipEntry {
  return { name, data: Buffer.from(toCsv(columns, rows), 'utf8') };
}

/* ========================================================================== */
/* Minimal zip writer (deflate, no encryption, no zip64)                       */
/* ========================================================================== */

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Build a zip archive. Each entry is deflated (method 8) with a CRC-32, then the
 * central directory is appended. No zip64: the export is capped well below 4GB
 * by MAX_ROWS, and staying inside the classic format keeps this readable.
 */
export function createZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  const { date, time } = dosTimestamp(new Date());

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = zlib.crc32(entry.data) >>> 0;
    const deflated = zlib.deflateRawSync(entry.data);
    // Never let "compression" make a file bigger — fall back to stored.
    const useDeflate = deflated.length < entry.data.length;
    const body = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    chunks.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central directory signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(entry.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

/** MS-DOS date/time, which is what the zip format stores. */
function dosTimestamp(d: Date): { date: number; time: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}
