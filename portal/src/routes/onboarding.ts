/**
 * The onboarding wizard, colleague invites, and the client data export.
 *
 *   GET  /onboarding                 hub: progress + every section
 *   GET  /onboarding/:section        one of a..g
 *   POST /onboarding/:section        saves that section only
 *   POST /onboarding/invite          client owner invites a colleague
 *   GET  /onboarding/invite/:token   public accept page
 *   POST /onboarding/invite/:token   creates the colleague's account, signs in
 *   GET  /onboarding/export          the whole client's data as a zip
 *   GET  /export                     alias for the above
 *
 * ## Rules this file does not bend
 *
 * 1. **Client scope always comes from the session.** Client-role users go
 *    through `resolveClientId`, which reads the client_id off the user row and
 *    never consults the URL or the body. Staff must name a client explicitly and
 *    are then checked against their assignments via `assertClientAccess`.
 * 2. **Only a client owner may invite.** Enforced in the service
 *    (`inviteColleague` throws `NotClientOwnerError`), not only in the template,
 *    so hiding the form is a courtesy rather than the control.
 * 3. **Nothing here renders an EIN or a full account number.** Section (a)
 *    writes an encrypted EIN and shows a mask; section (c) accepts exactly four
 *    digits and says so on the page.
 * 4. **The agreement section never crashes on a missing integration.** Stripe
 *    and DocuSeal are optional; `paymentStep()` and `engagementLetterStep()`
 *    return a labelled pending state when the keys are absent.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { clients, users } from '../db/schema.js';
import { requireAuth, resolveClientId, isStaff } from '../auth/guards.js';
import { assertClientAccess } from '../auth/scope.js';
import { createSession } from '../auth/session.js';
import { hashPassword } from '../auth/password.js';
import { audit } from '../lib/audit.js';
import { sendMail, inviteEmail } from '../lib/mail.js';
import { linkIdentity, normalizePhone } from '../intake/identity.js';
import { MIN_PASSWORD } from '../services/signup.js';
import {
  ACCOUNT_KINDS,
  CLIENT_ACCESS_LEVELS,
  CONTACT_CHANNELS,
  DOCUMENT_CHECKLIST,
  ENTITY_TYPES,
  PAYMENT_OPTIONS,
  REVENUE_BANDS,
  SALES_TAX_FREQUENCIES,
  SECTIONS,
  SERVICES,
  SOFTWARE,
  NotClientOwnerError,
  acceptColleagueInvite,
  accessForInvite,
  colleagueInvites,
  completedSections,
  encryptEin,
  engagementLetterStep,
  findLiveInvite,
  getOrCreateOnboarding,
  inviteColleague,
  inviteLink,
  isInvitableAccess,
  isSectionKey,
  listFinancialAccounts,
  markSubmitted,
  maskEin,
  normalizeEin,
  paymentStep,
  parseAccountRows,
  progress,
  replaceFinancialAccounts,
  saveSection,
  sectionAnswers,
  suggestionFor,
  type SectionKey,
} from '../services/onboarding.js';
import { buildClientExport } from '../services/clientExport.js';

/* ========================================================================== */
/* Helpers                                                                     */
/* ========================================================================== */

/**
 * The one place a client id is decided. Client-role: the session's client, full
 * stop. Staff/admin: `?client=<uuid>`, checked against active assignments.
 * Returns null when the caller has been redirected or refused.
 */
async function scopedClientId(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const clientId = resolveClientId(req);
  if (!clientId) {
    await reply.redirect(isStaff(req) ? '/admin' : '/login', 303);
    return null;
  }
  if (isStaff(req)) {
    try {
      await assertClientAccess(req.authContext!.user, clientId);
    } catch {
      await reply.code(403).viewPage('error.eta', {
        title: 'Not allowed',
        message: 'You are not assigned to that client.',
      });
      return null;
    }
  }
  return clientId;
}

