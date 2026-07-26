import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { closeDb } from './db/index.js';
import { ensureUploadsDir } from './lib/storage.js';
import { registerView } from './lib/view.js';
import { registerCsrfHook } from './lib/csrf.js';
import { authRoutes } from './routes/auth.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { documentRoutes } from './routes/documents.js';
import { messageRoutes } from './routes/messages.js';
import { taskRoutes } from './routes/tasks.js';
import { billingRoutes } from './routes/billing.js';
import { signatureRoutes } from './routes/signatures.js';
import { settingsRoutes } from './routes/settings.js';
import { adminRoutes } from './routes/admin.js';
import { leadRoutes } from './routes/leads.js';
import { webhookRoutes } from './routes/webhooks.js';
import { intakeRoutes } from './routes/intake.js';
import { workspaceRoutes } from './routes/workspace.js';
import { clientRoutes } from './routes/client.js';

async function build() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Never log cookies or auth headers.
      redact: ['req.headers.cookie', 'req.headers.authorization'],
    },
    trustProxy: true, // behind Caddy in production
    bodyLimit: 1024 * 1024, // 1MB for non-multipart bodies
  });

  // ---------- Plugins ----------
  await app.register(cookie, { secret: config.SESSION_PEPPER }); // signed-cookie support (TOTP pending)
  await app.register(formbody);
  await app.register(multipart, {
    limits: { fileSize: config.upload.maxBytes, files: 1, fields: 20 },
  });
  // hook:preHandler so per-route key generators can read the parsed body (IP+email).
  await app.register(rateLimit, { global: false, hook: 'preHandler' });
  await app.register(fastifyStatic, {
    root: config.publicDir,
    prefix: '/assets/',
    maxAge: config.isProd ? '1d' : 0,
  });

  registerView(app);
  registerCsrfHook(app);

  // ---------- Security headers on every response ----------
  app.addHook('onSend', async (req, reply) => {
    // No inline scripts anywhere (all JS is external) so CSP stays strict —
    // no nonces needed. img-src data: is for the TOTP QR code data URL.
    const frameSrc =
      reply.allowDocusealFrame && config.DOCUSEAL_URL
        ? `frame-src ${config.DOCUSEAL_URL}`
        : `frame-src 'none'`;
    reply.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self' https://*.stripe.com",
        "frame-ancestors 'none'",
        frameSrc,
      ].join('; '),
    );
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY'); // we embed DocuSeal; nobody embeds us
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.COOKIE_SECURE) {
      reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    }
    return;
  });

  // ---------- Error handling: no stack traces to the client ----------
  app.setErrorHandler<Error & { statusCode?: number }>(async (err, req, reply) => {
    if (err.statusCode === 429) {
      return reply.code(429).viewPage('error.eta', {
        title: 'Slow down',
        message: 'Too many attempts. Wait a bit and try again.',
      });
    }
    req.log.error({ err, url: req.url }, 'request failed');
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    return reply.code(status).viewPage('error.eta', {
      title: 'Something went wrong',
      message: 'We hit a snag on our side. Try again — if it keeps happening, message us.',
    });
  });

  app.setNotFoundHandler(async (_req, reply) => {
    return reply.code(404).viewPage('error.eta', {
      title: 'Page not found',
      message: 'That page doesn’t exist. Use the navigation to get back on track.',
    });
  });

  // ---------- Routes ----------
  await app.register(authRoutes);
  await app.register(dashboardRoutes);
  await app.register(clientRoutes);
  await app.register(documentRoutes);
  await app.register(messageRoutes);
  await app.register(taskRoutes);
  await app.register(billingRoutes);
  await app.register(signatureRoutes);
  await app.register(settingsRoutes);
  await app.register(adminRoutes);
  await app.register(workspaceRoutes);
  await app.register(leadRoutes);
  await app.register(webhookRoutes); // own scope: raw-body parser inside
  await app.register(intakeRoutes); // omnichannel intake; webhooks in a child scope

  return app;
}

async function main() {
  await ensureUploadsDir();
  const app = await build();

  // Graceful shutdown: stop accepting, drain, close DB pool.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await closeDb();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown error');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err) => {
  console.error('Fatal boot error:', err);
  process.exit(1);
});
