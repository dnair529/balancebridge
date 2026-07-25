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
} as const;

export type Config = typeof config;
