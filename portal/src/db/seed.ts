/**
 * Idempotent seed:
 * - always: admin user from ADMIN_EMAIL/ADMIN_PASSWORD (skipped if it exists)
 * - SEED_DEMO=1: the original single-client demo, plus a full v1 book of
 *   business — four Texas clients with ledgers, rules, work, close periods,
 *   anomalies, identities, AI history and health scores.
 * Run: npm run db:seed
 *
 * ## Idempotency
 *
 * Running this twice must not duplicate anything. Two guards do that work:
 *
 *   1. A marker audit row (`seed.demo_v1`). Present → the v1 block is skipped
 *      wholesale and the script exits having written nothing.
 *   2. A per-client guard on `business_name`. So a run that died halfway
 *      resumes cleanly instead of half-duplicating a client, and adding a
 *      fifth client later is a re-run rather than a migration.
 *
 * Everything reached through a service (`linkIdentity`, `ensureCalendar`,
 * `syncRequests`) is already idempotent by construction; the guards above are
 * what protects the direct inserts.
 */
import { eq } from 'drizzle-orm';
import { db, closeDb } from './index.js';
import {
  accounts,
  aiRuns,
  anomalies,
  auditLog,
  categories,
  categorizationRules,
  clientQuestions,
  clients,
  closeChecks,
  closePeriods,
  complianceEvents,
  intakeItems,
  invoices,
  leads,
  messages,
  outboundMessages,
  precedents,
  taskLists,
  tasks,
  threads,
  timeEntries,
  transactions,
  users,
  workItems,
} from './schema.js';
import { hashPassword } from '../auth/password.js';
import { config } from '../config.js';
import { linkIdentity } from '../intake/identity.js';
import { ensureCalendar, type CalendarProfile } from '../services/compliance.js';
import { syncRequests } from '../services/documentRequests.js';
import { computeAndStore } from '../services/healthScore.js';

/** Present in `audit_log` → the v1 demo has already been seeded. */
const DEMO_MARKER = 'seed.demo_v1';

/** Demo logins. Env wins; otherwise the documented demo password. */
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Simba1';

async function main() {
  // ---- Admin ----
  if (!config.ADMIN_PASSWORD) {
    console.error('ADMIN_PASSWORD is required to seed the admin user.');
    process.exit(1);
  }
  let admin = await db.query.users.findFirst({ where: eq(users.email, config.ADMIN_EMAIL) });
  if (!admin) {
    [admin] = await db
      .insert(users)
      .values({
        email: config.ADMIN_EMAIL,
        passwordHash: await hashPassword(config.ADMIN_PASSWORD),
        name: 'Portal Admin',
        role: 'admin',
      })
      .returning();
    console.log(`Created admin user ${config.ADMIN_EMAIL}`);
  } else {
    console.log(`Admin user ${config.ADMIN_EMAIL} already exists — skipping.`);
  }

  if (!config.SEED_DEMO) {
    console.log('SEED_DEMO not set — done.');
    return;
  }

  // ---- Original demo client (unchanged behaviour) ----
  const demoEmail = 'client@demo.balancebridge.us';
  const existingDemo = await db.query.clients.findFirst({
    where: eq(clients.businessName, 'Lonestar Coffee Co.'),
  });

  if (existingDemo) {
    console.log('Lonestar Coffee demo already present — skipping.');
  } else {
    const [demoClient] = await db
      .insert(clients)
      .values({
        businessName: 'Lonestar Coffee Co.',
        contactName: 'Dana Rivera',
        email: demoEmail,
        phone: '+1 (940) 555-0142',
        notes: 'Demo client created by seed script.',
      })
      .returning();

    const [demoUser] = await db
      .insert(users)
      .values({
        clientId: demoClient!.id,
        email: demoEmail,
        passwordHash: await hashPassword(config.DEMO_PASSWORD),
        name: 'Dana Rivera',
        role: 'client',
      })
      .returning();

    // ---- Sample thread + messages ----
    const [thread] = await db
      .insert(threads)
      .values({
        clientId: demoClient!.id,
        subject: 'Welcome to your portal',
        createdBy: admin!.id,
      })
      .returning();
    await db.insert(messages).values([
      {
        threadId: thread!.id,
        senderId: admin!.id,
        body: 'Welcome aboard, Dana! Upload your latest bank statements under Documents and we will take it from there.',
      },
      {
        threadId: thread!.id,
        senderId: demoUser!.id,
        body: 'Thanks! I will get those uploaded this week.',
      },
    ]);

    // ---- Sample task list ----
    const [list] = await db
      .insert(taskLists)
      .values({ clientId: demoClient!.id, title: 'Monthly close — July', createdBy: admin!.id })
      .returning();
    await db.insert(tasks).values([
      { listId: list!.id, title: 'Upload July bank statements', owner: 'client', sortOrder: 1 },
      { listId: list!.id, title: 'Confirm new payroll provider', owner: 'client', sortOrder: 2 },
      { listId: list!.id, title: 'Reconcile operating account', owner: 'firm', sortOrder: 3 },
      {
        listId: list!.id,
        title: 'Deliver July financial package',
        owner: 'firm',
        sortOrder: 4,
        notes: 'Due by the 10th business day.',
      },
    ]);

    // ---- Sample invoice mirror row (no Stripe call) ----
    await db.insert(invoices).values({
      clientId: demoClient!.id,
      stripeInvoiceId: 'in_demo_0001',
      number: 'BB-1001',
      amountDueCents: 45000,
      amountPaidCents: 0,
      status: 'open',
      hostedInvoiceUrl: 'https://invoice.stripe.com/i/demo',
      issuedAt: new Date(),
      dueAt: new Date(Date.now() + 14 * 24 * 3600 * 1000),
    });

    // ---- Sample lead ----
    await db.insert(leads).values({
      form: 'contact',
      name: 'Sam Okafor',
      email: 'sam@example.com',
      company: 'Okafor Landscaping',
      businessType: 'LLC',
      revenue: '$250k-$1M',
      message: 'Looking for monthly bookkeeping and cleanup of 2025.',
    });

    console.log('Demo data created.');
    console.log(`  client login: ${demoEmail} / ${config.DEMO_PASSWORD}`);
  }

  await seedV1Demo(admin!.id);
}

