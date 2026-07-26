/**
 * The admin read-model — everything the firm's owner needs to see about the
 * machinery the v1 subsystems introduced, in one place.
 *
 * Five questions this module answers, and nothing else:
 *
 *   1. **Is the plumbing connected?** {@link integrationRows} — one row per
 *      provider, comparing what the `integrations` table last recorded against
 *      what the environment actually has *right now*.
 *   2. **Is the rules engine earning its keep?** {@link rulesOverview} — every
 *      learned and manual rule, plus the share of categorisations resolved
 *      without a model call at all.
 *   3. **Is the AI safe and improving?** {@link aiUsage} — per-task volume,
 *      confidence, acceptance and cost.
 *   4. **What arrived that we could not name?** {@link quarantineQueue}.
 *   5. **Is the firm on top of the work?** {@link systemHealth}.
 *
 * ## The one hard rule in this file
 *
 * **A secret's *value* never leaves this module.** Integration probes report
 * booleans — "`STRIPE_SECRET_KEY` is present" — and never the string itself.
 * `settings` on an `integrations` row is documented as non-secret, but nothing
 * here renders it either: presence is the only fact the admin page needs, and a
 * page that never has a secret in its locals cannot leak one.
 *
 * Reads only, with two deliberate exceptions that are named as writes:
 * {@link recheckIntegration} (refreshes `last_checked_at` / `last_error`) and
 * nothing else. Everything else in here is a SELECT.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  aiRuns,
  anomalies,
  auditLog,
  categories,
  categorizationRules,
  channelIdentities,
  clients,
  closePeriods,
  clientQuestions,
  documentRequests,
  healthScores,
  intakeItems,
  integrations,
  outboundMessages,
  users,
  workItems,
} from '../db/schema.js';
import { config } from '../config.js';
import { intakeConfig } from '../intake/config.js';
import { docusealConfigured } from '../lib/docuseal.js';
import { bandFor, type HealthBand, type HealthCheck } from './healthScore.js';
import { capacityReport, closeRiskStrip, type CapacityRow, type CloseRiskRow } from './workspace.js';

/* ========================================================================== */
/* 1. Integrations                                                             */
/* ========================================================================== */

/** Mirrors the `integrations.provider` enum. */
export const INTEGRATION_PROVIDERS = [
  'stripe',
  'twilio',
  'whatsapp',
  'plaid',
  'qbo',
  'smtp',
  'docuseal',
  'ai',
  'storage',
] as const;

export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];
export type IntegrationStatus = 'not_configured' | 'configured' | 'error' | 'disabled';

/** One environment variable, reduced to the only fact worth rendering. */
export interface EnvPresence {
  readonly name: string;
  /** True when the variable is set to a non-empty value. Never the value. */
  readonly present: boolean;
  readonly required: boolean;
}

export interface IntegrationProbe {
  readonly provider: IntegrationProvider;
  readonly title: string;
  /** Why the firm should care that this is connected. */
  readonly unlocks: string;
  /** What to actually do to connect it. */
  readonly howTo: string;
  /** Computed from the live environment on every page view. */
  readonly liveStatus: IntegrationStatus;
  /** Plain-English statement of what the probe found. */
  readonly detail: string;
  readonly env: readonly EnvPresence[];
}

export interface IntegrationRow extends IntegrationProbe {
  /** What the `integrations` table last recorded, or null when never checked. */
  readonly recordedStatus: IntegrationStatus | null;
  readonly lastCheckedAt: Date | null;
  readonly lastError: string | null;
  /** True when the stored row disagrees with what the environment says today. */
  readonly drifted: boolean;
}

/** Present = set to something non-empty. The value is never read out of here. */
function present(name: string): boolean {
  return Boolean((process.env[name] ?? '').trim());
}

function envList(spec: readonly (readonly [string, boolean])[]): EnvPresence[] {
  return spec.map(([name, required]) => ({ name, present: present(name), required }));
}

/**
 * Probe one provider against the live environment.
 *
 * Deliberately cheap and offline: no provider is called over the network. A
 * page that fans out to nine third-party APIs on every load is a page nobody
 * opens twice, and a half-configured credential is visible from the environment
 * without asking Stripe about it.
 */
