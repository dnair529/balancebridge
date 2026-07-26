/**
 * Public signup — GET/POST /start (alias /signup).
 *
 *   GET  /start        the conversion page. Public, no session, no nav chrome.
 *   POST /start        creates the pending client + owner user, signs them in.
 *   GET  /start/next   the identical landing page both outcomes redirect to.
 *   GET  /signup       → /start (the URL people type)
 *   POST /signup       same handler as POST /start
 *
 * ## What this route is careful about
 *
 * - **Rate limited hard.** This is the one unauthenticated write endpoint that
 *   creates rows in three tables. 5 posts per 15 minutes per IP.
 * - **CSRF on the POST** via the global hook — the page embeds the anonymous
 *   double-submit token, exactly like /login.
 * - **A duplicate email is indistinguishable.** Both outcomes 303 to
 *   /start/next and render the same page. The existing account holder gets an
 *   email telling them someone tried; nobody learns anything from the response.
 * - **Three consent boxes, three inputs, none pre-ticked.** They are separate
 *   `<input type="checkbox">` elements with distinct names. SMS consent is never
 *   bundled with the terms — that is a TCPA requirement, not a preference.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { validateSession, createSession } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mail.js';
import { config } from '../config.js';
import {
  BOOKS_STATUSES,
  HEARD_ABOUT,
  INDUSTRIES,
  MIN_PASSWORD,
  TXN_BANDS,
  parseSignup,
  startReview,
  type SignupErrors,
  type SignupValues,
} from '../services/signup.js';

/** 5 attempts / 15 minutes / IP. Signup is the softest target in the app. */
const startRateLimit = {
  rateLimit: {
    max: 5,
    timeWindow: 15 * 60 * 1000,
    keyGenerator: (req: FastifyRequest) => `start:${req.ip}`,
  },
};

function renderForm(
  reply: FastifyReply,
  values: Partial<SignupValues>,
  errors: SignupErrors = {},
): Promise<FastifyReply> {
  return reply.viewPage('signup/start.eta', {
    title: 'Start your free books review',
    industries: INDUSTRIES,
    booksStatuses: BOOKS_STATUSES,
    txnBands: TXN_BANDS,
    heardAbout: HEARD_ABOUT,
    minPassword: MIN_PASSWORD,
    values: { ...values, password: '' }, // never echo a password back
    errors,
    hasErrors: Object.keys(errors).length > 0,
    siteUrl: config.SITE_URL,
  });
}

export async function signupRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------------------------------------- GET ---- */

  const showForm = async (req: FastifyRequest, reply: FastifyReply) => {
    // Already signed in? There is nothing to start.
    if (await validateSession(req)) return reply.redirect('/onboarding', 303);
    return renderForm(reply, {});
  };

  app.get('/start', { config: { rateLimit: { max: 60, timeWindow: 60 * 1000 } } }, showForm);
  app.get('/signup', async (_req, reply) => reply.redirect('/start', 303));

  /**
   * The landing page BOTH outcomes reach. Same status, same Location, same
   * markup — the only difference between a new signup and a duplicate is the
   * session cookie, which the person triggering the probe does not receive.
   */
  app.get('/start/next', async (req, reply) => {
    const ctx = await validateSession(req);
    return reply.viewPage('signup/next.eta', {
      title: 'We’ve got it',
      signedIn: Boolean(ctx),
    });
  });

  /* --------------------------------------------------------------- POST ---- */

  const submit = async (req: FastifyRequest, reply: FastifyReply) => {
    const { values, errors } = parseSignup(req.body);

    if (Object.keys(errors).length > 0) {
      await audit(req, {
        action: 'signup.rejected',
        meta: { fields: Object.keys(errors) },
      });
      reply.code(422);
      return renderForm(reply, values, errors);
    }

    const result = await startReview(values);

    if (result.status === 'duplicate') {
      // Same work, same response. Tell the real account holder instead.
      const existing = await db.query.users.findFirst({ where: eq(users.email, values.email) });
      await sendMail({
        to: values.email,
        subject: 'Your Balance Bridge books review',
        text: `Someone just started a free books review using this email address.

You already have a Balance Bridge portal account, so there is nothing new to set up — sign in and pick up where you left off:
${config.PORTAL_URL}/login

If that wasn't you, ignore this. Your password is unchanged and nothing about your account was altered.

— Balance Bridge Financial`,
      });
      await audit(req, {
        action: 'signup.duplicate_email',
        userId: existing?.id ?? null,
        meta: { businessName: values.businessName.slice(0, 120) },
      });
      return reply.redirect('/start/next', 303);
    }

    await audit(req, {
      action: 'signup.started',
      userId: result.userId!,
      clientId: result.clientId!,
      entity: 'client',
      entityId: result.clientId!,
      meta: {
        businessName: values.businessName,
        industry: values.industry,
        booksStatus: values.booksStatus,
        txnVolumeBand: values.txnVolumeBand,
        heardAbout: values.heardAbout || null,
        // The consent decisions are the legally load-bearing part of this form.
        consent: {
          terms: values.consentTerms,
          sms: values.consentSms,
          marketingEmail: values.consentMarketing,
        },
        smsIdentityCreated: result.smsIdentityCreated,
      },
    });

    await createSession(reply, result.userId!, req);
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, result.userId!));

    return reply.redirect('/start/next', 303);
  };

  app.post('/start', { config: startRateLimit }, submit);
  app.post('/signup', { config: startRateLimit }, submit);
}