/* ========================================================================== */
/* v1 demo: a coherent Texas book of business                                  */
/* ========================================================================== */

/** Deterministic PRNG, so two fresh databases seed to the same numbers. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const DAY = 24 * 3600 * 1000;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY);
}

interface VendorSpec {
  readonly name: string;
  readonly category: string;
  /** Money out unless `income`. Dollars, before the small random wobble. */
  readonly amount: number;
  /** Roughly how many days between charges. */
  readonly everyDays: number;
  readonly income?: boolean;
  readonly needsReceipt?: boolean;
  /** Which account index this hits. */
  readonly account?: number;
}

interface ClientSpec {
  readonly businessName: string;
  readonly contactName: string;
  readonly email: string;
  readonly phone: string;
  readonly industry: string;
  readonly notes: string;
  readonly seed: number;
  readonly smsPhone: string;
  readonly accounts: readonly { name: string; kind: 'bank' | 'credit_card' | 'loan' | 'cash' | 'other'; institution: string; mask: string }[];
  readonly categories: readonly { name: string; kind: 'income' | 'cogs' | 'expense' | 'asset' | 'liability' | 'equity' }[];
  readonly vendors: readonly VendorSpec[];
  /** The 40+ transaction pile the categorize demo is built on. */
  readonly bigVendor: { name: string; count: number; amount: number; account?: number };
  /** Same amount twice within days — the duplicate-payment anomaly. */
  readonly duplicate: { vendor: string; amount: number; category: string };
  /** Monthly bill that jumps — the price-increase anomaly. */
  readonly priceIncrease: { vendor: string; from: number; to: number; category: string };
  readonly closeStatus: 'not_started' | 'in_progress' | 'preflight' | 'in_review' | 'delivered';
  readonly calendar: CalendarProfile;
  readonly feeCents: number;
  /** Minutes of staff effort in the last 90 days. */
  readonly effortMinutes: number;
  readonly questions: readonly { q: string; choices: string[]; answer?: string }[];
  readonly precedent: { title: string; body: string; tags: string[] } | null;
}