export async function probeIntegration(provider: IntegrationProvider): Promise<IntegrationProbe> {
  switch (provider) {
    case 'stripe': {
      const key = present('STRIPE_SECRET_KEY');
      const hook = present('STRIPE_WEBHOOK_SECRET');
      return {
        provider,
        title: 'Stripe',
        unlocks:
          'Invoices mirror into the portal, clients pay from the billing page, and paid / void status arrives by webhook instead of by email.',
        howTo:
          'Set STRIPE_SECRET_KEY (a restricted key with invoice read) and STRIPE_WEBHOOK_SECRET, then point a Stripe webhook at /webhooks/stripe.',
        liveStatus: key && hook ? 'configured' : key || hook ? 'error' : 'not_configured',
        detail:
          key && hook
            ? 'Secret key and webhook signing secret are both present.'
            : key
              ? 'The secret key is present but STRIPE_WEBHOOK_SECRET is not — invoice status changes will never reach the portal.'
              : hook
                ? 'A webhook secret is present but STRIPE_SECRET_KEY is not — nothing can be synced.'
                : 'No Stripe credentials in the environment. Billing pages fall back to whatever was mirrored manually.',
        env: envList([
          ['STRIPE_SECRET_KEY', true],
          ['STRIPE_WEBHOOK_SECRET', true],
        ]),
      };
    }

    case 'twilio': {
      const t = intakeConfig.twilio;
      const partial = Boolean(t.accountSid || t.authToken || t.fromNumber);
      return {
        provider,
        title: 'Twilio (SMS + voice)',
        unlocks:
          'The front door most clients actually use: text a photo of a receipt and it lands on the file. Also carries capture confirmations, questions and the one-per-interval nudge digest.',
        howTo:
          'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER, then point the Twilio messaging webhook at INTAKE_PUBLIC_BASE_URL/webhooks/sms. Each client also needs a verified SMS identity with consent on their record.',
        liveStatus: t.configured ? 'configured' : partial ? 'error' : 'not_configured',
        detail: t.configured
          ? `Account SID, auth token and sending number are present. Webhook signature verification is ${t.verifySignature ? 'on' : 'OFF — turn it back on outside local replay'}.`
          : partial
            ? 'Half configured — SMS capture stays dark until the account SID, auth token and from-number are all present.'
            : 'No Twilio credentials. SMS capture and SMS nudges are unavailable.',
        env: envList([
          ['TWILIO_ACCOUNT_SID', true],
          ['TWILIO_AUTH_TOKEN', true],
          ['TWILIO_FROM_NUMBER', true],
          ['TWILIO_VERIFY_SIGNATURE', false],
        ]),
      };
    }

    case 'whatsapp': {
      const w = intakeConfig.whatsapp;
      const signable = present('WHATSAPP_APP_SECRET');
      return {
        provider,
        title: 'WhatsApp (Meta Cloud API)',
        unlocks:
          'The same capture door as SMS for clients and crews who live in WhatsApp, including media messages and STOP/START consent handling.',
        howTo:
          'Set WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN, then save the callback URL /webhooks/whatsapp in the Meta app.',
        liveStatus: w.configured ? (signable ? 'configured' : 'error') : 'not_configured',
        detail: w.configured
          ? signable
            ? 'Phone number id, access token and app secret are present; inbound webhooks can be signature-verified.'
            : 'Sending works but WHATSAPP_APP_SECRET is missing, so inbound webhooks cannot be verified and are rejected.'
          : 'No WhatsApp credentials. The adapter still parses payloads, so a webhook can be replayed the moment credentials land.',
        env: envList([
          ['WHATSAPP_PHONE_NUMBER_ID', true],
          ['WHATSAPP_ACCESS_TOKEN', true],
          ['WHATSAPP_APP_SECRET', true],
          ['WHATSAPP_VERIFY_TOKEN', false],
        ]),
      };
    }

    case 'plaid':
    case 'qbo': {
      const selected = intakeConfig.BANK_FEED_PROVIDER === provider;
      const title = provider === 'plaid' ? 'Plaid (bank feed)' : 'QuickBooks Online (bank feed)';
      return {
        provider,
        title,
        unlocks:
          'Transactions arrive on their own, so the ledger is never waiting on somebody exporting a CSV — and reconciliation stops being a monthly archaeology dig.',
        howTo:
          `Set BANK_FEED_PROVIDER=${provider} once the adapter is implemented. Per-client linkage is recorded on the accounts row (external_source / external_id), never as a credential in the database.`,
        liveStatus: selected ? 'error' : 'not_configured',
        detail: selected
          ? `BANK_FEED_PROVIDER is set to ${provider}, but the bank-feed adapter is still a stub — nothing is being pulled.`
          : 'Not selected. Bank activity is whatever has been imported by hand.',
        env: envList([['BANK_FEED_PROVIDER', false]]),
      };
    }

    case 'smtp': {
      const host = present('SMTP_HOST');
      const authed = present('SMTP_USER') && present('SMTP_PASS');
      return {
        provider,
        title: 'SMTP (outbound email)',
        unlocks:
          'Invites, password resets, task and signature notifications, and the email fallback for clients with no consented phone number.',
        howTo:
          'Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM. Without a host the transport falls back to logging the message as JSON — safe, but nothing is delivered.',
        liveStatus: host ? 'configured' : 'not_configured',
        detail: host
          ? authed
            ? 'Host and credentials are present.'
            : 'Host is present with no SMTP_USER — sending as an unauthenticated relay.'
          : 'No SMTP host. Mail is written to the log instead of being delivered.',
        env: envList([
          ['SMTP_HOST', true],
          ['SMTP_USER', false],
          ['SMTP_PASS', false],
          ['MAIL_FROM', false],
        ]),
      };
    }

    case 'docuseal': {
      const on = docusealConfigured();
      return {
        provider,
        title: 'DocuSeal (e-signature)',
        unlocks:
          'Engagement letters and any other PDF go out for signature from the client record, and come back signed and filed.',
        howTo:
          'Set DOCUSEAL_URL and DOCUSEAL_API_KEY (plus DOCUSEAL_WEBHOOK_SECRET so completion callbacks are verified).',
        liveStatus: on ? (present('DOCUSEAL_WEBHOOK_SECRET') ? 'configured' : 'error') : 'not_configured',
        detail: on
          ? present('DOCUSEAL_WEBHOOK_SECRET')
            ? 'URL, API key and webhook secret are present.'
            : 'URL and API key are present but DOCUSEAL_WEBHOOK_SECRET is not — completed signatures will not be recorded automatically.'
          : 'Not configured. The "request a signature" action stays hidden on client records.',
        env: envList([
          ['DOCUSEAL_URL', true],
          ['DOCUSEAL_API_KEY', true],
          ['DOCUSEAL_WEBHOOK_SECRET', false],
        ]),
      };
    }

    case 'ai': {
      const p = config.AI_PROVIDER;
      const keyed =
        p === 'anthropic' ? present('ANTHROPIC_API_KEY') : p === 'openai' ? present('OPENAI_API_KEY') : true;
      return {
        provider,
        title: `AI provider (${p})`,
        unlocks:
          'Extraction, categorisation suggestions, close narratives, anomaly detection and reply drafts. Every call is logged to ai_runs; nothing it produces reaches the ledger without a human confirming it.',
        howTo:
          'Set AI_PROVIDER to stub, anthropic or openai. Anthropic needs ANTHROPIC_API_KEY, OpenAI needs OPENAI_API_KEY. AI_CONFIDENCE_THRESHOLD decides where a suggestion becomes a question for a human.',
        liveStatus: keyed ? 'configured' : 'error',
        detail: keyed
          ? p === 'stub'
            ? 'Running the deterministic stub provider: no key, no network, no client data leaving the box. Suggestions are rule-shaped and reproducible.'
            : `Provider ${p} is selected and its API key is present. Confidence threshold ${config.AI_CONFIDENCE_THRESHOLD}%.`
          : `Provider ${p} is selected but its API key is missing — every task will fail closed and log an ai_runs error row.`,
        env: envList([
          ['AI_PROVIDER', false],
          ['ANTHROPIC_API_KEY', p === 'anthropic'],
          ['OPENAI_API_KEY', p === 'openai'],
        ]),
      };
    }

    case 'storage': {
      let writable = true;
      let reason = '';
      try {
        await fsp.mkdir(config.uploadsDir, { recursive: true });
        const probeFile = path.join(config.uploadsDir, '.write-probe');
        await fsp.writeFile(probeFile, 'ok');
        await fsp.unlink(probeFile);
      } catch (err) {
        writable = false;
        reason = err instanceof Error ? err.message : String(err);
      }
      const devKey = config.files.usingDevKey;
      return {
        provider,
        title: 'Encrypted file storage',
        unlocks:
          'Every uploaded document and every captured receipt is encrypted at rest under a per-file key wrapped by the master key. Without it there is nowhere safe to put a client statement.',
        howTo:
          'Generate a key with `openssl rand -base64 32` and set FILE_ENCRYPTION_KEY. Use FILE_ENCRYPTION_KEY_PREVIOUS only during a rotation window. UPLOADS_DIR must be a writable volume outside the web root.',
        liveStatus: !writable ? 'error' : devKey ? 'not_configured' : 'configured',
        detail: !writable
          ? `The uploads directory is not writable: ${reason}`
          : devKey
            ? 'Writable, but encrypting under the published dev key — production refuses to boot in this state.'
            : `Writable, and encrypting under a real master key${present('FILE_ENCRYPTION_KEY_PREVIOUS') ? ' with a previous key still accepted on read (rotation in progress)' : ''}.`,
        env: envList([
          ['FILE_ENCRYPTION_KEY', true],
          ['FILE_ENCRYPTION_KEY_PREVIOUS', false],
          ['UPLOADS_DIR', false],
        ]),
      };
    }
  }
}

