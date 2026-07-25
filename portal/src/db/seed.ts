/**
 * Idempotent seed:
 * - always: admin user from ADMIN_EMAIL/ADMIN_PASSWORD (skipped if it exists)
 * - SEED_DEMO=1: demo client + client user + sample docs-free data
 * Run: npm run db:seed
 */
import { eq } from 'drizzle-orm';
import { db, closeDb } from './index.js';
import {
  clients,
  users,
  threads,
  messages,
  taskLists,
  tasks,
  invoices,
  leads,
} from './schema.js';
import { hashPassword } from '../auth/password.js';
import { config } from '../config.js';

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

  // ---- Demo client ----
  const demoEmail = 'client@demo.balancebridge.us';
  let demoClient = await db.query.clients.findFirst({
    where: eq(clients.businessName, 'Lonestar Coffee Co.'),
  });
  if (demoClient) {
    console.log('Demo data already present — skipping.');
    return;
  }

  [demoClient] = await db
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

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