const CLIENT_SPECS: readonly ClientSpec[] = [
  {
    businessName: 'Ramirez Construction',
    contactName: 'Miguel Ramirez',
    email: 'miguel@ramirezconstruction.example',
    phone: '+1 (940) 555-0117',
    industry: 'construction',
    notes: 'Residential remodels and light commercial around Denton. Two crews, six W-2s, a rotating bench of subs.',
    seed: 1001,
    smsPhone: '(940) 555-0117',
    accounts: [
      { name: 'Operating checking', kind: 'bank', institution: 'First United Bank', mask: '4417' },
      { name: 'Fuel card', kind: 'credit_card', institution: 'Shell Fleet', mask: '8892' },
      { name: 'Equipment loan', kind: 'loan', institution: 'First United Bank', mask: '2210' },
    ],
    categories: [
      { name: 'Contract income', kind: 'income' },
      { name: 'Job materials', kind: 'cogs' },
      { name: 'Subcontractors', kind: 'cogs' },
      { name: 'Fuel', kind: 'expense' },
      { name: 'Equipment rental', kind: 'expense' },
      { name: 'Payroll', kind: 'expense' },
      { name: 'Insurance', kind: 'expense' },
      { name: 'Office & software', kind: 'expense' },
      { name: 'Owner draw', kind: 'equity' },
    ],
    vendors: [
      { name: 'Home Depot', category: 'Job materials', amount: 486, everyDays: 6, needsReceipt: true },
      { name: 'Shell', category: 'Fuel', amount: 92, everyDays: 4, account: 1 },
      { name: 'Sunbelt Rentals', category: 'Equipment rental', amount: 640, everyDays: 21 },
      { name: 'Gusto', category: 'Payroll', amount: 14820, everyDays: 14 },
      { name: 'Texas Mutual Insurance', category: 'Insurance', amount: 1248, everyDays: 30 },
      { name: 'Cortez Framing LLC', category: 'Subcontractors', amount: 3800, everyDays: 18 },
      { name: 'Progress payment — Oakwood remodel', category: 'Contract income', amount: 18500, everyDays: 12, income: true },
    ],
    bigVendor: { name: "McCoy's Building Supply", count: 44, amount: 312 },
    duplicate: { vendor: 'Texas Mutual Insurance', amount: 1248, category: 'Insurance' },
    priceIncrease: { vendor: 'Sunbelt Rentals', from: 640, to: 935, category: 'Equipment rental' },
    closeStatus: 'delivered',
    calendar: { salesTax: 'quarterly', payroll: 'monthly', pays1099Contractors: true, renewalMonthDay: '03-31' },
    feeCents: 89500,
    effortMinutes: 1420,
    questions: [
      {
        q: 'The $2,480 at Sunbelt on the 12th — which job was that equipment for?',
        choices: ['Oakwood remodel', 'Shop / yard', 'Personal'],
      },
      {
        q: 'Is Cortez Framing a 1099 contractor? We do not have a W-9 for them.',
        choices: ['Yes, send them a W-9 request', 'No, they invoice as a company', 'Not sure'],
      },
      {
        q: 'The $640 Home Depot charge on the 3rd had no receipt attached. Job materials?',
        choices: ['Job materials', 'Shop supplies', 'Personal'],
        answer: 'Job materials',
      },
    ],
    precedent: {
      title: 'Ramirez: retainage on commercial jobs',
      body: 'Ramirez bills commercial GCs with 10% retainage held to completion. Book the full contract amount to Contract income when invoiced and carry the retainage as a receivable — do not net it off, or the job-level margin reads low all year and the final release looks like a windfall.',
      tags: ['construction', 'retainage', 'revenue'],
    },
  },
  {
    businessName: 'Vista Dental',
    contactName: 'Dr. Anita Vasquez',
    email: 'anita@vistadental.example',
    phone: '+1 (972) 555-0184',
    industry: 'medical',
    notes: 'Two-chair general dentistry in Plano. Insurance-heavy revenue, one associate, four staff.',
    seed: 2002,
    smsPhone: '972-555-0184',
    accounts: [
      { name: 'Operating checking', kind: 'bank', institution: 'Frost Bank', mask: '7781' },
      { name: 'Practice card', kind: 'credit_card', institution: 'American Express', mask: '1005' },
    ],
    categories: [
      { name: 'Patient revenue', kind: 'income' },
      { name: 'Insurance reimbursements', kind: 'income' },
      { name: 'Dental supplies', kind: 'cogs' },
      { name: 'Lab fees', kind: 'cogs' },
      { name: 'Payroll', kind: 'expense' },
      { name: 'Rent', kind: 'expense' },
      { name: 'Practice software', kind: 'expense' },
      { name: 'Utilities', kind: 'expense' },
      { name: 'Malpractice insurance', kind: 'expense' },
    ],
    vendors: [
      { name: 'Patterson Dental', category: 'Dental supplies', amount: 1840, everyDays: 11, needsReceipt: true },
      { name: 'Dallas Dental Lab', category: 'Lab fees', amount: 960, everyDays: 9 },
      { name: 'Gusto', category: 'Payroll', amount: 21400, everyDays: 14 },
      { name: 'Plano Medical Plaza', category: 'Rent', amount: 6200, everyDays: 30 },
      { name: 'Dentrix Ascend', category: 'Practice software', amount: 549, everyDays: 30, account: 1 },
      { name: 'Delta Dental EFT', category: 'Insurance reimbursements', amount: 14200, everyDays: 7, income: true },
      { name: 'Patient payments — front desk', category: 'Patient revenue', amount: 3100, everyDays: 5, income: true },
    ],
    bigVendor: { name: 'Henry Schein', count: 41, amount: 268, account: 1 },
    duplicate: { vendor: 'Plano Medical Plaza', amount: 6200, category: 'Rent' },
    priceIncrease: { vendor: 'Reliant Energy', from: 412, to: 598, category: 'Utilities' },
    closeStatus: 'in_review',
    calendar: { salesTax: 'none', payroll: 'monthly', pays1099Contractors: true, renewalMonthDay: '09-30' },
    feeCents: 65000,
    effortMinutes: 540,
    questions: [
      {
        q: 'The $1,840 Patterson order on the 9th — supplies, or the new curing light (equipment)?',
        choices: ['Dental supplies', 'Equipment', 'Split — I will explain'],
      },
      {
        q: 'Delta Dental sent a $2,140 adjustment. Refund to a patient, or a claw-back?',
        choices: ['Patient refund', 'Insurance claw-back', 'Not sure'],
      },
    ],
    precedent: null,
  },
  {
    businessName: 'Lone Star Taqueria',
    contactName: 'Marisol Cruz',
    email: 'marisol@lonestartaqueria.example',
    phone: '+1 (512) 555-0163',
    industry: 'restaurant',
    notes: 'Single location on South Congress plus a catering trailer. Square for front of house, monthly sales tax.',
    seed: 3003,
    smsPhone: '+1 512 555 0163',
    accounts: [
      { name: 'Operating checking', kind: 'bank', institution: 'Broadway Bank', mask: '3390' },
      { name: 'Square balance', kind: 'other', institution: 'Square', mask: '0044' },
      { name: 'Business card', kind: 'credit_card', institution: 'Chase', mask: '6620' },
    ],
    categories: [
      { name: 'Food sales', kind: 'income' },
      { name: 'Catering', kind: 'income' },
      { name: 'Food & beverage', kind: 'cogs' },
      { name: 'Paper goods', kind: 'cogs' },
      { name: 'Payroll', kind: 'expense' },
      { name: 'Rent', kind: 'expense' },
      { name: 'Utilities', kind: 'expense' },
      { name: 'Merchant fees', kind: 'expense' },
      { name: 'Marketing', kind: 'expense' },
    ],
    vendors: [
      { name: 'Restaurant Depot', category: 'Food & beverage', amount: 1420, everyDays: 5, needsReceipt: true },
      { name: 'HEB', category: 'Food & beverage', amount: 380, everyDays: 4 },
      { name: 'Gusto', category: 'Payroll', amount: 16800, everyDays: 14 },
      { name: 'SoCo Property Group', category: 'Rent', amount: 7400, everyDays: 30 },
      { name: 'Square fees', category: 'Merchant fees', amount: 640, everyDays: 7, account: 1 },
      { name: 'Square deposit', category: 'Food sales', amount: 9800, everyDays: 3, income: true, account: 1 },
      { name: 'Catering — Barton Creek event', category: 'Catering', amount: 4200, everyDays: 24, income: true },
    ],
    bigVendor: { name: 'Sysco', count: 47, amount: 890 },
    duplicate: { vendor: 'SoCo Property Group', amount: 7400, category: 'Rent' },
    priceIncrease: { vendor: 'Austin Energy', from: 1180, to: 1690, category: 'Utilities' },
    closeStatus: 'in_progress',
    calendar: { salesTax: 'monthly', payroll: 'monthly', pays1099Contractors: false, renewalMonthDay: '06-30' },
    feeCents: 72500,
    effortMinutes: 980,
    questions: [
      {
        q: 'Two identical $7,400 rent payments went out three days apart. Did the landlord double-draft?',
        choices: ['Yes — chasing a refund', 'No, one was a deposit', 'Not sure'],
      },
      {
        q: 'The $1,690 Austin Energy bill is up 43% on last month. New equipment, or a rate change?',
        choices: ['New walk-in cooler', 'Rate change', 'Not sure'],
      },
    ],
    precedent: {
      title: 'Restaurant: Square deposits are net, not gross',
      body: 'Square deposits arrive net of fees. Book the gross sale to Food sales and the fee to Merchant fees from the Square settlement report — never book the deposit as revenue, or sales tax is computed on an understated base and the fee deduction is lost entirely.',
      tags: ['restaurant', 'square', 'sales-tax'],
    },
  },
  {
    businessName: 'Hill Country Outfitters',
    contactName: 'Beau Kessler',
    email: 'beau@hillcountryoutfitters.example',
    phone: '+1 (830) 555-0129',
    industry: 'ecommerce',
    notes: 'Shopify storefront out of Fredericksburg plus wholesale to three shops. Inventory-heavy, seasonal.',
    seed: 4004,
    smsPhone: '8305550129',
    accounts: [
      { name: 'Operating checking', kind: 'bank', institution: 'Wells Fargo', mask: '5540' },
      { name: 'Shopify payouts', kind: 'other', institution: 'Shopify Payments', mask: '0021' },
      { name: 'Amex business', kind: 'credit_card', institution: 'American Express', mask: '3007' },
    ],
    categories: [
      { name: 'Online sales', kind: 'income' },
      { name: 'Wholesale', kind: 'income' },
      { name: 'Cost of goods sold', kind: 'cogs' },
      { name: 'Shipping & fulfilment', kind: 'cogs' },
      { name: 'Merchant fees', kind: 'expense' },
      { name: 'Advertising', kind: 'expense' },
      { name: 'Software', kind: 'expense' },
      { name: 'Payroll', kind: 'expense' },
      { name: 'Warehouse rent', kind: 'expense' },
    ],
    vendors: [
      { name: 'USPS', category: 'Shipping & fulfilment', amount: 420, everyDays: 4 },
      { name: 'UPS', category: 'Shipping & fulfilment', amount: 680, everyDays: 7 },
      { name: 'Meta Ads', category: 'Advertising', amount: 1850, everyDays: 7, account: 2 },
      { name: 'Google Ads', category: 'Advertising', amount: 1240, everyDays: 7, account: 2 },
      { name: 'Gusto', category: 'Payroll', amount: 9200, everyDays: 14 },
      { name: 'Shopify', category: 'Software', amount: 399, everyDays: 30, account: 2 },
      { name: 'Shopify payout', category: 'Online sales', amount: 12400, everyDays: 3, income: true, account: 1 },
      { name: 'Wholesale — Gruene Mercantile', category: 'Wholesale', amount: 5600, everyDays: 21, income: true },
    ],
    bigVendor: { name: 'Shopify Shipping', count: 43, amount: 118, account: 2 },
    duplicate: { vendor: 'Meta Ads', amount: 1850, category: 'Advertising' },
    priceIncrease: { vendor: 'Fredericksburg Storage', from: 890, to: 1340, category: 'Warehouse rent' },
    closeStatus: 'not_started',
    calendar: { salesTax: 'monthly', payroll: 'monthly', pays1099Contractors: true, renewalMonthDay: '11-30' },
    feeCents: 58000,
    effortMinutes: 760,
    questions: [
      {
        q: 'The Amex has $1,340 at Fredericksburg Storage — is the second unit business inventory?',
        choices: ['Yes, inventory overflow', 'No, personal storage', 'Split'],
      },
    ],
    precedent: null,
  },
];