/**
 * Every provider, with the live probe alongside whatever the `integrations`
 * table last recorded. Both are shown because they answer different questions:
 * the table says what we believed at the last check, the probe says what is
 * true now, and the gap between them is the interesting part.
 */
export async function integrationRows(): Promise<readonly IntegrationRow[]> {
  const stored = await db.query.integrations.findMany({ where: isNull(integrations.clientId) });
  const byProvider = new Map(stored.map((r) => [r.provider, r] as const));

  const out: IntegrationRow[] = [];
  for (const provider of INTEGRATION_PROVIDERS) {
    const probe = await probeIntegration(provider);
    const row = byProvider.get(provider);
    out.push({
      ...probe,
      recordedStatus: (row?.status as IntegrationStatus | undefined) ?? null,
      lastCheckedAt: row?.lastCheckedAt ?? null,
      lastError: row?.lastError ?? null,
      drifted: row != null && row.status !== probe.liveStatus,
    });
  }
  return out;
}

export function isIntegrationProvider(value: string): value is IntegrationProvider {
  return (INTEGRATION_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Re-run the probe and write the result back to the `integrations` row.
 *
 * The unique index is on `(client_id, provider)` and firm-wide rows carry a
 * null `client_id` — which Postgres treats as distinct from every other null —
 * so an upsert on conflict would silently insert a duplicate. Find, then
 * update or insert.
 */
export async function recheckIntegration(provider: IntegrationProvider): Promise<IntegrationProbe> {
  const probe = await probeIntegration(provider);
  const now = new Date();
  const lastError = probe.liveStatus === 'error' ? probe.detail.slice(0, 500) : null;

  const existing = await db.query.integrations.findFirst({
    where: and(isNull(integrations.clientId), eq(integrations.provider, provider)),
  });

  if (existing) {
    await db
      .update(integrations)
      .set({ status: probe.liveStatus, lastCheckedAt: now, lastError, updatedAt: now })
      .where(eq(integrations.id, existing.id));
  } else {
    await db.insert(integrations).values({
      clientId: null,
      provider,
      status: probe.liveStatus,
      // Non-secret settings only — and even here, never a credential.
      settings: { checkedBy: 'admin-recheck' },
      lastCheckedAt: now,
      lastError,
    });
  }
  return probe;
}

/* ========================================================================== */
/* 2. Categorisation rules                                                     */
/* ========================================================================== */

export interface RuleRow {
  readonly id: string;
  readonly clientId: string | null;
  readonly clientName: string;
  readonly matchType: string;
  readonly pattern: string;
  readonly categoryName: string;
  readonly categoryKind: string;
  readonly source: 'learned' | 'manual';
  readonly hitCount: number;
  readonly lastHitAt: Date | null;
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
  readonly createdByName: string | null;
}

export interface RuleGroup {
  readonly clientId: string | null;
  readonly clientName: string;
  readonly rules: readonly RuleRow[];
  readonly hits: number;
  readonly active: number;
}

/** "N% of categorisations resolved by rules with no model call." */
export interface RuleShare {
  readonly categorizeRuns: number;
  readonly ruleRuns: number;
  readonly modelRuns: number;
  /** 0–100, rounded. Zero runs reads as 0% rather than as a divide by zero. */
  readonly pct: number;
}

export interface RulesOverview {
  readonly groups: readonly RuleGroup[];
  readonly totals: {
    readonly rules: number;
    readonly active: number;
    readonly disabled: number;
    readonly learned: number;
    readonly manual: number;
    readonly hits: number;
  };
  readonly share: RuleShare;
}

/**
 * The share of categorisation decisions the deterministic engine answered on
 * its own. Counted from `ai_runs`, because that is the only place both halves
 * are recorded: a rule hit is logged with provider `rules-engine`, a model call
 * with the provider's own name (see ai/index.ts `recordDeterministic`).
 */
export async function ruleShare(): Promise<RuleShare> {
  const rows = await db
    .select({ provider: aiRuns.provider, n: sql<string>`count(*)` })
    .from(aiRuns)
    .where(eq(aiRuns.task, 'categorize'))
    .groupBy(aiRuns.provider);

  let ruleRuns = 0;
  let total = 0;
  for (const r of rows) {
    const n = Number(r.n);
    total += n;
    if (r.provider === 'rules-engine') ruleRuns += n;
  }
  return {
    categorizeRuns: total,
    ruleRuns,
    modelRuns: total - ruleRuns,
    pct: total === 0 ? 0 : Math.round((ruleRuns / total) * 100),
  };
}

export async function rulesOverview(): Promise<RulesOverview> {
  const [rows, share] = await Promise.all([
    db
      .select({
        rule: categorizationRules,
        clientName: clients.businessName,
        categoryName: categories.name,
        categoryKind: categories.kind,
        createdByName: users.name,
      })
      .from(categorizationRules)
      .leftJoin(clients, eq(clients.id, categorizationRules.clientId))
      .innerJoin(categories, eq(categories.id, categorizationRules.categoryId))
      .leftJoin(users, eq(users.id, categorizationRules.createdBy))
      .orderBy(asc(clients.businessName), desc(categorizationRules.hitCount))
      .limit(1000),
    ruleShare(),
  ]);

  const mapped: RuleRow[] = rows.map(({ rule, clientName, categoryName, categoryKind, createdByName }) => ({
    id: rule.id,
    clientId: rule.clientId,
    // A null client_id is a firm-wide rule, not an orphan.
    clientName: clientName ?? 'Firm-wide',
    matchType: rule.matchType,
    pattern: rule.pattern,
    categoryName,
    categoryKind,
    source: rule.source,
    hitCount: rule.hitCount,
    lastHitAt: rule.lastHitAt,
    disabledAt: rule.disabledAt,
    createdAt: rule.createdAt,
    createdByName,
  }));

  const byClient = new Map<string, RuleRow[]>();
  for (const r of mapped) {
    const key = r.clientId ?? '';
    const arr = byClient.get(key) ?? [];
    arr.push(r);
    byClient.set(key, arr);
  }

  const groups: RuleGroup[] = [...byClient.entries()].map(([key, rules]) => ({
    clientId: key || null,
    clientName: rules[0]!.clientName,
    rules,
    hits: rules.reduce((n, r) => n + r.hitCount, 0),
    active: rules.filter((r) => !r.disabledAt).length,
  }));
  groups.sort((a, b) => b.hits - a.hits || a.clientName.localeCompare(b.clientName));

  return {
    groups,
    totals: {
      rules: mapped.length,
      active: mapped.filter((r) => !r.disabledAt).length,
      disabled: mapped.filter((r) => r.disabledAt).length,
      learned: mapped.filter((r) => r.source === 'learned').length,
      manual: mapped.filter((r) => r.source === 'manual').length,
      hits: mapped.reduce((n, r) => n + r.hitCount, 0),
    },
    share,
  };
}

/** Flip a rule off (or back on). Returns the row as it now stands, or null. */
export async function setRuleDisabled(
  ruleId: string,
  disabled: boolean,
): Promise<typeof categorizationRules.$inferSelect | null> {
  const [row] = await db
    .update(categorizationRules)
    .set({ disabledAt: disabled ? new Date() : null })
    .where(eq(categorizationRules.id, ruleId))
    .returning();
  return row ?? null;
}

/* ========================================================================== */
/* 3. AI usage and safety                                                      */
/* ========================================================================== */

export interface AiTaskStat {
  readonly task: string;
  readonly runs: number;
  readonly errors: number;
  /** Null when no run on this task carried a confidence. */
  readonly avgConfidence: number | null;
  readonly reviewed: number;
  readonly accepted: number;
  /** accepted / reviewed, 0–100. Null while nothing has been reviewed. */
  readonly acceptanceRate: number | null;
  readonly avgLatencyMs: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AiRunRow {
  readonly id: string;
  readonly at: Date;
  readonly task: string;
  readonly provider: string;
  readonly model: string | null;
  readonly clientName: string | null;
  readonly userName: string | null;
  readonly confidence: number | null;
  readonly latencyMs: number | null;
  readonly accepted: boolean | null;
  readonly error: string | null;
}

export interface AiUsage {
  readonly byTask: readonly AiTaskStat[];
  readonly byProvider: readonly { provider: string; runs: number; errors: number }[];
  readonly totals: AiTaskStat;
  readonly recent: readonly AiRunRow[];
  readonly errorCount: number;
}

/**
 * Aggregated `ai_runs`. This table is the firm's evidence that the system is
 * safe and getting better: volume per task, how confident it was, how often a
 * human took the suggestion, what it cost and what went wrong.
 */
export async function aiUsage(recentLimit = 60): Promise<AiUsage> {
  const [taskRows, providerRows, recentRows] = await Promise.all([
    db
      .select({
        task: aiRuns.task,
        runs: sql<string>`count(*)`,
        errors: sql<string>`count(*) filter (where ${aiRuns.error} is not null)`,
        avgConfidence: sql<string | null>`avg(${aiRuns.confidence})`,
        reviewed: sql<string>`count(*) filter (where ${aiRuns.accepted} is not null)`,
        accepted: sql<string>`count(*) filter (where ${aiRuns.accepted} is true)`,
        avgLatency: sql<string | null>`avg(${aiRuns.latencyMs})`,
        inputTokens: sql<string>`coalesce(sum(${aiRuns.inputTokens}), 0)`,
        outputTokens: sql<string>`coalesce(sum(${aiRuns.outputTokens}), 0)`,
      })
      .from(aiRuns)
      .groupBy(aiRuns.task)
      .orderBy(desc(sql`count(*)`)),
    db
      .select({
        provider: aiRuns.provider,
        runs: sql<string>`count(*)`,
        errors: sql<string>`count(*) filter (where ${aiRuns.error} is not null)`,
      })
      .from(aiRuns)
      .groupBy(aiRuns.provider)
      .orderBy(desc(sql`count(*)`)),
    db
      .select({ run: aiRuns, clientName: clients.businessName, userName: users.name })
      .from(aiRuns)
      .leftJoin(clients, eq(clients.id, aiRuns.clientId))
      .leftJoin(users, eq(users.id, aiRuns.userId))
      .orderBy(desc(aiRuns.createdAt))
      .limit(recentLimit),
  ]);

  const byTask: AiTaskStat[] = taskRows.map((r) => statFrom(r.task, r));
  const totals = byTask.reduce<AiTaskStat>(
    (acc, s) => ({
      task: 'all tasks',
      runs: acc.runs + s.runs,
      errors: acc.errors + s.errors,
      avgConfidence: weightedAvg(acc.avgConfidence, acc.runs, s.avgConfidence, s.runs),
      reviewed: acc.reviewed + s.reviewed,
      accepted: acc.accepted + s.accepted,
      acceptanceRate: null, // recomputed below from the summed counts
      avgLatencyMs: weightedAvg(acc.avgLatencyMs, acc.runs, s.avgLatencyMs, s.runs),
      inputTokens: acc.inputTokens + s.inputTokens,
      outputTokens: acc.outputTokens + s.outputTokens,
    }),
    {
      task: 'all tasks',
      runs: 0,
      errors: 0,
      avgConfidence: null,
      reviewed: 0,
      accepted: 0,
      acceptanceRate: null,
      avgLatencyMs: null,
      inputTokens: 0,
      outputTokens: 0,
    },
  );

  return {
    byTask,
    byProvider: providerRows.map((r) => ({
      provider: r.provider,
      runs: Number(r.runs),
      errors: Number(r.errors),
    })),
    totals: {
      ...totals,
      acceptanceRate: totals.reviewed === 0 ? null : Math.round((totals.accepted / totals.reviewed) * 100),
    },
    recent: recentRows.map(({ run, clientName, userName }) => ({
      id: run.id,
      at: run.createdAt,
      task: run.task,
      provider: run.provider,
      model: run.model,
      clientName,
      userName,
      confidence: run.confidence,
      latencyMs: run.latencyMs,
      accepted: run.accepted,
      error: run.error,
    })),
    errorCount: totals.errors,
  };
}

function statFrom(
  task: string,
  r: {
    runs: string;
    errors: string;
    avgConfidence: string | null;
    reviewed: string;
    accepted: string;
    avgLatency: string | null;
    inputTokens: string;
    outputTokens: string;
  },
): AiTaskStat {
  const reviewed = Number(r.reviewed);
  const accepted = Number(r.accepted);
  return {
    task,
    runs: Number(r.runs),
    errors: Number(r.errors),
    avgConfidence: r.avgConfidence === null ? null : Math.round(Number(r.avgConfidence)),
    reviewed,
    accepted,
    acceptanceRate: reviewed === 0 ? null : Math.round((accepted / reviewed) * 100),
    avgLatencyMs: r.avgLatency === null ? null : Math.round(Number(r.avgLatency)),
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
  };
}

function weightedAvg(a: number | null, aN: number, b: number | null, bN: number): number | null {
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  const total = aN + bN;
  return total === 0 ? null : Math.round((a * aN + b * bN) / total);
}

/* ========================================================================== */
/* 4. Quarantine                                                               */
/* ========================================================================== */

export interface QuarantineRow {
  readonly id: string;
  readonly channel: string;
  readonly senderIdentity: string | null;
  readonly receivedAt: Date;
  readonly mime: string | null;
  readonly sizeBytes: number | null;
  readonly quarantineReason: string | null;
  /** A short hint of what the payload contains, so staff can place the sender. */
  readonly preview: string | null;
  /** True when this exact identity is already known for some client. */
  readonly knownElsewhere: boolean;
}

/**
 * Everything that arrived from a sender we could not name.
 *
 * The same rows `GET /api/intake/quarantine` serves as JSON — this is the HTML
 * view of one queue, not a second copy of the rule. The rule itself lives in
 * `intake/identity.ts`: an unrecognised sender is never guessed onto a client.
 */
export async function quarantineQueue(limit = 200): Promise<readonly QuarantineRow[]> {
  const rows = await db.query.intakeItems.findMany({
    where: and(eq(intakeItems.status, 'quarantined'), isNull(intakeItems.clientId)),
    orderBy: [desc(intakeItems.receivedAt)],
    limit,
  });

  const identities = rows.map((r) => r.senderIdentity).filter((s): s is string => Boolean(s));
  const known =
    identities.length === 0
      ? []
      : await db
          .select({ identity: channelIdentities.identity })
          .from(channelIdentities)
          .where(inArray(channelIdentities.identity, identities));
  const knownSet = new Set(known.map((k) => k.identity.toLowerCase()));

  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    senderIdentity: r.senderIdentity,
    receivedAt: r.receivedAt,
    mime: r.mime,
    sizeBytes: r.sizeBytes,
    quarantineReason: r.quarantineReason,
    preview: previewOf(r.rawPayload),
    knownElsewhere: r.senderIdentity ? knownSet.has(r.senderIdentity.toLowerCase()) : false,
  }));
}

