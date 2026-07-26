/**
 * The onboarding wizard — seven sections, saved independently, resumable.
 *
 * CLIENT-ONBOARDING-AND-ROLES.md §4. The shape of this module follows the one
 * insight in that section: a long single form produces garbage data, because an
 * owner filling in their EIN at 11pm on a phone abandons halfway. So every
 * section is its own POST, every POST is a complete unit of work, and the answer
 * blob is merged rather than replaced. Closing the laptop loses nothing.
 *
 * ## Rules this module does not bend
 *
 * 1. **The EIN is encrypted before it reaches the database and is never
 *    rendered in full.** `encryptEin` runs on the way in; `maskEin` is the only
 *    way out. There is deliberately no decrypt-and-render helper here — nothing
 *    in the client-facing wizard needs one.
 * 2. **We never ask for a full account number or an online-banking password.**
 *    Section (c) accepts exactly four digits and rejects five. This is stated on
 *    the page as well as enforced here, because saying it out loud is a trust
 *    signal (§4C).
 * 3. **Only a client `owner` may invite colleagues** (DECISIONS.md §5), into
 *    'contributor' or 'full' — never another owner, never staff. Invites expire
 *    in seven days.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  clientFinancialAccounts,
  clientOnboarding,
  clients,
  invites,
  users,
} from '../db/schema.js';
import { encryptBuffer } from '../lib/crypto.js';
import { generateToken, hashToken } from '../auth/tokens.js';
import { config } from '../config.js';
import { docusealConfigured } from '../lib/docuseal.js';

/* ========================================================================== */
/* Sections                                                                    */
/* ========================================================================== */

export const SECTION_KEYS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export interface SectionMeta {
  key: SectionKey;
  title: string;
  blurb: string;
  /** Sections A–C unlock a real quote — the wizard says so, so people finish. */
  unlocksQuote: boolean;
}

export const SECTIONS: SectionMeta[] = [
  {
    key: 'a',
    title: 'Business profile',
    blurb: 'The legal facts. Two minutes, and we never ask for them again.',
    unlocksQuote: true,
  },
  {
    key: 'b',
    title: 'The engagement',
    blurb: 'What you want us doing, and what shape the books are in today.',
    unlocksQuote: true,
  },
  {
    key: 'c',
    title: 'Financial accounts',
    blurb: 'What we will reconcile. Last four digits only — never full numbers.',
    unlocksQuote: true,
  },
  {
    key: 'd',
    title: 'People and access',
    blurb: 'Anyone else at your company who needs the portal.',
    unlocksQuote: false,
  },
  {
    key: 'e',
    title: 'Communication preferences',
    blurb: 'How you want to hear from us, and which numbers we may text.',
    unlocksQuote: false,
  },
  {
    key: 'f',
    title: 'Documents',
    blurb: 'A checklist. Every item can be photographed from your phone.',
    unlocksQuote: false,
  },
  {
    key: 'g',
    title: 'Agreement',
    blurb: 'Your suggested plan, the engagement letter, and payment.',
    unlocksQuote: false,
  },
];

export function isSectionKey(v: unknown): v is SectionKey {
  return typeof v === 'string' && (SECTION_KEYS as readonly string[]).includes(v);
}

/* ========================================================================== */
/* Option lists                                                                */
/* ========================================================================== */

export const ENTITY_TYPES = [
  { value: 'sole_prop', label: 'Sole proprietor' },
  { value: 'llc', label: 'LLC' },
  { value: 's_corp', label: 'S-corp' },
  { value: 'c_corp', label: 'C-corp' },
  { value: 'partnership', label: 'Partnership' },
  { value: 'nonprofit', label: 'Nonprofit' },
  { value: 'other', label: 'Other' },
] as const;

export const SERVICES = [
  { value: 'monthly-bookkeeping', label: 'Monthly bookkeeping' },
  { value: 'bank-reconciliation', label: 'Bank reconciliation' },
  { value: 'quickbooks-setup-cleanup', label: 'QuickBooks setup or cleanup' },
  { value: 'accounts-payable-receivable', label: 'AP & AR' },
  { value: 'payroll-support', label: 'Payroll support' },
  { value: 'financial-reporting', label: 'Financial reporting' },
  { value: 'cash-flow-budgeting', label: 'Cash flow & budgeting' },
  { value: 'controller-cfo-advisory', label: 'Controller & CFO advisory' },
  { value: 'new-business-setup', label: 'New business setup' },
  { value: 'tax-prep-coordination', label: 'Tax prep coordination' },
] as const;

