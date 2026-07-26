import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Env parsing with zod — fail fast, before anything else boots.
 * No secrets ever have code defaults except clearly-dev-only ones.
 */
const bool = z
  .enum(['0', '1', 'true', 'false'])
  .transform((v) => v === '1' || v === 'true');

/**
 * Dev-only master key for file encryption. Production refuses to boot with it
 * (see the guard below), exactly like the SESSION_PEPPER placeholder.
 */
const DEV_FILE_ENCRYPTION_KEY = 'ZGV2LW9ubHktZmlsZS1lbmNyeXB0aW9uLWtleS0zMmI=';

/** base64 that decodes to exactly 32 bytes — the AES-256 key size. Empty = unset. */
const base64Key32 = z.string().refine(
  (v) => v === '' || Buffer.from(v, 'base64').length === 32,
  'must be base64-encoded 32 bytes (generate with: openssl rand -base64 32)',
);

/** A retention window in days. Whole days only, and never zero. */
const days = (fallback: number, floor = 1) => z.coerce.number().int().min(floor).default(fallback);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().url().or(z.string().startsWith('postgres')),

  // Pepper is mixed into token hashes; rotating it revokes everything outstanding.
  SESSION_PEPPER: z.string().min(32, 'SESSION_PEPPER must be at least 32 characters'),
  COOKIE_SECURE: bool.default('1'),

  SITE_URL: z.string().url().default('https://balancebridge.us'),
  PORTAL_URL: z.string().url().default('http://localhost:3000'),
  LEADS_EXTRA_ORIGINS: z.string().default(''),

  UPLOADS_DIR: z.string().default('./data/uploads'),

  ADMIN_EMAIL: z.string().email().default('admin@balancebridge.us'),
  ADMIN_PASSWORD: z.string().default(''),
  SEED_DEMO: bool.default('0'),
  DEMO_PASSWORD: z.string().default('demo-client-password'),

  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),

  DOCUSEAL_URL: z.string().url().or(z.literal('')).default(''),
  DOCUSEAL_API_KEY: z.string().default(''),
  DOCUSEAL_WEBHOOK_SECRET: z.string().default(''),

  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_SECURE: bool.default('0'),
  MAIL_FROM: z.string().default('Balance Bridge Financial <no-reply@balancebridge.us>'),
  FIRM_INBOX: z.string().email().default('hello@balancebridge.us'),

  // --- AI layer (src/ai). Provider-agnostic; `stub` is deterministic and needs no key.
  AI_PROVIDER: z.enum(['stub', 'anthropic', 'openai']).default('stub'),
  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-5'),
  ANTHROPIC_VERSION: z.string().default('2023-06-01'),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  ANTHROPIC_BASE_URL: z.string().default('https://api.anthropic.com/v1'),
  // Below this confidence (0-100) a suggestion is returned as needsHuman instead of a guess.
  AI_CONFIDENCE_THRESHOLD: z.coerce.number().int().min(0).max(100).default(75),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(60000),
  AI_MAX_TOKENS: z.coerce.number().int().min(64).max(32000).default(2048),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0),

  // --- Files at rest (src/lib/crypto.ts) ---------------------------------
  // Master key (KEK) that wraps every file's per-file data key. base64, 32
  // bytes. REQUIRED in production; falls back to a fixed dev key otherwise.
  FILE_ENCRYPTION_KEY: base64Key32.default(''),
  // Previous KEK, kept readable during a rotation window. New writes always
  // use FILE_ENCRYPTION_KEY; reads try the current key then this one.
  FILE_ENCRYPTION_KEY_PREVIOUS: base64Key32.default(''),

  // --- Database roles / RLS (src/db/rls.sql) -----------------------------
  // Owner-privileged URL used by migrations and apply-rls only. Defaults to
  // DATABASE_URL. Set this once DATABASE_URL points at the restricted app role.
  ADMIN_DATABASE_URL: z.string().default(''),
  // Non-superuser, non-owner role the app should connect as in production.
  APP_DB_ROLE: z.string().regex(/^[a-z_][a-z0-9_]*$/, 'APP_DB_ROLE must be a plain lowercase identifier').default('portal_app'),
  // Password set on APP_DB_ROLE when apply-rls creates it. Empty = don't touch
  // the password (the role is created NOLOGIN-safe and managed out of band).
  APP_DB_PASSWORD: z.string().default(''),

  // --- MFA policy (src/lib/mfa-policy.ts) --------------------------------
  // Anything other than the literal '0' means staff/admin MUST enrol in TOTP.
  REQUIRE_STAFF_MFA: z.string().default('1'),

  // --- Retention windows in days (src/lib/retention.ts) ------------------
  RETENTION_SESSIONS_DAYS: days(90),
  // Financial records: 7 years. Floored in the schema so a typo cannot shorten
  // it — audit_log is append-only and legally load-bearing.
  RETENTION_AUDIT_DAYS: days(2555, 2555),
  RETENTION_LEADS_DAYS: days(730),
  RETENTION_INTAKE_QUARANTINE_DAYS: days(180),
  RETENTION_OUTBOUND_DAYS: days(730),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast with a readable list of what is wrong — never boot half-configured.
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