/** Firm-wide precedents — memory that survives staff turnover. */
const FIRM_PRECEDENTS = [
  {
    title: 'Texas: no state income tax does not mean no state filing',
    body: 'Every Texas entity files a franchise tax report by May 15, including no-tax-due filers, and the Public Information Report goes with it. Put it on the compliance calendar the day a client is onboarded. Informational only — the client confirms applicability with their CPA.',
    tags: ['texas', 'franchise-tax', 'compliance'],
  },
  {
    title: 'Never guess a sender onto a client',
    body: 'An inbound text or forwarded email from an identity we do not recognise goes to quarantine, full stop. Wrong client attribution in financial records is a reportable incident, and a wrong guess is far more expensive than a bookkeeper spending twenty seconds naming the sender.',
    tags: ['intake', 'quarantine', 'policy'],
  },
];

async function seedV1Demo(adminId: string): Promise<void> {
  const marker = await db.query.auditLog.findFirst({ where: eq(auditLog.action, DEMO_MARKER) });
  if (marker) {
    console.log('v1 demo book of business already seeded — skipping.');
    return;
  }

  for (const spec of CLIENT_SPECS) {
    const existing = await db.query.clients.findFirst({
      where: eq(clients.businessName, spec.businessName),
    });
    if (existing) {
      console.log(`  ${spec.businessName} already exists — skipping.`);
      continue;
    }
    await seedClient(spec, adminId);
    console.log(`  seeded ${spec.businessName}`);
  }

  // ---- Firm-wide memory -------------------------------------------------
  for (const p of FIRM_PRECEDENTS) {
    const have = await db.query.precedents.findFirst({ where: eq(precedents.title, p.title) });
    if (!have) {
      await db.insert(precedents).values({
        clientId: null,
        industry: null,
        title: p.title,
        body: p.body,
        tags: p.tags,
        createdBy: adminId,
      });
    }
  }

  // ---- Quarantine: senders nobody has claimed ---------------------------
  await seedQuarantine();

  await db.insert(auditLog).values({
    action: DEMO_MARKER,
    userId: adminId,
    entity: 'seed',
    entityId: 'demo_v1',
    meta: { clients: CLIENT_SPECS.map((c) => c.businessName), password: 'see DEMO_PASSWORD' },
  });

  console.log('v1 demo book of business created.');
  for (const spec of CLIENT_SPECS) {
    console.log(`  client login: ${spec.email} / ${DEMO_PASSWORD}`);
  }
}

/* -------------------------------------------------------------------------- */