export const SOFTWARE = [
  'QuickBooks Online',
  'QuickBooks Desktop',
  'Xero',
  'Wave',
  'Spreadsheets',
  'Nothing yet',
] as const;

export const REVENUE_BANDS = [
  'Under $250k',
  '$250k – $500k',
  '$500k – $1M',
  '$1M – $3M',
  '$3M – $10M',
  'Over $10M',
] as const;

export const SALES_TAX_FREQUENCIES = ['Monthly', 'Quarterly', 'Annually', 'Not sure'] as const;

export const ACCOUNT_KINDS = [
  { value: 'bank', label: 'Bank account' },
  { value: 'credit_card', label: 'Credit card' },
  { value: 'loan', label: 'Loan' },
  { value: 'merchant', label: 'Merchant / POS (Square, Stripe, Shopify, Toast)' },
  { value: 'payroll', label: 'Payroll provider' },
  { value: 'other', label: 'Other' },
] as const;

export const CLIENT_ACCESS_LEVELS = [
  {
    value: 'contributor',
    label: 'Contributor',
    blurb:
      'Can capture and upload, and answer questions about items they sent. Cannot see reports, insights, or billing. This is the receipts-and-invoices role.',
  },
  {
    value: 'full',
    label: 'Full access',
    blurb: 'Everything you see, except inviting others and billing.',
  },
] as const;

export const CONTACT_CHANNELS = [
  { value: 'sms', label: 'Text message' },
  { value: 'email', label: 'Email' },
  { value: 'portal', label: 'Portal only' },
  { value: 'phone', label: 'Phone call' },
] as const;

/** §4F. Each item links to the existing upload flow — we do not rebuild it. */
export const DOCUMENT_CHECKLIST = [
  {
    key: 'prior_tax_return',
    label: 'Prior year tax return',
    hint: 'The full return your CPA filed, including schedules.',
    folder: 'Tax',
  },
  {
    key: 'bank_statements',
    label: 'Last three bank statements, per account',
    hint: 'PDFs from the bank, or clear photos of the paper copies.',
    folder: 'Bank statements',
  },
  {
    key: 'chart_of_accounts',
    label: 'Chart of accounts export',
    hint: 'From QuickBooks or Xero, if you have one.',
    folder: 'General',
  },
  {
    key: 'formation_docs',
    label: 'Formation documents and EIN letter',
    hint: 'Certificate of formation, operating agreement, IRS CP-575.',
    folder: 'General',
  },
  {
    key: 'w9s',
    label: 'W-9s for contractors',
    hint: 'Collecting these now makes January painless.',
    folder: 'General',
  },
  {
    key: 'voided_check',
    label: 'Voided check or bank letter',
    hint: 'Optional. Helps us label the account correctly.',
    folder: 'General',
  },
  {
    key: 'qbo_invite',
    label: 'QuickBooks accountant invite',
    hint: 'A read-only accountant invite — revocable, and no password changes hands.',
    folder: 'General',
  },
] as const;

/* ========================================================================== */
/* State: read, merge, save                                                    */
/* ========================================================================== */

export type OnboardingRow = typeof clientOnboarding.$inferSelect;

/** Answers are jsonb, so treat everything read back as untrusted shape. */
export type Answers = Record<string, unknown>;

export async function getOrCreateOnboarding(clientId: string): Promise<OnboardingRow> {
  const existing = await db.query.clientOnboarding.findFirst({
    where: eq(clientOnboarding.clientId, clientId),
  });
  if (existing) return existing;
  const [row] = await db
    .insert(clientOnboarding)
    .values({ clientId, completedSections: [], answers: {} })
    .returning();
  return row!;
}

export function answersOf(row: OnboardingRow): Answers {
  const a = row.answers;
  return a && typeof a === 'object' && !Array.isArray(a) ? (a as Answers) : {};
}