// In production a dev-grade pepper is a misconfiguration, not a warning.
if (env.NODE_ENV === 'production' && env.SESSION_PEPPER.startsWith('dev-only')) {
  console.error('Refusing to start: SESSION_PEPPER is the dev placeholder.');
  process.exit(1);
}
if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
  console.error('Refusing to start: COOKIE_SECURE=0 is not allowed in production.');
  process.exit(1);
}
// Client financial records are encrypted at rest with this key. Booting
// production without a real one would silently encrypt every upload under a
// key that is published in this repository.
if (env.NODE_ENV === 'production') {
  if (!env.FILE_ENCRYPTION_KEY) {
    console.error('Refusing to start: FILE_ENCRYPTION_KEY is required in production.');
    console.error('  Generate one with: openssl rand -base64 32');
    process.exit(1);
  }
  if (env.FILE_ENCRYPTION_KEY === DEV_FILE_ENCRYPTION_KEY) {
    console.error('Refusing to start: FILE_ENCRYPTION_KEY is the dev placeholder.');
    process.exit(1);
  }
}
if (env.FILE_ENCRYPTION_KEY_PREVIOUS && env.FILE_ENCRYPTION_KEY_PREVIOUS === env.FILE_ENCRYPTION_KEY) {
  console.error('Refusing to start: FILE_ENCRYPTION_KEY_PREVIOUS equals FILE_ENCRYPTION_KEY.');
  console.error('  Clear it once the rotation is finished — a rotation window with one key is a no-op.');
  process.exit(1);
}

// Directory containing this module: <root>/src in dev (tsx), <root>/dist when built.
// Views are at src/views and are copied to dist/views by the build, so
// `<moduleDir>/views` is correct in both modes.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..');

/** Origins allowed to POST /api/leads (marketing site + local dev). */
const leadOrigins = new Set(
  [
    'https://balancebridge.us',
    'https://www.balancebridge.us',
    'https://uat.balancebridge.us',
    'http://localhost:4321', // Astro dev
    'http://localhost:3000',
    'http://127.0.0.1:4321',
    ...env.LEADS_EXTRA_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  ],
);

export const config = {
  ...env,
  isProd: env.NODE_ENV === 'production',
  isDev: env.NODE_ENV === 'development',
  projectRoot,
  // Uploads live OUTSIDE the web root; only the streaming download route reads them.
  uploadsDir: path.resolve(projectRoot, env.UPLOADS_DIR),
  viewsDir: path.join(moduleDir, 'views'),
  publicDir: path.join(projectRoot, 'public'),
  leadOrigins,
  // __Host- prefix requires Secure; fall back to a plain name for local HTTP dev.
  sessionCookieName: env.COOKIE_SECURE ? '__Host-session' : 'session',
  csrfCookieName: env.COOKIE_SECURE ? '__Host-csrf' : 'csrf',
  session: {
    idleMs: 24 * 60 * 60 * 1000, // 24h idle timeout
    absoluteMs: 14 * 24 * 60 * 60 * 1000, // 14d absolute lifetime
  },
  upload: {
    maxBytes: 25 * 1024 * 1024,
    allowedExtensions: new Set([
      'pdf', 'png', 'jpg', 'jpeg', 'csv', 'xlsx', 'xls', 'docx', 'doc', 'qbo', 'qbx', 'txt', 'zip',
    ]),
  },
  files: {
    /** Current KEK. Dev falls back to a published placeholder; prod cannot. */
    encryptionKey: env.FILE_ENCRYPTION_KEY || DEV_FILE_ENCRYPTION_KEY,
    /** Optional second KEK accepted on read during a rotation window. */
    previousKey: env.FILE_ENCRYPTION_KEY_PREVIOUS,
    usingDevKey: !env.FILE_ENCRYPTION_KEY,
  },
  /** Owner-privileged connection for migrations + RLS DDL. */
  adminDatabaseUrl: env.ADMIN_DATABASE_URL || env.DATABASE_URL,
  mfa: {
    /** Staff/admin must have TOTP enabled unless this is explicitly '0'. */
    requireStaff: env.REQUIRE_STAFF_MFA !== '0',
  },
  retention: {
    sessionsDays: env.RETENTION_SESSIONS_DAYS,
    auditDays: env.RETENTION_AUDIT_DAYS,
    leadsDays: env.RETENTION_LEADS_DAYS,
    intakeQuarantineDays: env.RETENTION_INTAKE_QUARANTINE_DAYS,
    outboundDays: env.RETENTION_OUTBOUND_DAYS,
    /** Hard floor for audit_log, independent of env. 7 years. */
    auditFloorDays: 2555,
  },
} as const;

export type Config = typeof config;