/** A short, human-readable hint of what a quarantined payload contains. */
function previewOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = r['Body'] ?? r['text'] ?? r['TextBody'] ?? r['TranscriptionText'] ?? r['Subject'];
  return typeof text === 'string' ? text.slice(0, 200) : null;
}

/* ========================================================================== */
/* 5. System health                                                            */
/* ========================================================================== */

export interface ClientHealthRow {
  readonly clientId: string;
  readonly clientName: string;
  readonly score: number | null;
  readonly maxScore: number;
  readonly band: HealthBand | null;
  readonly computedAt: Date | null;
  readonly failing: number;
}

export interface SystemHealth {
  readonly openWorkByKind: readonly { kind: string; count: number }[];
  readonly openWorkTotal: number;
  readonly blockedWork: number;
  readonly closeRisk: readonly CloseRiskRow[];
  readonly quarantine: { readonly count: number; readonly oldestAt: Date | null };
  readonly failedOutbound: {
    readonly count: number;
    readonly recent: readonly {
      id: string;
      clientName: string;
      channel: string;
      purpose: string;
      failureReason: string | null;
      createdAt: Date;
    }[];
  };
  readonly retention: {
    readonly lastRunAt: Date | null;
    readonly lastRunBy: string | null;
    readonly lastRunMeta: Record<string, unknown> | null;
    readonly windows: readonly { readonly name: string; readonly days: number }[];
  };
  readonly clientHealth: readonly ClientHealthRow[];
  readonly openQuestions: number;
  readonly openDocRequests: number;
  readonly openAnomalies: number;
}