/** The saved answers for one section, always an object. */
export function sectionAnswers(row: OnboardingRow, key: SectionKey): Answers {
  const v = answersOf(row)[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Answers) : {};
}

export function completedSections(row: OnboardingRow): SectionKey[] {
  const v = row.completedSections;
  if (!Array.isArray(v)) return [];
  return v.filter(isSectionKey);
}

export function progress(row: OnboardingRow): { done: number; total: number; percent: number } {
  const done = completedSections(row).length;
  const total = SECTION_KEYS.length;
  return { done, total, percent: Math.round((done / total) * 100) };
}

/**
 * Merge one section's answers and mark it complete. Deliberately a merge, not a
 * replace: a client who reopens section (a) and saves it again must not wipe
 * section (b). `markComplete: false` saves a draft without ticking the section.
 */
export async function saveSection(
  clientId: string,
  key: SectionKey,
  data: Answers,
  opts: { markComplete?: boolean } = {},
): Promise<OnboardingRow> {
  const row = await getOrCreateOnboarding(clientId);
  const merged: Answers = { ...answersOf(row), [key]: { ...sectionAnswers(row, key), ...data } };

  const done = new Set(completedSections(row));
  if (opts.markComplete !== false) done.add(key);

  const [updated] = await db
    .update(clientOnboarding)
    .set({
      answers: merged,
      completedSections: SECTION_KEYS.filter((k) => done.has(k)),
      lastSavedAt: new Date(),
    })
    .where(eq(clientOnboarding.clientId, clientId))
    .returning();
  return updated!;
}

/** Mark the whole wizard submitted. Idempotent. */
export async function markSubmitted(clientId: string): Promise<void> {
  await db
    .update(clientOnboarding)
    .set({ submittedAt: new Date(), lastSavedAt: new Date() })
    .where(eq(clientOnboarding.clientId, clientId));
}

/* ========================================================================== */
/* EIN — encrypted in, masked out                                              */
/* ========================================================================== */

/** Nine digits, however the client typed it. Returns '' when it isn't one. */
export function normalizeEin(raw: string): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits.length === 9 ? digits : '';
}

/**
 * Encrypt an EIN for `clients.ein_encrypted`.
 * Uses the same envelope as files at rest (lib/crypto) so there is exactly one
 * key-management story in the system, and stores it base64 in a text column.
 */
export function encryptEin(ein: string): string {
  return encryptBuffer(Buffer.from(ein, 'utf8')).toString('base64');
}

/**
 * The ONLY way an EIN comes back out. Takes the plaintext the client just
 * typed (or nothing) and renders `••-•••1234`. There is no decrypt helper in
 * this module on purpose — the wizard never needs to show it again.
 */
export function maskEin(ein: string | null | undefined): string {
  const digits = (ein ?? '').replace(/\D/g, '');
  if (digits.length < 4) return '';
  return `••-•••${digits.slice(-4)}`;
}

/** True when the client already has an EIN on file (so the form can say so). */
export function hasEin(client: { einEncrypted: string | null }): boolean {
  return Boolean(client.einEncrypted);
}

/* ========================================================================== */
/* Section C — financial accounts                                              */
/* ========================================================================== */

export interface AccountInput {
  institution: string;
  nickname: string;
  kind: string;
  last4: string;
  active: boolean;
}

const KIND_VALUES = new Set(ACCOUNT_KINDS.map((k) => k.value as string));

/** EXACTLY four digits. Five is a mistake; nine is an account number. */
export function isValidLast4(v: string): boolean {
  return /^\d{4}$/.test(v ?? '');
}

/**
 * Parse the repeatable rows posted by section (c).
 * `@fastify/formbody` gives a string for one row and an array for several, so
 * both shapes are normalised here rather than in the route.
 */
