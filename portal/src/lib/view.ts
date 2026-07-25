import { Eta } from 'eta';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { csrfTokenFor } from './csrf.js';

declare module 'fastify' {
  interface FastifyReply {
    /** Render an Eta template with layout + common locals and send as HTML. */
    viewPage(template: string, data?: Record<string, unknown>): Promise<FastifyReply>;
    /** Queue a one-shot flash message shown on the next rendered page. */
    flash(type: 'ok' | 'error', text: string): FastifyReply;
  }
}

export const eta = new Eta({
  views: config.viewsDir,
  cache: config.isProd,
  // Eta autoescapes interpolations by default (<%= %>); keep it that way.
  autoEscape: true,
});

const flashCookieOpts = {
  path: '/',
  httpOnly: true,
  secure: config.COOKIE_SECURE,
  sameSite: 'lax' as const,
  maxAge: 60,
};

function readFlash(req: FastifyRequest, reply: FastifyReply): { type: string; text: string } | null {
  const raw = req.cookies['flash'];
  if (!raw) return null;
  reply.clearCookie('flash', { path: '/' });
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed?.text === 'string' && typeof parsed?.type === 'string') return parsed;
  } catch {
    /* ignore malformed flash */
  }
  return null;
}

export function registerView(app: FastifyInstance): void {
  app.decorateReply('flash', function (this: FastifyReply, type: 'ok' | 'error', text: string) {
    this.setCookie('flash', Buffer.from(JSON.stringify({ type, text })).toString('base64url'), flashCookieOpts);
    return this;
  });

  app.decorateReply(
    'viewPage',
    async function (this: FastifyReply, template: string, data: Record<string, unknown> = {}) {
      const req = this.request;
      const html = eta.render(template, {
        user: req.authContext?.user ?? null,
        path: req.url.split('?')[0],
        query: req.query ?? {},
        csrf: csrfTokenFor(req, this),
        flash: readFlash(req, this),
        portalUrl: config.PORTAL_URL,
        fmtMoney: (cents: number, currency = 'usd') =>
          new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100),
        fmtDate: (d: Date | string | null) =>
          d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—',
        fmtDateTime: (d: Date | string | null) =>
          d
            ? new Date(d).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })
            : '—',
        fmtBytes: (n: number) =>
          n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`,
        ...data,
      });
      return this.type('text/html; charset=utf-8').send(html);
    },
  );
}