/** Audit action written when a staff member runs the retention report. */
export const RETENTION_AUDIT_ACTION = 'admin.retention_report';

export async function systemHealth(): Promise<SystemHealth> {
  const [
    workRows,
    risk,
    quarantineRows,
    failedRows,
    failedCount,
    retentionRow,
    clientRows,
    scoreRows,
    questionCount,
    docRequestCount,
    anomalyCount,
  ] = await Promise.all([
    db
      .select({ kind: workItems.kind, status: workItems.status, n: sql<string>`count(*)` })
      .from(workItems)
      .where(inArray(workItems.status, ['open', 'blocked']))
      .groupBy(workItems.kind, workItems.status),
    closeRiskStrip(),
    db
      .select({ n: sql<string>`count(*)`, oldest: sql<Date | null>`min(${intakeItems.receivedAt})` })
      .from(intakeItems)
      .where(and(eq(intakeItems.status, 'quarantined'), isNull(intakeItems.clientId))),
    db
      .select({ msg: outboundMessages, clientName: clients.businessName })
      .from(outboundMessages)
      .innerJoin(clients, eq(clients.id, outboundMessages.clientId))
      .where(eq(outboundMessages.status, 'failed'))
      .orderBy(desc(outboundMessages.createdAt))
      .limit(10),
    db
      .select({ n: sql<string>`count(*)` })
      .from(outboundMessages)
      .where(eq(outboundMessages.status, 'failed')),
    db
      .select({ entry: auditLog, userName: users.name })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.userId))
      .where(eq(auditLog.action, RETENTION_AUDIT_ACTION))
      .orderBy(desc(auditLog.id))
      .limit(1),
    db.query.clients.findMany({ orderBy: [asc(clients.businessName)] }),
    db
      .select()
      .from(healthScores)
      .orderBy(desc(healthScores.computedAt))
      .limit(500),
    db
      .select({ n: sql<string>`count(*)` })
      .from(clientQuestions)
      .where(isNull(clientQuestions.answeredAt)),
    db
      .select({ n: sql<string>`count(*)` })
      .from(documentRequests)
      .where(eq(documentRequests.status, 'open')),
    db.select({ n: sql<string>`count(*)` }).from(anomalies).where(eq(anomalies.status, 'open')),
  ]);

  const byKind = new Map<string, number>();
  let blocked = 0;
  for (const row of workRows) {
    const n = Number(row.n);
    byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + n);
    if (row.status === 'blocked') blocked += n;
  }

  // Newest stored score per client. Health scores are append-only, so "latest"
  // is a scan of the recent window rather than an update in place.
  const latestScore = new Map<string, typeof healthScores.$inferSelect>();
  for (const row of scoreRows) {
    if (!latestScore.has(row.clientId)) latestScore.set(row.clientId, row);
  }

  return {
    openWorkByKind: [...byKind.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count),
    openWorkTotal: [...byKind.values()].reduce((n, v) => n + v, 0),
    blockedWork: blocked,
    closeRisk: risk,
    quarantine: {
      count: Number(quarantineRows[0]?.n ?? 0),
      oldestAt: quarantineRows[0]?.oldest ? new Date(quarantineRows[0].oldest) : null,
    },
    failedOutbound: {
      count: Number(failedCount[0]?.n ?? 0),
      recent: failedRows.map(({ msg, clientName }) => ({
        id: msg.id,
        clientName,
        channel: msg.channel,
        purpose: msg.purpose,
        failureReason: msg.failureReason,
        createdAt: msg.createdAt,
      })),
    },
    retention: {
      lastRunAt: retentionRow[0]?.entry.at ?? null,
      lastRunBy: retentionRow[0]?.userName ?? null,
      lastRunMeta: (retentionRow[0]?.entry.meta as Record<string, unknown> | null) ?? null,
      windows: [
        { name: 'sessions', days: config.retention.sessionsDays },
        { name: 'audit_log', days: Math.max(config.retention.auditDays, config.retention.auditFloorDays) },
        { name: 'leads', days: config.retention.leadsDays },
        { name: 'intake quarantine', days: config.retention.intakeQuarantineDays },
        { name: 'outbound messages', days: config.retention.outboundDays },
      ],
    },
    clientHealth: clientRows.map((c) => {
      const row = latestScore.get(c.id);
      const checks = (row?.checks as HealthCheck[] | undefined) ?? [];
      return {
        clientId: c.id,
        clientName: c.businessName,
        score: row?.score ?? null,
        maxScore: row?.maxScore ?? 20,
        band: row ? bandFor(row.score) : null,
        computedAt: row?.computedAt ?? null,
        failing: checks.filter((c2) => !c2.passed).length,
      };
    }),
    openQuestions: Number(questionCount[0]?.n ?? 0),
    openDocRequests: Number(docRequestCount[0]?.n ?? 0),
    openAnomalies: Number(anomalyCount[0]?.n ?? 0),
  };
}