export function parseAccountRows(raw: unknown): {
  rows: AccountInput[];
  errors: string[];
} {
  const body = (raw ?? {}) as Record<string, unknown>;
  const col = (name: string): string[] => {
    const v = body[name];
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x.trim() : ''));
    if (typeof v === 'string') return [v.trim()];
    return [];
  };

  const institution = col('institution');
  const nickname = col('nickname');
  const kind = col('kind');
  const last4 = col('last4');
  // Checkboxes only post when ticked, so a positional `active` column would
  // silently shift. Each row's checkbox instead carries its own row index as its
  // value, and membership of that set is the answer. Pure HTML, no JavaScript.
  const activeRows = new Set(col('activeRows'));

  const rows: AccountInput[] = [];
  const errors: string[] = [];

  for (let i = 0; i < institution.length; i += 1) {
    const inst = (institution[i] ?? '').slice(0, 120);
    const l4 = (last4[i] ?? '').trim();
    const k = kind[i] ?? '';
    // A wholly blank row is just an unused slot in the form — skip it silently.
    if (!inst && !l4 && !(nickname[i] ?? '')) continue;

    if (!inst) {
      errors.push(`Row ${i + 1}: tell us which institution this is with.`);
      continue;
    }
    if (!KIND_VALUES.has(k)) {
      errors.push(`Row ${i + 1}: pick what kind of account this is.`);
      continue;
    }
    if (!isValidLast4(l4)) {
      errors.push(
        `Row ${i + 1} (${inst}): the last four digits must be exactly four digits — and never the full number.`,
      );
      continue;
    }
    rows.push({
      institution: inst,
      nickname: (nickname[i] ?? '').slice(0, 120),
      kind: k,
      last4: l4,
      active: activeRows.has(String(i)),
    });
  }
  return { rows, errors };
}

export async function listFinancialAccounts(clientId: string) {
  return db
    .select()
    .from(clientFinancialAccounts)
    .where(eq(clientFinancialAccounts.clientId, clientId))
    .orderBy(asc(clientFinancialAccounts.createdAt));
}

/**
 * Replace the client's account list with what section (c) just posted.
 * Replace rather than append, because the form shows the whole list and the
 * client expects deleting a row to delete the row.
 */
export async function replaceFinancialAccounts(
  clientId: string,
  rows: AccountInput[],
): Promise<void> {
  for (const r of rows) {
    if (!isValidLast4(r.last4)) {
      // Belt and braces: a caller that skipped parseAccountRows still cannot
      // write a full account number into the database.
      throw new Error('last4 must be exactly four digits');
    }
  }
  await db.delete(clientFinancialAccounts).where(eq(clientFinancialAccounts.clientId, clientId));
  if (rows.length === 0) return;
  await db.insert(clientFinancialAccounts).values(
    rows.map((r) => ({
      clientId,
      institution: r.institution,
      nickname: r.nickname || null,
      kind: r.kind as 'bank' | 'credit_card' | 'loan' | 'merchant' | 'payroll' | 'other',
      last4: r.last4,
      active: r.active,
    })),
  );
}

/* ========================================================================== */
/* Section D — colleague invites                                               */
/* ========================================================================== */

export type ClientAccess = 'contributor' | 'full';

export function isInvitableAccess(v: unknown): v is ClientAccess {
  return v === 'contributor' || v === 'full';
}

export interface ColleagueInvite {
  inviteId: string;
  email: string;
  name: string;
  access: ClientAccess;
  invitedAt: string;
  expiresAt: string;
  acceptedAt?: string;
}

/**
 * The `invites` table has no access-level column (it predates client roles), and
 * this feature is not allowed to change the schema. The intended access level is
 * therefore recorded alongside the invite id in the onboarding answers, which is
 * this module's own storage, and read back at accept time. The invite row itself
 * remains the security object: token hash, expiry and single-use all live there.
 */
export function colleagueInvites(row: OnboardingRow): ColleagueInvite[] {
  const v = sectionAnswers(row, 'd')['invites'];
  if (!Array.isArray(v)) return [];
  return v.filter(
    (i): i is ColleagueInvite =>
      Boolean(i) && typeof i === 'object' && typeof (i as ColleagueInvite).inviteId === 'string',
  );
}

export class NotClientOwnerError extends Error {
  readonly statusCode = 403;
  constructor() {
    super('Only the account owner can invite colleagues.');
    this.name = 'NotClientOwnerError';
  }
}

/** Seven days, per DECISIONS.md §5. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Invite a colleague at the client's own company.
 *
 * Throws `NotClientOwnerError` unless the inviter is a client-role user with
 * `clientAccess = 'owner'` on THIS client. Staff and admin do not use this path
 * — they have the admin invite screen.
 */