async function seedClient(spec: ClientSpec, adminId: string): Promise<void> {
  const rand = rng(spec.seed);
  const slug = spec.businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const [client] = await db
    .insert(clients)
    .values({
      businessName: spec.businessName,
      contactName: spec.contactName,
      email: spec.email,
      phone: spec.phone,
      notes: spec.notes,
    })
    .returning();
  const clientId = client!.id;

  await db.insert(users).values({
    clientId,
    email: spec.email,
    passwordHash: await hashPassword(DEMO_PASSWORD),
    name: spec.contactName,
    role: 'client',
  });

  // ---- Accounts and chart of accounts ------------------------------------
  const accountRows = await db
    .insert(accounts)
    .values(
      spec.accounts.map((a) => ({
        clientId,
        name: a.name,
        kind: a.kind,
        institution: a.institution,
        mask: a.mask,
        externalSource: 'demo-import',
        externalId: `${slug}-${a.mask}`,
      })),
    )
    .returning();

  const categoryRows = await db
    .insert(categories)
    .values(spec.categories.map((c) => ({ clientId, name: c.name, kind: c.kind })))
    .returning();
  const categoryByName = new Map(categoryRows.map((c) => [c.name, c] as const));

  // ---- The ledger ---------------------------------------------------------
  type TxnInsert = typeof transactions.$inferInsert;
  const txns: TxnInsert[] = [];
  let n = 0;
  const nextExternalId = () => `${slug}-txn-${(n += 1)}`;

  const accountId = (i = 0) => accountRows[Math.min(i, accountRows.length - 1)]!.id;

  /** Categorised rows carry provenance: a rule hit, or a human decision. */
  const categorized = (name: string, byRule: boolean) => {
    const cat = categoryByName.get(name);
    return cat
      ? {
          categoryId: cat.id,
          categorizedBy: (byRule ? 'rule' : 'human') as 'rule' | 'human',
          categorizedById: byRule ? null : adminId,
          categorizedAt: new Date(),
          categoryConfidence: byRule ? 100 : null,
        }
      : {};
  };

  /** Base activity, before the deliberate demo piles are added. */
  const base: TxnInsert[] = [];
  for (const vendor of spec.vendors) {
    for (let day = 3; day < 120; day += vendor.everyDays) {
      const wobble = 0.85 + rand() * 0.3;
      const dollars = Math.round(vendor.amount * wobble * 100) / 100;
      const posted = daysAgo(day);
      // A slice of recent activity is deliberately left uncategorised — that is
      // what the categorize screen is for.
      const leaveOpen = day < 25 && rand() < 0.35;
      base.push({
        clientId,
        accountId: accountId(vendor.account ?? 0),
        postedAt: isoDay(posted),
        description: vendor.income ? `${vendor.name}` : `${vendor.name.toUpperCase()} #${1000 + Math.floor(rand() * 8999)}`,
        amountCents: Math.round(dollars * 100) * (vendor.income ? 1 : -1),
        counterparty: vendor.name,
        needsReceipt: Boolean(vendor.needsReceipt) && day < 40 && rand() < 0.3,
        // Anything older than the last close is reconciled; recent activity is not.
        reconciledAt: day > 45 ? daysAgo(day - 5) : null,
        externalId: nextExternalId(),
        ...(leaveOpen ? {} : categorized(vendor.category, rand() < 0.7)),
      });
    }
  }

  // Four months of a real small business is 60–80 lines, not two hundred. Thin
  // the generated activity evenly rather than truncating it, so the tail months
  // do not vanish and the cadence still reads as weekly.
  const MAX_BASE = 70;
  const keepEvery = base.length > MAX_BASE ? base.length / MAX_BASE : 1;
  for (let i = 0; i < base.length; i += 1) {
    if (Math.floor(i / keepEvery) !== Math.floor((i + 1) / keepEvery) || keepEvery === 1) {
      txns.push(base[i]!);
    }
  }

  // ---- The categorize demo: one vendor, forty-odd uncategorised charges ----
  for (let i = 0; i < spec.bigVendor.count; i += 1) {
    const day = 2 + Math.floor((i / spec.bigVendor.count) * 112);
    const dollars = Math.round(spec.bigVendor.amount * (0.6 + rand() * 0.9) * 100) / 100;
    txns.push({
      clientId,
      accountId: accountId(spec.bigVendor.account ?? 0),
      postedAt: isoDay(daysAgo(day)),
      description: `${spec.bigVendor.name.toUpperCase()} STORE #${210 + (i % 4)}`,
      amountCents: -Math.round(dollars * 100),
      counterparty: spec.bigVendor.name,
      externalId: nextExternalId(),
      // Uncategorised on purpose: this is the pile the co-pilot clears in one
      // decision instead of forty-four.
    });
  }

  // ---- Duplicate payment (same vendor, same cents, three days apart) -------
  const dupCents = -Math.round(spec.duplicate.amount * 100);
  const dupIds: string[] = [];
  for (const offset of [34, 31]) {
    txns.push({
      clientId,
      accountId: accountId(0),
      postedAt: isoDay(daysAgo(offset)),
      description: `${spec.duplicate.vendor.toUpperCase()} PAYMENT`,
      amountCents: dupCents,
      counterparty: spec.duplicate.vendor,
      externalId: nextExternalId(),
      reconciledAt: null,
      ...categorized(spec.duplicate.category, false),
    });
  }

  // ---- Price increase (same vendor, month over month, +40%ish) ------------
  for (const [offset, dollars] of [
    [66, spec.priceIncrease.from],
    [36, spec.priceIncrease.to],
    [6, spec.priceIncrease.to],
  ] as const) {
    txns.push({
      clientId,
      accountId: accountId(0),
      postedAt: isoDay(daysAgo(offset)),
      description: `${spec.priceIncrease.vendor.toUpperCase()} AUTOPAY`,
      amountCents: -Math.round(dollars * 100),
      counterparty: spec.priceIncrease.vendor,
      externalId: nextExternalId(),
      reconciledAt: offset > 45 ? daysAgo(offset - 5) : null,
      ...categorized(spec.priceIncrease.category, true),
    });
  }

  const insertedTxns = await db.insert(transactions).values(txns).returning({
    id: transactions.id,
    counterparty: transactions.counterparty,
    amountCents: transactions.amountCents,
    postedAt: transactions.postedAt,
  });

  for (const t of insertedTxns) {
    if (t.counterparty === spec.duplicate.vendor && t.amountCents === dupCents) dupIds.push(t.id);
  }
  const priceIds = insertedTxns
    .filter((t) => t.counterparty === spec.priceIncrease.vendor)
    .map((t) => t.id);

  // ---- Learned rules ------------------------------------------------------
  const ruleFor = (vendorName: string, categoryName: string, hits: number, source: 'learned' | 'manual', disabled = false) => {
    const cat = categoryByName.get(categoryName);
    if (!cat) return null;
    return {
      clientId,
      matchType: 'counterparty' as const,
      pattern: vendorName,
      categoryId: cat.id,
      source,
      createdBy: adminId,
      hitCount: hits,
      lastHitAt: daysAgo(2 + Math.floor(rand() * 20)),
      disabledAt: disabled ? daysAgo(9) : null,
    };
  };

  const ruleValues = [
    ruleFor(spec.vendors[0]!.name, spec.vendors[0]!.category, 34, 'learned'),
    ruleFor(spec.vendors[1]!.name, spec.vendors[1]!.category, 21, 'learned'),
    ruleFor(spec.vendors[3]?.name ?? spec.vendors[2]!.name, spec.vendors[3]?.category ?? spec.vendors[2]!.category, 12, 'learned'),
    ruleFor(spec.priceIncrease.vendor, spec.priceIncrease.category, 6, 'manual'),
    // Disabled on purpose, and it explains the pile: the learned rule for the
    // big vendor was switched off, so those charges are back to being a
    // decision somebody has to make.
    ruleFor(
      spec.bigVendor.name,
      (spec.categories.find((c) => c.kind === 'cogs') ?? spec.categories[1]!).name,
      2,
      'learned',
      true,
    ),
  ].filter((r): r is NonNullable<typeof r> => r !== null);
  await db.insert(categorizationRules).values(ruleValues);

  // ---- Open questions to the client --------------------------------------
  await db.insert(clientQuestions).values(
    spec.questions.map((q, i) => ({
      clientId,
      question: q.q,
      choices: q.choices,
      answer: q.answer ?? null,
      answeredAt: q.answer ? daysAgo(2) : null,
      answeredVia: q.answer ? ('sms' as const) : null,
      askedBy: adminId,
      createdAt: daysAgo(6 + i * 3),
    })),
  );

  // ---- Work items across kinds -------------------------------------------
  await db.insert(workItems).values([
    {
      clientId,
      kind: 'categorize',
      title: `${spec.bigVendor.count} transactions from ${spec.bigVendor.name}`,
      detail: 'One decision clears the pile — and learns the rule.',
      itemCount: spec.bigVendor.count,
      dueAt: daysAgo(-2),
      priority: 70,
    },
    {
      clientId,
      kind: 'reconcile',
      title: `Reconcile ${spec.accounts[0]!.name} ••${spec.accounts[0]!.mask}`,
      detail: 'Last month is not tied out yet.',
      dueAt: daysAgo(-1),
      assignedTo: adminId,
      priority: 55,
    },
    {
      clientId,
      kind: 'answer',
      title: `${spec.questions.filter((q) => !q.answer).length} open questions with ${spec.contactName}`,
      detail: 'Blocked on the client.',
      status: 'blocked' as const,
      dueAt: daysAgo(-4),
      priority: 40,
    },
    {
      clientId,
      kind: 'chase',
      title: 'Missing statements and receipts',
      detail: 'Digest goes out on the nudge interval, not one message per item.',
      dueAt: daysAgo(-7),
      priority: 25,
    },
    {
      clientId,
      kind: 'review',
      title: `Review the ${monthName(new Date(Date.now() - 30 * DAY))} package before it goes out`,
      detail: 'Second pair of eyes on the narrative and the balance sheet.',
      dueAt: daysAgo(-5),
      priority: 45,
      status: spec.closeStatus === 'delivered' ? ('done' as const) : ('open' as const),
      completedAt: spec.closeStatus === 'delivered' ? daysAgo(5) : null,
      completedBy: spec.closeStatus === 'delivered' ? adminId : null,
    },
    {
      clientId,
      kind: 'quarantine',
      title: 'An unrecognised sender may belong to this client',
      detail: 'Name the sender or leave it in quarantine — never guess.',
      dueAt: daysAgo(-6),
      priority: 30,
      relatedEntity: 'intake_items',
    },
    {
      clientId,
      kind: 'close',
      title: 'Month-end close',
      detail: `Currently ${spec.closeStatus.replace('_', ' ')}.`,
      dueAt: daysAgo(-3),
      assignedTo: adminId,
      priority: 60,
      status: spec.closeStatus === 'delivered' ? ('done' as const) : ('open' as const),
      completedAt: spec.closeStatus === 'delivered' ? daysAgo(4) : null,
      completedBy: spec.closeStatus === 'delivered' ? adminId : null,
    },
  ]);

  // ---- Close period -------------------------------------------------------
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const targetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 10));
  const delivered = spec.closeStatus === 'delivered';
  const drafted = spec.closeStatus === 'in_review' || delivered;

  const [period] = await db
    .insert(closePeriods)
    .values({
      clientId,
      periodStart: isoDay(periodStart),
      periodEnd: isoDay(periodEnd),
      targetDate: isoDay(targetDate),
      status: spec.closeStatus,
      ownerId: adminId,
      reviewerId: delivered ? adminId : null,
      deliveredAt: delivered ? new Date(periodEnd.getTime() + 8 * DAY) : null,
      narrative: drafted
        ? `${spec.businessName} closed ${monthName(periodStart)} with revenue in line with the prior month and one thing worth a look: ` +
          `${spec.priceIncrease.vendor} is now $${spec.priceIncrease.to} a month against $${spec.priceIncrease.from} before, ` +
          'which is a rate change rather than a one-off. Everything else reconciled cleanly. ' +
          'This is a summary of what the books show, not advice.'
        : null,
      narrativeApprovedBy: delivered ? adminId : null,
      narrativeApprovedAt: delivered ? new Date(periodEnd.getTime() + 7 * DAY) : null,
    })
    .returning();

  if (spec.closeStatus === 'in_review' || spec.closeStatus === 'preflight' || delivered) {
    await db.insert(closeChecks).values([
      {
        closePeriodId: period!.id,
        code: 'uncategorized',
        label: 'No uncategorised transactions in the period',
        severity: 'block' as const,
        passed: delivered,
        detail: delivered ? 'Nothing left uncategorised.' : `${spec.bigVendor.count} transactions from ${spec.bigVendor.name} are still open.`,
      },
      {
        closePeriodId: period!.id,
        code: 'reconciled',
        label: 'Every bank and card account reconciled through period end',
        severity: 'block' as const,
        passed: true,
        detail: 'All accounts tie to the statement balance.',
      },
      {
        closePeriodId: period!.id,
        code: 'open_questions',
        label: 'No unanswered client questions touching the period',
        severity: 'warn' as const,
        passed: false,
        detail: `${spec.questions.filter((q) => !q.answer).length} question(s) still open with the client.`,
      },
    ]);
  }

  // ---- Anomalies: one shared with the client, one not --------------------
  await db.insert(anomalies).values([
    {
      clientId,
      kind: 'duplicate_payment' as const,
      severity: 'high' as const,
      summary: `Two identical payments of $${spec.duplicate.amount.toLocaleString('en-US')} to ${spec.duplicate.vendor} three days apart`,
      detail: {
        amountCents: dupCents,
        vendor: spec.duplicate.vendor,
        why: 'Same counterparty, same cents, inside the duplicate window.',
      },
      transactionIds: dupIds,
      detectedBy: 'rule' as const,
      status: 'open' as const,
      createdAt: daysAgo(5),
    },
    {
      clientId,
      kind: 'price_increase' as const,
      severity: 'medium' as const,
      summary: `${spec.priceIncrease.vendor} is up ${Math.round(((spec.priceIncrease.to - spec.priceIncrease.from) / spec.priceIncrease.from) * 100)}% month over month`,
      detail: {
        fromCents: -spec.priceIncrease.from * 100,
        toCents: -spec.priceIncrease.to * 100,
        why: 'Recurring charge, same vendor, materially higher two months running.',
      },
      transactionIds: priceIds,
      detectedBy: 'ai' as const,
      status: 'shared' as const,
      sharedWithClientAt: daysAgo(3),
      resolvedBy: adminId,
      createdAt: daysAgo(8),
    },
    {
      clientId,
      kind: 'new_vendor' as const,
      severity: 'low' as const,
      summary: `First payment to ${spec.bigVendor.name} in this account`,
      detail: { vendor: spec.bigVendor.name, why: 'No prior history with this counterparty.' },
      transactionIds: [],
      detectedBy: 'rule' as const,
      status: 'dismissed' as const,
      resolvedBy: adminId,
      createdAt: daysAgo(21),
    },
  ]);

  // ---- Channel identity: the phone that makes SMS capture work -----------
  // linkIdentity normalises to E.164 and is idempotent, so the messy formats in
  // the specs above all land as +1XXXXXXXXXX.
  await linkIdentity({
    clientId,
    channel: 'sms',
    identity: spec.smsPhone,
    label: `${spec.contactName} — mobile`,
    verified: true,
    consent: true,
  });
  await linkIdentity({
    clientId,
    channel: 'email',
    identity: spec.email,
    label: 'Primary email',
    verified: true,
    consent: false,
  });

  // ---- Client-scoped precedent -------------------------------------------
  if (spec.precedent) {
    await db.insert(precedents).values({
      clientId,
      industry: spec.industry,
      title: spec.precedent.title,
      body: spec.precedent.body,
      tags: spec.precedent.tags,
      createdBy: adminId,
    });
  }

  // ---- Fees and effort ----------------------------------------------------
  await db.insert(invoices).values([
    {
      clientId,
      stripeInvoiceId: `in_demo_${slug}_1`,
      number: `BB-${2000 + Math.floor(rand() * 900)}`,
      amountDueCents: spec.feeCents,
      amountPaidCents: spec.feeCents,
      status: 'paid',
      issuedAt: daysAgo(62),
      dueAt: daysAgo(48),
      paidAt: daysAgo(52),
    },
    {
      clientId,
      stripeInvoiceId: `in_demo_${slug}_2`,
      number: `BB-${3000 + Math.floor(rand() * 900)}`,
      amountDueCents: spec.feeCents,
      amountPaidCents: 0,
      status: 'open',
      issuedAt: daysAgo(9),
      dueAt: daysAgo(-5),
    },
  ]);

  const effortEntries = [];
  let remaining = spec.effortMinutes;
  for (let i = 0; remaining > 0 && i < 40; i += 1) {
    const minutes = Math.min(remaining, 25 + Math.floor(rand() * 70));
    remaining -= minutes;
    effortEntries.push({
      clientId,
      userId: adminId,
      minutes,
      automatic: rand() < 0.8,
      occurredOn: isoDay(daysAgo(2 + Math.floor(rand() * 85))),
      note: i % 3 === 0 ? 'Queue time, derived from work items' : null,
    });
  }
  await db.insert(timeEntries).values(effortEntries);

  // ---- Outbound: two delivered, one that failed --------------------------
  await db.insert(outboundMessages).values([
    {
      clientId,
      channel: 'sms' as const,
      toIdentity: spec.smsPhone.replace(/\D/g, '').replace(/^1?/, '+1'),
      body: 'Got it — filed against your account. Nothing else needed.',
      purpose: 'capture_confirmation' as const,
      status: 'sent' as const,
      sentAt: daysAgo(4),
      createdAt: daysAgo(4),
    },
    {
      clientId,
      channel: 'sms' as const,
      toIdentity: spec.smsPhone.replace(/\D/g, '').replace(/^1?/, '+1'),
      body: '3 things we still need from you — check the portal, or text a photo back.',
      purpose: 'digest' as const,
      status: 'sent' as const,
      sentAt: daysAgo(11),
      createdAt: daysAgo(11),
    },
    {
      clientId,
      channel: 'sms' as const,
      toIdentity: spec.smsPhone.replace(/\D/g, '').replace(/^1?/, '+1'),
      body: 'Quick question about last week’s charge — one tap to answer in the portal.',
      purpose: 'question' as const,
      status: 'failed' as const,
      failureReason: 'twilio not configured on this environment',
      createdAt: daysAgo(2),
    },
  ]);

  // ---- Intake: things that arrived and were filed -------------------------
  await db.insert(intakeItems).values([
    {
      clientId,
      channel: 'sms' as const,
      externalId: `${slug}-sms-1`,
      senderIdentity: spec.smsPhone.replace(/\D/g, '').replace(/^1?/, '+1'),
      receivedAt: daysAgo(4),
      rawPayload: { From: spec.smsPhone, Body: 'receipt from this morning', NumMedia: '1' },
      mime: 'image/jpeg',
      sizeBytes: 184_320,
      contentHash: `${slug}-hash-1`,
      status: 'filed' as const,
      processedAt: daysAgo(4),
    },
    {
      clientId,
      channel: 'email' as const,
      externalId: `${slug}-email-1`,
      senderIdentity: spec.email,
      receivedAt: daysAgo(12),
      rawPayload: { from: spec.email, Subject: 'Statement attached', TextBody: 'Here is last month.' },
      mime: 'application/pdf',
      sizeBytes: 421_003,
      contentHash: `${slug}-hash-2`,
      status: 'filed' as const,
      processedAt: daysAgo(12),
    },
  ]);

  // ---- AI history ---------------------------------------------------------
  await seedAiRuns(clientId, adminId, rand);

  // ---- Services: calendar, chase list, health score ----------------------
  // All three are idempotent, and all three are the real implementations —
  // seeded data that was computed the way production computes it.
  await ensureCalendar(clientId, spec.calendar);
  const upcoming = await db.query.complianceEvents.findMany({
    where: eq(complianceEvents.clientId, clientId),
    limit: 2,
  });
  if (upcoming[0]) {
    await db
      .update(complianceEvents)
      .set({ status: 'in_progress' })
      .where(eq(complianceEvents.id, upcoming[0].id));
  }

  await syncRequests(clientId);
  await computeAndStore(clientId);
}