/* ========================================================================== */
/* 6. One client, everything the v1 subsystems know about it                   */
/* ========================================================================== */

export interface IdentityRow {
  readonly id: string;
  readonly channel: string;
  readonly identity: string;
  readonly label: string | null;
  readonly verifiedAt: Date | null;
  readonly consentAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface ClientOverview {
  readonly identities: readonly IdentityRow[];
  readonly health: {
    readonly score: number | null;
    readonly maxScore: number;
    readonly band: HealthBand | null;
    readonly computedAt: Date | null;
    readonly failing: readonly HealthCheck[];
  };
  readonly docRequests: readonly (typeof documentRequests.$inferSelect)[];
  readonly closePeriod: (typeof closePeriods.$inferSelect) | null;
  readonly effort: CapacityRow | null;
  readonly openWork: readonly (typeof workItems.$inferSelect)[];
  readonly openQuestions: number;
}

/** The v1 half of a client record: identities, health, chase list, close, effort. */
export async function clientOverview(clientId: string): Promise<ClientOverview> {
  const [identities, score, docRequests, period, capacity, openWork, questions] = await Promise.all([
    db.query.channelIdentities.findMany({
      where: eq(channelIdentities.clientId, clientId),
      orderBy: [asc(channelIdentities.channel), asc(channelIdentities.identity)],
    }),
    db
      .select()
      .from(healthScores)
      .where(eq(healthScores.clientId, clientId))
      .orderBy(desc(healthScores.computedAt))
      .limit(1),
    db.query.documentRequests.findMany({
      where: and(eq(documentRequests.clientId, clientId), eq(documentRequests.status, 'open')),
      orderBy: [desc(documentRequests.createdAt)],
      limit: 25,
    }),
    db.query.closePeriods.findMany({
      where: eq(closePeriods.clientId, clientId),
      orderBy: [desc(closePeriods.periodStart)],
      limit: 1,
    }),
    capacityReport(90),
    db.query.workItems.findMany({
      where: and(eq(workItems.clientId, clientId), inArray(workItems.status, ['open', 'blocked'])),
      orderBy: [desc(workItems.priority)],
      limit: 25,
    }),
    db
      .select({ n: sql<string>`count(*)` })
      .from(clientQuestions)
      .where(and(eq(clientQuestions.clientId, clientId), isNull(clientQuestions.answeredAt))),
  ]);

  const latest = score[0];
  const checks = (latest?.checks as HealthCheck[] | undefined) ?? [];

  return {
    identities,
    health: {
      score: latest?.score ?? null,
      maxScore: latest?.maxScore ?? 20,
      band: latest ? bandFor(latest.score) : null,
      computedAt: latest?.computedAt ?? null,
      failing: checks.filter((c) => !c.passed),
    },
    docRequests,
    closePeriod: period[0] ?? null,
    effort: capacity.find((r) => r.clientId === clientId) ?? null,
    openWork,
    openQuestions: Number(questions[0]?.n ?? 0),
  };
}