export async function inviteColleague(input: {
  clientId: string;
  inviter: { id: string; role: string; clientId: string | null; clientAccess: string | null };
  email: string;
  name: string;
  access: ClientAccess;
}): Promise<{ invite: ColleagueInvite; token: string }> {
  const { inviter } = input;
  if (
    inviter.role !== 'client' ||
    inviter.clientAccess !== 'owner' ||
    inviter.clientId !== input.clientId
  ) {
    throw new NotClientOwnerError();
  }
  if (!isInvitableAccess(input.access)) throw new NotClientOwnerError();

  const token = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const [row] = await db
    .insert(invites)
    .values({
      email: input.email,
      clientId: input.clientId,
      role: 'client',
      tokenHash: hashToken(token),
      expiresAt,
      createdBy: inviter.id,
    })
    .returning();

  const record: ColleagueInvite = {
    inviteId: row!.id,
    email: input.email,
    name: input.name,
    access: input.access,
    invitedAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  const current = await getOrCreateOnboarding(input.clientId);
  const list = [...colleagueInvites(current).filter((i) => i.inviteId !== record.inviteId), record];
  await saveSection(input.clientId, 'd', { invites: list }, { markComplete: false });

  return { invite: record, token };
}

/** The accept link we email. Its own route so the access level is honoured. */
export function inviteLink(token: string): string {
  return `${config.PORTAL_URL}/onboarding/invite/${token}`;
}

/** Look up a live invite by raw token. Null when missing, used or expired. */
export async function findLiveInvite(token: string) {
  const row = await db.query.invites.findFirst({
    where: and(eq(invites.tokenHash, hashToken(token)), isNull(invites.acceptedAt)),
  });
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  if (!row.clientId || row.role !== 'client') return null;
  return row;
}

/** The recorded access level for an invite; contributor is the safe default. */
export async function accessForInvite(clientId: string, inviteId: string): Promise<ClientAccess> {
  const row = await getOrCreateOnboarding(clientId);
  const rec = colleagueInvites(row).find((i) => i.inviteId === inviteId);
  return isInvitableAccess(rec?.access) ? rec!.access : 'contributor';
}

/**
 * Create the colleague's user row from a live invite. Returns null when the
 * email is already taken — the caller sends them to sign in instead.
 */
export async function acceptColleagueInvite(input: {
  inviteId: string;
  clientId: string;
  email: string;
  name: string;
  passwordHash: string;
  invitedBy: string;
}): Promise<{ id: string } | null> {
  const existing = await db.query.users.findFirst({ where: eq(users.email, input.email) });
  if (existing) return null;

  const access = await accessForInvite(input.clientId, input.inviteId);
  const [user] = await db
    .insert(users)
    .values({
      clientId: input.clientId,
      email: input.email,
      name: input.name,
      passwordHash: input.passwordHash,
      role: 'client',
      // Never 'owner': an invite cannot mint another owner (DECISIONS.md §5).
      clientAccess: access,
      invitedBy: input.invitedBy,
    })
    .returning();

  await db.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, input.inviteId));

  const row = await getOrCreateOnboarding(input.clientId);
  const list = colleagueInvites(row).map((i) =>
    i.inviteId === input.inviteId ? { ...i, acceptedAt: new Date().toISOString() } : i,
  );
  await saveSection(input.clientId, 'd', { invites: list }, { markComplete: false });

  return { id: user!.id };
}

/* ========================================================================== */
/* Pricing suggestion — a pure function                                        */
/* ========================================================================== */

export type Plan = 'essentials' | 'growth' | 'controller_plus';

export interface PlanInputs {
  /** One of TXN_BANDS values. Unknown or null scores as the smallest band. */
  txnVolumeBand: string | null;
  /** How many accounts we would reconcile (section C rows). */
  accountCount: number;
  /** Months of catch-up work before the first live close. */
  monthsBehind: number;
  /** SERVICES values selected in section B. */
  services: string[];
}