/**
 * `ai_runs` history. The shape matters more than the volume: the rules engine
 * answers most categorisations with no model call at all, and that ratio is
 * what the admin rules page reports.
 */
async function seedAiRuns(clientId: string, adminId: string, rand: () => number): Promise<void> {
  type RunInsert = typeof aiRuns.$inferInsert;
  const rows: RunInsert[] = [];

  const push = (row: Omit<RunInsert, 'clientId' | 'userId'>): void => {
    rows.push({ clientId, userId: adminId, ...row });
  };

  // Deterministic rule hits — no model, no tokens, sub-10ms.
  for (let i = 0; i < 32; i += 1) {
    push({
      task: 'categorize',
      provider: 'rules-engine',
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 1 + Math.floor(rand() * 7),
      confidence: 100,
      accepted: rand() < 0.95 ? true : null,
      relatedEntity: 'transactions',
      createdAt: daysAgo(1 + Math.floor(rand() * 90)),
    });
  }

  // Model calls — the ones the rules engine could not answer.
  for (let i = 0; i < 13; i += 1) {
    const confidence = 58 + Math.floor(rand() * 40);
    push({
      task: 'categorize',
      provider: 'stub',
      model: 'stub-deterministic',
      inputTokens: 900 + Math.floor(rand() * 700),
      outputTokens: 60 + Math.floor(rand() * 90),
      latencyMs: 320 + Math.floor(rand() * 900),
      confidence,
      // Below the threshold a suggestion is a question, not an answer, so it
      // sits unreviewed rather than counting against acceptance.
      accepted: confidence < 75 ? null : rand() < 0.82,
      relatedEntity: 'transactions',
      createdAt: daysAgo(1 + Math.floor(rand() * 90)),
    });
  }

  for (let i = 0; i < 9; i += 1) {
    push({
      task: 'extract',
      provider: 'stub',
      model: 'stub-deterministic',
      inputTokens: 1400 + Math.floor(rand() * 1200),
      outputTokens: 180 + Math.floor(rand() * 220),
      latencyMs: 700 + Math.floor(rand() * 1500),
      confidence: 70 + Math.floor(rand() * 28),
      accepted: rand() < 0.85,
      relatedEntity: 'intake_items',
      createdAt: daysAgo(1 + Math.floor(rand() * 70)),
    });
  }

  for (const [task, count] of [
    ['narrative', 3],
    ['anomaly', 4],
    ['reply_draft', 5],
    ['preflight', 2],
    ['precedent_search', 2],
  ] as const) {
    for (let i = 0; i < count; i += 1) {
      push({
        task,
        provider: 'stub',
        model: 'stub-deterministic',
        inputTokens: 600 + Math.floor(rand() * 1800),
        outputTokens: 120 + Math.floor(rand() * 400),
        latencyMs: 400 + Math.floor(rand() * 2000),
        confidence: 62 + Math.floor(rand() * 35),
        accepted: rand() < 0.6 ? true : rand() < 0.5 ? false : null,
        relatedEntity: task === 'narrative' ? 'close_periods' : null,
        createdAt: daysAgo(1 + Math.floor(rand() * 60)),
      });
    }
  }

  // One failure, kept: an error row is how the page proves it reports them.
  push({
    task: 'extract',
    provider: 'stub',
    model: 'stub-deterministic',
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 60_000,
    confidence: null,
    accepted: null,
    relatedEntity: 'intake_items',
    error: 'AiTimeoutError: provider did not respond within 60000ms',
    createdAt: daysAgo(6),
  });

  await db.insert(aiRuns).values(rows);
}

