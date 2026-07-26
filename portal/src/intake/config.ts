/**
 * Intake-layer configuration.
 *
 * Kept out of `src/config.ts` deliberately: the omnichannel layer adds a dozen
 * provider credentials and a handful of tuning knobs, and none of them should
 * be able to stop the portal from booting. Same conventions as `src/config.ts`
 * — zod, fail loudly on a *malformed* value, but every channel defaults to
 * "not configured" rather than to a broken half-configuration.
 *
 * Add to `.env` as channels come online:
 *
 * ```
 * INTAKE_PUBLIC_BASE_URL=https://portal.balancebridge.us
 * TWILIO_ACCOUNT_SID=AC...
 * TWILIO_AUTH_TOKEN=...            # also the SMS webhook signing key
 * TWILIO_FROM_NUMBER=+15125550100
 * WHATSAPP_PHONE_NUMBER_ID=...
 * WHATSAPP_ACCESS_TOKEN=...
 * WHATSAPP_APP_SECRET=...          # X-Hub-Signature-256 signing key
 * WHATSAPP_VERIFY_TOKEN=...        # GET webhook handshake
 * EMAIL_INBOUND_SECRET=...         # shared secret on the inbound-parse hook
 * EMAIL_INBOUND_DOMAIN=balancebridge.us
 * ```
 */

import { z } from 'zod';
import { config } from '../config.js';

const bool = z.enum(['0', '1', 'true', 'false']).transform((v) => v === '1' || v === 'true');

const IntakeEnvSchema = z.object({
  /** Public origin Twilio/Meta call. Signatures are computed over this URL. */
  INTAKE_PUBLIC_BASE_URL: z.string().url().or(z.literal('')).default(''),

  // --- Twilio (SMS/MMS + voice) ---
  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  TWILIO_FROM_NUMBER: z.string().default(''),
  /** Reject unsigned SMS/voice webhooks even in dev. Off only for local replay. */
  TWILIO_VERIFY_SIGNATURE: bool.default('1'),

  // --- WhatsApp (Meta Cloud API) ---
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
  WHATSAPP_ACCESS_TOKEN: z.string().default(''),
  WHATSAPP_APP_SECRET: z.string().default(''),
  WHATSAPP_VERIFY_TOKEN: z.string().default(''),
  WHATSAPP_API_BASE_URL: z.string().default('https://graph.facebook.com/v20.0'),

  // --- Inbound email parse hook ---
  EMAIL_INBOUND_SECRET: z.string().default(''),
  EMAIL_INBOUND_DOMAIN: z.string().default(''),

  // --- Watched cloud folder / bank feed (not built yet) ---
  CLOUD_FOLDER_PROVIDER: z.enum(['', 'gdrive', 'dropbox']).default(''),
  BANK_FEED_PROVIDER: z.enum(['', 'plaid', 'qbo']).default(''),

  // --- Pipeline tuning ---------------------------------------------------
  /** Matching window in days either side of the extracted document date. */
  INTAKE_MATCH_DATE_WINDOW_DAYS: z.coerce.number().int().min(0).max(90).default(5),
  /** Amount tolerance in cents applied after an exact-cents pass fails. */
  INTAKE_MATCH_AMOUNT_TOLERANCE_CENTS: z.coerce.number().int().min(0).max(10_000).default(200),
  /** At or above this a match auto-files. Below it a human sees it first. */
  INTAKE_MATCH_AUTOFILE_CONFIDENCE: z.coerce.number().int().min(0).max(100).default(80),
  /** Never send more than one digest per client per this many hours. */
  INTAKE_NUDGE_INTERVAL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(72),
  /** Trailing spend per vendor that makes a missing W-9 worth chasing. */
  INTAKE_W9_THRESHOLD_CENTS: z.coerce.number().int().min(0).default(60_000),
  /** How many closed months back `documentRequests` looks for statements. */
  INTAKE_STATEMENT_LOOKBACK_MONTHS: z.coerce.number().int().min(1).max(24).default(3),
  /** Longest inbound text still treated as a possible answer to a question. */
  INTAKE_REPLY_MAX_CHARS: z.coerce.number().int().min(1).max(2000).default(320),
});

const parsed = IntakeEnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid intake configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

export const intakeConfig = {
  ...env,
  /** Base URL a provider signs against. Falls back to the portal's own URL. */
  publicBaseUrl: (env.INTAKE_PUBLIC_BASE_URL || config.PORTAL_URL).replace(/\/+$/, ''),
  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    fromNumber: env.TWILIO_FROM_NUMBER,
    verifySignature: env.TWILIO_VERIFY_SIGNATURE,
    configured: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER),
  },
  whatsapp: {
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: env.WHATSAPP_ACCESS_TOKEN,
    appSecret: env.WHATSAPP_APP_SECRET,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    apiBaseUrl: env.WHATSAPP_API_BASE_URL.replace(/\/+$/, ''),
    configured: Boolean(env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN),
  },
  email: {
    inboundSecret: env.EMAIL_INBOUND_SECRET,
    domain: env.EMAIL_INBOUND_DOMAIN,
    /** Outbound email rides the existing SMTP transport, not a new one. */
    configured: Boolean(config.SMTP_HOST),
  },
  cloudFolder: { provider: env.CLOUD_FOLDER_PROVIDER, configured: false },
  bankFeed: { provider: env.BANK_FEED_PROVIDER, configured: false },
  match: {
    dateWindowDays: env.INTAKE_MATCH_DATE_WINDOW_DAYS,
    amountToleranceCents: env.INTAKE_MATCH_AMOUNT_TOLERANCE_CENTS,
    autofileConfidence: env.INTAKE_MATCH_AUTOFILE_CONFIDENCE,
  },
  nudge: {
    intervalHours: env.INTAKE_NUDGE_INTERVAL_HOURS,
    w9ThresholdCents: env.INTAKE_W9_THRESHOLD_CENTS,
    statementLookbackMonths: env.INTAKE_STATEMENT_LOOKBACK_MONTHS,
  },
  replyMaxChars: env.INTAKE_REPLY_MAX_CHARS,
} as const;

export type IntakeConfig = typeof intakeConfig;