export interface PlanSuggestion {
  plan: Plan;
  planLabel: string;
  monthlyFeeCents: number;
  /** One-off catch-up project, 50% at signature / 50% at delivery (§2). */
  catchUpFeeCents: number;
  /** The complexity score the tier was derived from. Shown to the admin. */
  score: number;
  /** Plain-English reasons, so the number is never a black box. */
  reasons: string[];
  closeTargetDay: number;
}

/** Published "starting at" prices (site/src/data/pricing.ts). */
const PLAN_PRICES: Record<Plan, number> = {
  essentials: 39500,
  growth: 79500,
  controller_plus: 149500,
};

const PLAN_LABELS: Record<Plan, string> = {
  essentials: 'Essentials',
  growth: 'Growth',
  controller_plus: 'Controller+',
};

/** Public close promise per tier (DECISIONS.md §7). */
const PLAN_CLOSE_DAY: Record<Plan, number> = {
  essentials: 15,
  growth: 10,
  controller_plus: 8,
};

const BAND_POINTS: Record<string, number> = {
  '0-50': 0,
  '51-150': 1,
  '151-400': 3,
  '401-1000': 5,
  '1000+': 7,
};

/** Services that imply a finance function rather than clean-books-only. */
const ADVISORY_SERVICES = new Set(['controller-cfo-advisory', 'cash-flow-budgeting']);
const OPERATIONAL_SERVICES = new Set(['accounts-payable-receivable', 'payroll-support']);

/**
 * Derive a suggested tier and price from the wizard's answers.
 *
 * Pure — no database, no clock, no config. Same inputs, same output, which is
 * what makes it testable and what makes the admin's override meaningful: the
 * suggestion is a starting point they can argue with, not an oracle.
 *
 * Scoring (complexity points):
 *
 * | Signal              | Points                                              |
 * |---------------------|-----------------------------------------------------|
 * | Monthly volume      | <50: 0 · 50-150: 1 · 150-400: 3 · 400-1k: 5 · 1k+: 7 |
 * | Accounts to reconcile | ≤2: 0 · 3-5: 1 · 6-9: 3 · 10+: 5                  |
 * | Months behind       | 0: 0 · 1-3: 1 · 4-12: 2 · 12+: 3                     |
 * | Advisory service    | +4 if any (forecasting, budgeting, CFO advisory)     |
 * | AP/AR or payroll    | +2 each                                              |
 *
 * Tier: ≤2 → Essentials · 3–8 → Growth · ≥9 → Controller+
 *
 * Catch-up is quoted separately because it is front-loaded labour with no
 * recurring revenue attached yet: $750 base plus 40% of the monthly fee for
 * every month behind, rounded to the nearest $25.
 */
export function suggestPlan(input: PlanInputs): PlanSuggestion {
  const reasons: string[] = [];
  let score = 0;

  const bandPoints = BAND_POINTS[input.txnVolumeBand ?? ''] ?? 0;
  score += bandPoints;
  if (bandPoints >= 5) reasons.push('High transaction volume needs weekly attention, not a month-end catch-up.');
  else if (bandPoints >= 3) reasons.push('Mid-range transaction volume.');
  else reasons.push('Low transaction volume.');

  const accounts = Math.max(0, Math.floor(input.accountCount));
  const accountPoints = accounts >= 10 ? 5 : accounts >= 6 ? 3 : accounts >= 3 ? 1 : 0;
  score += accountPoints;
  reasons.push(
    `${accounts} account${accounts === 1 ? '' : 's'} to reconcile${accountPoints >= 3 ? ' — that is a real reconciliation load' : ''}.`,
  );

  const months = Math.max(0, Math.floor(input.monthsBehind));
  const monthPoints = months > 12 ? 3 : months >= 4 ? 2 : months >= 1 ? 1 : 0;
  score += monthPoints;
  if (months > 0) reasons.push(`${months} month${months === 1 ? '' : 's'} of catch-up before the first live close.`);
  else reasons.push('Books are current, so we start with a live close.');

  const services = Array.isArray(input.services) ? input.services : [];
  if (services.some((s) => ADVISORY_SERVICES.has(s))) {
    score += 4;
    reasons.push('You asked for forward-looking work (forecasting, budgets, advisory).');
  }
  for (const s of services) {
    if (OPERATIONAL_SERVICES.has(s)) {
      score += 2;
      reasons.push(
        s === 'payroll-support'
          ? 'Payroll support adds a monthly reconciliation and deadline watch.'
          : 'AP/AR support takes bill and invoice workflows off your desk.',
      );
    }
  }

  const plan: Plan = score >= 9 ? 'controller_plus' : score >= 3 ? 'growth' : 'essentials';
  const monthlyFeeCents = PLAN_PRICES[plan];

  const catchUpFeeCents =
    months > 0 ? roundToCents(75000 + months * monthlyFeeCents * 0.4, 2500) : 0;

  return {
    plan,
    planLabel: PLAN_LABELS[plan],
    monthlyFeeCents,
    catchUpFeeCents,
    score,
    reasons,
    closeTargetDay: PLAN_CLOSE_DAY[plan],
  };
}

