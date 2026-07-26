/**
 * Self-serve signup — "Start your free books review".
 *
 * DECISIONS.md §1: signup is self-serve and creates a `pending` client. It is
 * deliberately NOT called "sign up", because the firm's public promise is that
 * every engagement is quoted after a free review. This form *is* the review
 * intake, so it arrives with the qualification data (months behind, volume,
 * software, revenue band) that makes the first conversation useful.
 *
 * CLIENT-ONBOARDING-AND-ROLES.md §3: nine fields, one screen, ~60 seconds, plus
 * three SEPARATE unticked consents. Nothing sensitive is asked here — no EIN, no
 * addresses, no account details. Those come later in the wizard, once the client
 * has a reason to trust us with them.
 *
 * ## Three rules this module does not bend
 *
 * 1. **SMS consent is its own box.** TCPA requires explicit, documented opt-in.
 *    It is never bundled with terms, and never pre-ticked. No tick means no
 *    `channel_identities` row at all, so there is nothing to accidentally text.
 * 2. **A duplicate email reveals nothing.** `startReview` performs the same
 *    work, takes a comparable amount of time (one argon2 hash either way), and
 *    returns the same shape. The caller renders the same page.
 * 3. **The client lands in `pending`.** Pending is what stops self-serve signup
 *    from being a spam and fraud surface: a pending client can log in, complete
 *    onboarding and upload documents, but has no bookkeeper to message.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { clients, clientOnboarding, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { linkIdentity, normalizePhone } from '../intake/identity.js';

/* ========================================================================== */
/* Option lists — exported so the route, the view and the tests agree          */
/* ========================================================================== */

export const INDUSTRIES = [
  { value: 'construction-trades', label: 'Construction & trades' },
  { value: 'restaurants-hospitality', label: 'Restaurants & hospitality' },
  { value: 'medical-dental', label: 'Medical & dental' },
  { value: 'ecommerce-retail', label: 'Ecommerce & retail' },
  { value: 'professional-services', label: 'Professional services' },
  { value: 'real-estate', label: 'Real estate' },
  { value: 'other', label: 'Something else' },
] as const;

export const BOOKS_STATUSES = [
  { value: 'current', label: 'Current', hint: 'Reconciled through last month.' },
  { value: 'behind', label: 'Behind', hint: 'Some months are done, some aren’t.' },
  { value: 'never', label: 'Never kept', hint: 'It’s all in a shoebox or a bank app.' },
] as const;

/**
 * Transaction bands. These map directly onto the published plan boundaries
 * (~150/mo Essentials, ~400/mo Growth), so the suggested price is defensible.
 */
export const TXN_BANDS = [
  { value: '0-50', label: 'Under 50 a month' },
  { value: '51-150', label: '50 – 150 a month' },
  { value: '151-400', label: '150 – 400 a month' },
  { value: '401-1000', label: '400 – 1,000 a month' },
  { value: '1000+', label: 'More than 1,000 a month' },
] as const;

export const HEARD_ABOUT = [
  'Google search',
  'Referral from a friend or client',
  'My CPA',
  'Social media',
  'Saw an ad',
  'Somewhere else',
] as const;

const INDUSTRY_VALUES = new Set(INDUSTRIES.map((i) => i.value as string));
const BOOKS_VALUES = new Set(BOOKS_STATUSES.map((b) => b.value as string));
const BAND_VALUES = new Set(TXN_BANDS.map((b) => b.value as string));

/** Minimum password length, matching auth/reset. */
export const MIN_PASSWORD = 12;

/* ========================================================================== */
/* Validation                                                                  */
/* ========================================================================== */

export interface SignupValues {
  businessName: string;
  contactName: string;
  email: string;
  /** Raw as typed — normalised to E.164 only when we store it. */
  mobile: string;
  password: string;
  industry: string;
  booksStatus: string;
  txnVolumeBand: string;
  heardAbout: string;
  consentTerms: boolean;
  consentSms: boolean;
  consentMarketing: boolean;
}