function str(body: Record<string, unknown>, key: string, max = 300): string {
  const v = body[key];
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function list(body: Record<string, unknown>, key: string): string[] {
  const v = body[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return [v];
  return [];
}

function num(body: Record<string, unknown>, key: string, max = 100000): number {
  const n = Number(str(body, key, 20));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), max);
}

function checked(body: Record<string, unknown>, key: string): boolean {
  const v = body[key];
  return v === 'on' || v === 'true' || v === '1' || v === 'yes';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ========================================================================== */

export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------ hub -- */

  app.get('/onboarding', { preHandler: requireAuth }, async (req, reply) => {
    const clientId = await scopedClientId(req, reply);
    if (!clientId) return reply;

    const row = await getOrCreateOnboarding(clientId);
    const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
    const done = new Set(completedSections(row));

    return reply.viewPage('onboarding/index.eta', {
      title: 'Onboarding',
      clientId,
      businessName: client?.businessName ?? 'your business',
      clientStatus: client?.status ?? 'pending',
      sections: SECTIONS.map((s) => ({ ...s, done: done.has(s.key) })),
      progress: progress(row),
      lastSavedAt: row.lastSavedAt,
      submittedAt: row.submittedAt,
      staffQuery: isStaff(req) ? `?client=${clientId}` : '',
    });
  });

  /* -------------------------------------------------------------- exports -- */

  const exportHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const clientId = await scopedClientId(req, reply);
    if (!clientId) return reply;

    const bundle = await buildClientExport(clientId);
    await audit(req, {
      action: 'client.data_export',
      clientId,
      entity: 'client',
      entityId: clientId,
      meta: { counts: bundle.counts, bytes: bundle.zip.length },
    });

    return reply
      .header('Content-Disposition', `attachment; filename="${bundle.filename}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Length', String(bundle.zip.length))
      .type('application/zip')
      .send(bundle.zip);
  };

  app.get('/onboarding/export', { preHandler: requireAuth }, exportHandler);
  app.get('/export', { preHandler: requireAuth }, exportHandler);

  /* ------------------------------------------------- colleague invites ----- */

  app.post('/onboarding/invite', { preHandler: requireAuth }, async (req, reply) => {
    const clientId = await scopedClientId(req, reply);
    if (!clientId) return reply;
    const user = req.authContext!.user;
    const dest = `/onboarding/d${isStaff(req) ? `?client=${clientId}` : ''}`;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = str(body, 'email', 254).toLowerCase();
    const name = str(body, 'name', 120);
    const access = str(body, 'access', 20);

    if (!EMAIL_RE.test(email) || !name) {
      return reply
        .flash('error', 'We need a name and a valid work email to send the invite.')
        .redirect(dest, 303);
    }
    if (!isInvitableAccess(access)) {
      return reply.flash('error', 'Pick Contributor or Full access.').redirect(dest, 303);
    }

    try {
      const { invite, token } = await inviteColleague({
        clientId,
        inviter: user,
        email,
        name,
        access,
      });
      await sendMail({ to: email, ...inviteEmail(inviteLink(token), user.name) });
      await audit(req, {
        action: 'client_invite.created',
        clientId,
        entity: 'invite',
        entityId: invite.inviteId,
        meta: { email, access, expiresAt: invite.expiresAt },
      });
      return reply
        .flash('ok', `Invite sent to ${email}. It expires in 7 days.`)
        .redirect(dest, 303);
    } catch (err) {
      if (err instanceof NotClientOwnerError) {
        await audit(req, {
          action: 'client_invite.denied',
          clientId,
          meta: { reason: 'not_owner', attemptedEmail: email, attemptedAccess: access },
        });
        return reply.code(403).viewPage('error.eta', {
          title: 'Not allowed',
          message:
            'Only the account owner can invite colleagues. Ask them to send the invite, or message us and we’ll do it.',
        });
      }
      throw err;
    }
  });

  /** Public accept page. Its own route so the recorded access level is applied. */
  app.get<{ Params: { token: string } }>('/onboarding/invite/:token', async (req, reply) => {
    const invite = await findLiveInvite(req.params.token);
    if (!invite) {
      return reply
        .flash('error', 'That invite is invalid or expired. Ask for a fresh one.')
        .redirect('/login', 303);
    }
    const client = await db.query.clients.findFirst({ where: eq(clients.id, invite.clientId!) });
    const access = await accessForInvite(invite.clientId!, invite.id);
    const level = CLIENT_ACCESS_LEVELS.find((l) => l.value === access);

    return reply.viewPage('onboarding/invite-accept.eta', {
      title: 'Join your team',
      token: req.params.token,
      email: invite.email,
      businessName: client?.businessName ?? 'your company',
      accessLabel: level?.label ?? 'Contributor',
      accessBlurb: level?.blurb ?? '',
      minPassword: MIN_PASSWORD,
    });
  });

  app.post<{ Params: { token: string } }>(
    '/onboarding/invite/:token',
    { config: { rateLimit: { max: 10, timeWindow: 15 * 60 * 1000 } } },
    async (req, reply) => {
      const invite = await findLiveInvite(req.params.token);
      if (!invite) {
        return reply
          .flash('error', 'That invite is invalid or expired. Ask for a fresh one.')
          .redirect('/login', 303);
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = str(body, 'name', 120);
      const password = typeof body['password'] === 'string' ? (body['password'] as string) : '';
      if (!name || password.length < MIN_PASSWORD) {
        return reply
          .flash('error', `Enter your name and a password of at least ${MIN_PASSWORD} characters.`)
          .redirect(`/onboarding/invite/${req.params.token}`, 303);
      }

      const created = await acceptColleagueInvite({
        inviteId: invite.id,
        clientId: invite.clientId!,
        email: invite.email,
        name,
        passwordHash: await hashPassword(password),
        invitedBy: invite.createdBy,
      });
      if (!created) {
        return reply
          .flash('error', 'An account with that email already exists. Sign in instead.')
          .redirect('/login', 303);
      }

      await audit(req, {
        action: 'client_invite.accepted',
        userId: created.id,
        clientId: invite.clientId,
        entity: 'invite',
        entityId: invite.id,
      });
      await createSession(reply, created.id, req);
      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, created.id));
      return reply.redirect('/onboarding', 303);
    },
  );

  /* ------------------------------------------------------------ sections -- */

  app.get<{ Params: { section: string } }>(
    '/onboarding/:section',
    { preHandler: requireAuth },
    async (req, reply) => {
      const key = req.params.section;
      if (!isSectionKey(key)) {
        return reply.redirect('/onboarding', 303);
      }
      const clientId = await scopedClientId(req, reply);
      if (!clientId) return reply;
      return renderSection(req, reply, clientId, key);
    },
  );

  app.post<{ Params: { section: string } }>(
    '/onboarding/:section',
    { preHandler: requireAuth },
    async (req, reply) => {
      const key = req.params.section;
      if (!isSectionKey(key)) return reply.redirect('/onboarding', 303);
      const clientId = await scopedClientId(req, reply);
      if (!clientId) return reply;

      const body = (req.body ?? {}) as Record<string, unknown>;
      const errors = await saveOne(req, clientId, key, body);

      if (errors.length > 0) {
        return renderSection(req, reply, clientId, key, errors);
      }

      await audit(req, {
        action: 'onboarding.section_saved',
        clientId,
        entity: 'client_onboarding',
        entityId: clientId,
        meta: { section: key },
      });

      const suffix = isStaff(req) ? `?client=${clientId}` : '';
      const idx = SECTIONS.findIndex((s) => s.key === key);
      const next = SECTIONS[idx + 1];
      const dest = next ? `/onboarding/${next.key}${suffix}` : `/onboarding${suffix}`;
      return reply.flash('ok', 'Saved. You can stop here and come back any time.').redirect(dest, 303);
    },
  );

  /* ====================================================================== */
  /* Rendering                                                               */
  /* ====================================================================== */

  async function renderSection(
    req: FastifyRequest,
    reply: FastifyReply,
    clientId: string,
    key: SectionKey,
    errors: string[] = [],
  ): Promise<FastifyReply> {
    const row = await getOrCreateOnboarding(clientId);
    const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
    const meta = SECTIONS.find((s) => s.key === key)!;
    const idx = SECTIONS.findIndex((s) => s.key === key);
    const done = new Set(completedSections(row));
    const suffix = isStaff(req) ? `?client=${clientId}` : '';

    const base: Record<string, unknown> = {
      title: meta.title,
      section: meta,
      sectionKey: key,
      sections: SECTIONS.map((s) => ({ ...s, done: done.has(s.key) })),
      stepNumber: idx + 1,
      totalSteps: SECTIONS.length,
      prev: SECTIONS[idx - 1] ?? null,
      next: SECTIONS[idx + 1] ?? null,
      progress: progress(row),
      answers: sectionAnswers(row, key),
      client,
      errors,
      hasErrors: errors.length > 0,
      staffQuery: suffix,
      actionUrl: `/onboarding/${key}${suffix}`,
    };

    switch (key) {
      case 'a':
        return reply.viewPage('onboarding/a.eta', {
          ...base,
          entityTypes: ENTITY_TYPES,
          einOnFile: Boolean(client?.einEncrypted),
          einMask: (sectionAnswers(row, 'a')['einMasked'] as string) ?? '',
        });
      case 'b':
        return reply.viewPage('onboarding/b.eta', {
          ...base,
          services: SERVICES,
          software: SOFTWARE,
          revenueBands: REVENUE_BANDS,
          salesTaxFrequencies: SALES_TAX_FREQUENCIES,
          selectedServices: new Set(
            Array.isArray(sectionAnswers(row, 'b')['services'])
              ? (sectionAnswers(row, 'b')['services'] as string[])
              : [],
          ),
        });
      case 'c': {
        const accounts = await listFinancialAccounts(clientId);
        return reply.viewPage('onboarding/c.eta', {
          ...base,
          accountKinds: ACCOUNT_KINDS,
          accounts,
          // Always render a few blank rows so adding one needs no JavaScript.
          blankRows: [0, 1, 2],
        });
      }
      case 'd':
        return reply.viewPage('onboarding/d.eta', {
          ...base,
          accessLevels: CLIENT_ACCESS_LEVELS,
          invites: colleagueInvites(row),
          isOwner: req.authContext!.user.clientAccess === 'owner',
          inviteAction: `/onboarding/invite${suffix}`,
        });
      case 'e':
        return reply.viewPage('onboarding/e.eta', {
          ...base,
          channels: CONTACT_CHANNELS,
          phones: Array.isArray(sectionAnswers(row, 'e')['phones'])
            ? (sectionAnswers(row, 'e')['phones'] as Array<Record<string, unknown>>)
            : [],
          blankRows: [0, 1],
        });
      case 'f':
        return reply.viewPage('onboarding/f.eta', {
          ...base,
          checklist: DOCUMENT_CHECKLIST,
          have: new Set(
            Array.isArray(sectionAnswers(row, 'f')['have'])
              ? (sectionAnswers(row, 'f')['have'] as string[])
              : [],
          ),
          uploadUrl: `/documents${suffix}`,
        });
      case 'g': {
        const suggestion = await suggestionFor(clientId);
        return reply.viewPage('onboarding/g.eta', {
          ...base,
          suggestion,
          paymentOptions: PAYMENT_OPTIONS,
          engagement: engagementLetterStep(),
          payment: paymentStep(),
          submittedAt: row.submittedAt,
        });
      }
    }
  }

  /* ====================================================================== */
  /* Saving — one function per section, all returning a list of errors        */
  /* ====================================================================== */

  async function saveOne(
    req: FastifyRequest,
    clientId: string,
    key: SectionKey,
    body: Record<string, unknown>,
  ): Promise<string[]> {
    switch (key) {
      /* ---------------------------------------------- A · business profile */
      case 'a': {
        const errors: string[] = [];
        const einRaw = str(body, 'ein', 20);
        let einMasked: string | undefined;
        let einEncrypted: string | undefined;

        if (einRaw) {
          const digits = normalizeEin(einRaw);
          if (!digits) {
            errors.push('An EIN is nine digits, like 12-3456789. Leave it blank if you don’t have it yet.');
          } else {
            einEncrypted = encryptEin(digits);
            einMasked = maskEin(digits);
          }
        }
        if (errors.length) return errors;

        const entityType = str(body, 'entityType', 20);
        await db
          .update(clients)
          .set({
            legalName: str(body, 'legalName', 200) || null,
            entityType: ENTITY_TYPES.some((e) => e.value === entityType)
              ? (entityType as (typeof ENTITY_TYPES)[number]['value'])
              : null,
            ...(einEncrypted ? { einEncrypted } : {}),
            formationState: str(body, 'formationState', 60) || null,
            addressLine1: str(body, 'addressLine1', 200) || null,
            addressLine2: str(body, 'addressLine2', 200) || null,
            city: str(body, 'city', 120) || null,
            state: str(body, 'state', 60) || null,
            postalCode: str(body, 'postalCode', 20) || null,
            website: str(body, 'website', 200) || null,
            fiscalYearEnd: str(body, 'fiscalYearEnd', 20) || null,
          })
          .where(eq(clients.id, clientId));

        await saveSection(clientId, 'a', {
          dba: str(body, 'dba', 200),
          formationDate: str(body, 'formationDate', 20),
          txTaxpayerNumber: str(body, 'txTaxpayerNumber', 30),
          mailingSameAsPhysical: checked(body, 'mailingSame'),
          mailingAddress: checked(body, 'mailingSame')
            ? null
            : {
                line1: str(body, 'mailingLine1', 200),
                line2: str(body, 'mailingLine2', 200),
                city: str(body, 'mailingCity', 120),
                state: str(body, 'mailingState', 60),
                postalCode: str(body, 'mailingPostalCode', 20),
              },
          // The mask, never the number. The number itself is encrypted on the
          // clients row and is not read back anywhere in this codebase.
          ...(einMasked ? { einMasked } : {}),
        });
        return [];
      }

      /* -------------------------------------------------- B · engagement */
      case 'b': {
        const services = list(body, 'services').filter((s) =>
          SERVICES.some((x) => x.value === s),
        );
        const monthsBehind = num(body, 'monthsBehind', 240);
        const software = str(body, 'currentSoftware', 60);
        const revenueBand = str(body, 'revenueBand', 40);
        const cpaEmail = str(body, 'cpaEmail', 254).toLowerCase();
        if (cpaEmail && !EMAIL_RE.test(cpaEmail)) {
          return ['That CPA email address doesn’t look right.'];
        }

        await db
          .update(clients)
          .set({
            monthsBehind,
            currentSoftware: software || null,
            revenueBand: revenueBand || null,
            cpaName: str(body, 'cpaName', 160) || null,
            cpaEmail: cpaEmail || null,
          })
          .where(eq(clients.id, clientId));

        await saveSection(clientId, 'b', {
          services,
          monthsBehind,
          currentSoftware: software,
          revenueBand,
          employees: num(body, 'employees', 100000),
          contractors: num(body, 'contractors', 100000),
          runsPayroll: checked(body, 'runsPayroll'),
          payrollProvider: str(body, 'payrollProvider', 120),
          collectsSalesTax: checked(body, 'collectsSalesTax'),
          salesTaxFrequency: str(body, 'salesTaxFrequency', 30),
          cpaName: str(body, 'cpaName', 160),
          cpaEmail,
          priorBookkeeper: str(body, 'priorBookkeeper', 200),
        });
        return [];
      }

      /* ------------------------------------------ C · financial accounts */
      case 'c': {
        const { rows, errors } = parseAccountRows(body);
        if (errors.length) return errors;
        await replaceFinancialAccounts(clientId, rows);
        await saveSection(clientId, 'c', {
          accountCount: rows.length,
          // Deliberately not the rows: the accounts table is the record. Storing
          // a second copy in jsonb would be a second place to leak from.
          confirmedNoFullNumbers: true,
        });
        return [];
      }

      /* ------------------------------------------- D · people and access */
      case 'd': {
        await saveSection(clientId, 'd', {
          authorizedSigner: str(body, 'authorizedSigner', 160),
          authorizedSignerTitle: str(body, 'authorizedSignerTitle', 120),
        });
        return [];
      }

      /* ------------------------------- E · communication preferences */
      case 'e': {
        // Repeatable phone rows, each with its OWN consent checkbox. A row whose
        // box is not ticked is stored without consent and no identity is opened
        // — we simply have a number we are not allowed to text.
        const numbers = list(body, 'phone');
        const labels = list(body, 'phoneLabel');
        const consented = new Set(list(body, 'phoneConsentRows'));

        const phones: Array<{ phone: string; label: string; consent: boolean }> = [];
        const errors: string[] = [];
        for (let i = 0; i < numbers.length; i += 1) {
          const raw = (numbers[i] ?? '').trim();
          if (!raw) continue;
          const e164 = normalizePhone(raw);
          if (!/^\+\d{10,15}$/.test(e164)) {
            errors.push(`“${raw.slice(0, 30)}” doesn’t look like a phone number we can text.`);
            continue;
          }
          phones.push({
            phone: e164,
            label: (labels[i] ?? '').slice(0, 80),
            consent: consented.has(String(i)),
          });
        }
        if (errors.length) return errors;

        for (const p of phones) {
          await linkIdentity({
            clientId,
            channel: 'sms',
            identity: p.phone,
            label: p.label || null,
            consent: p.consent,
          });
        }

        await saveSection(clientId, 'e', {
          preferredChannel: str(body, 'preferredChannel', 20),
          bestHours: str(body, 'bestHours', 120),
          monthlySummary: str(body, 'monthlySummary', 20),
          phones,
        });
        return [];
      }

      /* ------------------------------------------------- F · documents */
      case 'f': {
        const keys = new Set(DOCUMENT_CHECKLIST.map((d) => d.key as string));
        await saveSection(clientId, 'f', {
          have: list(body, 'have').filter((k) => keys.has(k)),
          notes: str(body, 'notes', 1000),
        });
        return [];
      }

      /* ------------------------------------------------- G · agreement */
      case 'g': {
        const pref = str(body, 'paymentPreference', 10);
        const suggestion = await suggestionFor(clientId);
        await saveSection(clientId, 'g', {
          // ACH is the default; anything unrecognised falls back to it rather
          // than silently selecting the more expensive option.
          paymentPreference: pref === 'card' ? 'card' : 'ach',
          reviewedPlan: suggestion.plan,
          reviewedMonthlyFeeCents: suggestion.monthlyFeeCents,
          reviewedAt: new Date().toISOString(),
          acknowledged: checked(body, 'acknowledge'),
        });
        await markSubmitted(clientId);
        await audit(req, {
          action: 'onboarding.submitted',
          clientId,
          entity: 'client_onboarding',
          entityId: clientId,
          meta: {
            suggestedPlan: suggestion.plan,
            suggestedMonthlyFeeCents: suggestion.monthlyFeeCents,
            catchUpFeeCents: suggestion.catchUpFeeCents,
            paymentPreference: pref === 'card' ? 'card' : 'ach',
          },
        });
        return [];
      }
    }
  }
}