function roundToCents(value: number, step: number): number {
  return Math.round(value / step) * step;
}

export function planLabel(plan: Plan): string {
  return PLAN_LABELS[plan];
}

/** Pull the suggestion's inputs out of the saved answers and run it. */
export async function suggestionFor(clientId: string): Promise<PlanSuggestion> {
  const row = await getOrCreateOnboarding(clientId);
  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  const accounts = await listFinancialAccounts(clientId);
  const b = sectionAnswers(row, 'b');
  const services = Array.isArray(b['services']) ? (b['services'] as string[]) : [];
  const monthsBehind = Number(b['monthsBehind'] ?? client?.monthsBehind ?? 0);

  return suggestPlan({
    txnVolumeBand: client?.txnVolumeBand ?? null,
    accountCount: accounts.filter((a) => a.active).length,
    monthsBehind: Number.isFinite(monthsBehind) ? monthsBehind : 0,
    services,
  });
}

/* ========================================================================== */
/* Section G — engagement letter and payment, both degrade gracefully          */
/* ========================================================================== */

export interface PendingStep {
  /** True when the integration has credentials and can actually be driven. */
  configured: boolean;
  heading: string;
  body: string;
  /** Where to go when it IS configured. Null otherwise. */
  href: string | null;
}

/**
 * DocuSeal is already built (routes/signatures.ts). We link to it when it is
 * configured and show an honest pending state when it is not — never a dead
 * button, and never a crash because a key is missing in this environment.
 */
export function engagementLetterStep(): PendingStep {
  if (docusealConfigured()) {
    return {
      configured: true,
      heading: 'Engagement letter',
      body: 'Your engagement letter is prepared for signature in the portal. It sets out scope, fee, and how either of us ends the arrangement.',
      href: '/signatures',
    };
  }
  return {
    configured: false,
    heading: 'Engagement letter — pending',
    body: 'We’ll send this once your review is complete. It will arrive here for e-signature; nothing is signed before you have seen the scope and the fee in writing.',
    href: null,
  };
}

/**
 * Payment. ACH is the DEFAULT and card is the alternative — DECISIONS.md §2:
 * ACH is roughly 0.8% capped at $5, cards are 2.9% + 30¢, which on an
 * $795/month engagement is about $5 versus $23.
 */
export interface PaymentOption {
  value: 'ach' | 'card';
  label: string;
  detail: string;
  recommended: boolean;
}

export const PAYMENT_OPTIONS: PaymentOption[] = [
  {
    value: 'ach',
    label: 'Bank transfer (ACH)',
    detail: 'Recommended. Processing fees are a fraction of card fees, so more of what you pay goes into the work rather than into the card network.',
    recommended: true,
  },
  {
    value: 'card',
    label: 'Credit or debit card',
    detail: 'Also fine, and set up the same way. Card processing costs more, which is why we default to bank transfer.',
    recommended: false,
  },
];

export function paymentStep(): PendingStep {
  if (config.STRIPE_SECRET_KEY) {
    return {
      configured: true,
      heading: 'Payment method',
      body: 'Payment is captured with the engagement letter and the first charge happens the day your bookkeeper is assigned. Card details go straight to Stripe — they never touch our servers.',
      href: '/billing',
    };
  }
  return {
    configured: false,
    heading: 'Payment method — pending',
    body: 'We’ll send this once your review is complete. When it arrives it will be a Stripe-hosted page, so no card or bank details ever reach us.',
    href: null,
  };
}