export type SignupErrors = Partial<Record<keyof SignupValues, string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function str(body: Record<string, unknown>, key: string, max = 200): string {
  const v = body[key];
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** HTML checkboxes only submit when ticked — anything else is "not ticked". */
function checked(body: Record<string, unknown>, key: string): boolean {
  const v = body[key];
  return v === 'on' || v === 'true' || v === '1' || v === 'yes';
}

/**
 * Parse and validate the nine fields plus three consents.
 * Returns the (trimmed) values regardless, so the form can be re-rendered with
 * what they typed — except the password, which is never echoed back.
 */
export function parseSignup(raw: unknown): { values: SignupValues; errors: SignupErrors } {
  const body = (raw ?? {}) as Record<string, unknown>;
  const values: SignupValues = {
    businessName: str(body, 'businessName', 160),
    contactName: str(body, 'contactName', 120),
    email: str(body, 'email', 254).toLowerCase(),
    mobile: str(body, 'mobile', 40),
    password: typeof body['password'] === 'string' ? (body['password'] as string) : '',
    industry: str(body, 'industry', 60),
    booksStatus: str(body, 'booksStatus', 20),
    txnVolumeBand: str(body, 'txnVolumeBand', 20),
    heardAbout: str(body, 'heardAbout', 120),
    consentTerms: checked(body, 'consentTerms'),
    consentSms: checked(body, 'consentSms'),
    consentMarketing: checked(body, 'consentMarketing'),
  };

  const errors: SignupErrors = {};
  if (!values.businessName) errors.businessName = 'Tell us the business name.';
  if (!values.contactName) errors.contactName = 'Tell us your name.';
  if (!EMAIL_RE.test(values.email)) errors.email = 'That doesn’t look like an email address.';
  if (!isValidMobile(values.mobile)) {
    errors.mobile = 'Enter a mobile number we can reach you on, including the area code.';
  }
  if (values.password.length < MIN_PASSWORD) {
    errors.password = `Passwords need at least ${MIN_PASSWORD} characters.`;
  }
  if (!INDUSTRY_VALUES.has(values.industry)) errors.industry = 'Pick the closest industry.';
  if (!BOOKS_VALUES.has(values.booksStatus)) errors.booksStatus = 'Pick where your books stand.';
  if (!BAND_VALUES.has(values.txnVolumeBand)) errors.txnVolumeBand = 'Pick a rough monthly volume.';
  if (!values.consentTerms) {
    errors.consentTerms = 'We need your agreement to the terms and privacy policy.';
  }
  // heardAbout is genuinely optional. consentSms and consentMarketing are too.

  return { values, errors };
}

/** E.164 after normalisation, 10–15 digits. Anything else we refuse to store. */
export function isValidMobile(raw: string): boolean {
  return /^\+\d{10,15}$/.test(normalizePhone(raw));
}

/* ========================================================================== */
/* The write                                                                   */
/* ========================================================================== */

export interface SignupResult {
  /** 'created' — new client + owner user. 'duplicate' — email already known. */
  status: 'created' | 'duplicate';
  /** Only set on 'created'. Never surfaced to the browser on 'duplicate'. */
  clientId?: string;
  userId?: string;
  /** True when an SMS channel identity was opened (consent was given). */
  smsIdentityCreated: boolean;
}

/**
 * Create the pending client, the owner user and — only with consent — the SMS
 * capture channel.
 *
 * On a duplicate email nothing is written and `status` is `'duplicate'`. The
 * caller must render exactly the same response it renders for `'created'`; the
 * existing account holder gets an email instead. One argon2 hash runs on both
 * paths so the timing does not leak either.
 */
export async function startReview(values: SignupValues): Promise<SignupResult> {
  // Hash first, unconditionally: this is the expensive step, and doing it on
  // both paths is what keeps the response time from answering "does this email
  // have an account?".
  const passwordHash = await hashPassword(values.password);

  const existing = await db.query.users.findFirst({ where: eq(users.email, values.email) });
  if (existing) return { status: 'duplicate', smsIdentityCreated: false };

  const [client] = await db
    .insert(clients)
    .values({
      businessName: values.businessName,
      contactName: values.contactName,
      email: values.email,
      phone: normalizePhone(values.mobile),
      // Pending until an admin reviews, prices and assigns (§3).
      status: 'pending',
      industry: values.industry,
      booksStatus: values.booksStatus as 'current' | 'behind' | 'never',
      txnVolumeBand: values.txnVolumeBand,
      heardAbout: values.heardAbout || null,
    })
    .returning();

  const [user] = await db
    .insert(users)
    .values({
      clientId: client!.id,
      email: values.email,
      name: values.contactName,
      passwordHash,
      role: 'client',
      // The person who signs up is the client owner: the only client-side role
      // that may invite colleagues (DECISIONS.md §5).
      clientAccess: 'owner',
    })
    .returning();

  // Seed the wizard row so "resume" works from the very first visit, and record
  // the consent decisions where the audit trail can see them.
  await db.insert(clientOnboarding).values({
    clientId: client!.id,
    completedSections: [],
    answers: {
      consents: {
        terms: true,
        termsAt: new Date().toISOString(),
        sms: values.consentSms,
        marketingEmail: values.consentMarketing,
      },
    },
  });

  // TCPA: the identity exists only when the box was ticked. No row means there
  // is nothing to text, which is the correct failure mode.
  let smsIdentityCreated = false;
  if (values.consentSms) {
    await linkIdentity({
      clientId: client!.id,
      channel: 'sms',
      identity: values.mobile,
      label: `${values.contactName} (mobile)`,
      consent: true,
    });
    smsIdentityCreated = true;
  }

  return { status: 'created', clientId: client!.id, userId: user!.id, smsIdentityCreated };
}