/** Senders nobody has claimed — the queue that must never auto-resolve. */
async function seedQuarantine(): Promise<void> {
  const items = [
    {
      channel: 'sms' as const,
      externalId: 'demo-quarantine-1',
      senderIdentity: '+15125550998',
      mime: 'image/jpeg',
      sizeBytes: 233_112,
      rawPayload: { From: '+15125550998', Body: 'here is the fuel receipt from the trailer', NumMedia: '1' },
      quarantineReason: 'sender not recognised on channel sms',
      receivedAt: daysAgo(2),
      contentHash: 'demo-quarantine-hash-1',
    },
    {
      channel: 'email' as const,
      externalId: 'demo-quarantine-2',
      senderIdentity: 'bookkeeping@acmecpa.example',
      mime: 'application/pdf',
      sizeBytes: 512_004,
      rawPayload: {
        from: 'bookkeeping@acmecpa.example',
        Subject: 'Q2 statements for our mutual client',
        TextBody: 'Attaching the statements you asked for.',
      },
      quarantineReason: 'sender not recognised on channel email',
      receivedAt: daysAgo(5),
      contentHash: 'demo-quarantine-hash-2',
    },
    {
      channel: 'whatsapp' as const,
      externalId: 'demo-quarantine-3',
      senderIdentity: '+18305550777',
      mime: 'image/jpeg',
      sizeBytes: 190_442,
      rawPayload: { from: '+18305550777', text: 'invoice for the storage unit' },
      quarantineReason: 'sender not recognised on channel whatsapp',
      receivedAt: daysAgo(9),
      contentHash: 'demo-quarantine-hash-3',
    },
  ];

  for (const item of items) {
    const have = await db.query.intakeItems.findFirst({
      where: eq(intakeItems.externalId, item.externalId),
    });
    if (have) continue;
    await db.insert(intakeItems).values({
      clientId: null,
      status: 'quarantined',
      ...item,
    });
  }
}

function monthName(d: Date): string {
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
