/**
 * The nightly job.
 *
 * OVERSIGHT-AND-PERFORMANCE.md §6 asks for "a scheduled job (nightly, plus
 * on-demand recompute)". This is it, and it is a plain script:
 *
 *     node dist/jobs/nightly.js            # yesterday and today
 *     node dist/jobs/nightly.js --days 7   # backfill a week of rollups
 *     node dist/jobs/nightly.js --health-only
 *
 * Four steps, in this order, because each depends on the one before:
 *
 *   1. **Seed thresholds** so a fresh database scores against the documented
 *      defaults rather than against nothing.
 *   2. **Recompute health, write transitions, raise alerts.** A row lands in
 *      `client_status_history` only when the colour actually changed, and
 *      alerts fire off the change rather than off the state.
 *   3. **Roll staff metrics up** into `staff_metrics_daily`, so scorecards read
 *      one pre-aggregated table instead of scanning the ledger.
 *   4. **Release anything whose quiet-hours hold has expired** — the 8am CT
 *      digest, in the form of stamping `delivered_at` on what is now due.
 *
 * ## Idempotent by construction
 *
 * Running it twice in a minute must be a no-op, because cron will eventually do
 * exactly that. Health writes only on change; the metrics rollup upserts on
 * (user, date); `alerts.raise()` deduplicates against the open alert; marking
 * delivered ignores rows already stamped. Nothing here appends blindly.
 *
 * Exit code is 0 on success and 1 on failure, so a supervisor can tell the
 * difference without parsing the log.
 */

import { pathToFileURL } from 'node:url';
import { closeDb } from '../db/index.js';
import { ensureThresholds } from '../services/clientHealth.js';
import { sweep, type SweepResult } from '../services/statusTransitions.js';
import { rollupDay, wellbeingFlags, type RollupResult } from '../services/staffMetrics.js';
import { markDelivered, pendingDelivery, raiseDetailed } from '../services/alerts.js';
import { audit } from '../lib/audit.js';

const MS_PER_DAY = 86_400_000;

export interface NightlyOptions {
  /** How many days of metrics to roll up, ending today. Default 2. */
  readonly days?: number;
  /** Skip the metrics rollup — used by the on-demand "recompute health" path. */
  readonly healthOnly?: boolean;
  readonly now?: Date;
  readonly log?: (line: string) => void;
}

export interface NightlyResult {
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly sweep: SweepResult;
  readonly rollups: readonly RollupResult[];
  readonly delivered: number;
  readonly wellbeingRaised: number;
}

export async function runNightly(opts: NightlyOptions = {}): Promise<NightlyResult> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? ((line: string) => console.log(line));
  const days = Math.min(90, Math.max(1, opts.days ?? 2));

  log(`nightly: starting at ${now.toISOString()}`);

  /* 1 — thresholds ------------------------------------------------------- */
  await ensureThresholds();
  log('nightly: thresholds present');

  /* 2 — health, transitions, alerts -------------------------------------- */
  const sweepResult = await sweep(now);
  log(
    `nightly: evaluated ${sweepResult.evaluated} clients, ` +
      `${sweepResult.transitions.length} transition(s), ${sweepResult.alertsRaised} alert(s) raised`,
  );
  for (const t of sweepResult.transitions) {
    log(`  · ${t.businessName}: ${t.from ?? 'new'} → ${t.to} (blocked by ${t.blockedBy})`);
  }

  /* 3 — staff metrics ---------------------------------------------------- */
  const rollups: RollupResult[] = [];
  if (!opts.healthOnly) {
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = new Date(now.getTime() - i * MS_PER_DAY);
      const result = await rollupDay(day, now);
      rollups.push(result);
      log(`nightly: rolled up ${result.onDate} for ${result.users} firm-side user(s)`);
    }
  }

  /* 3b — wellbeing, weekly, framed as wellbeing -------------------------- */
  let wellbeingRaised = 0;
  if (!opts.healthOnly) {
    const flags = await wellbeingFlags(now);
    for (const flag of flags) {
      // Admin only. This is never shown to the person as a performance figure,
      // and it is never a score — it is a prompt to redistribute work.
      const { created } = await raiseDetailed({
        kind: 'staff.wellbeing',
        severity: 'warning',
        clientId: null,
        userId: null,
        title: `${flag.name} is working well above their own out-of-hours baseline`,
        detail:
          `${Math.round(flag.outOfHoursMinutes / 60)}h outside 7am–7pm CT this week, ` +
          `${flag.ratio}× their trailing baseline. Look at what to take off them, not at what they are producing.`,
        actionUrl: '/admin/staff',
        now,
      });
      if (created) wellbeingRaised += 1;
    }
    if (flags.length) log(`nightly: ${flags.length} wellbeing flag(s), ${wellbeingRaised} alert(s)`);
  }

  /* 4 — release the digest ------------------------------------------------ */
  const due = await pendingDelivery(now);
  const delivered = await markDelivered(
    due.map((a) => a.id),
    now,
  );
  log(`nightly: ${delivered} alert(s) released from quiet hours`);

  const finishedAt = new Date();
  await audit(null, {
    action: 'jobs.nightly',
    entity: 'job',
    entityId: 'nightly',
    meta: {
      evaluated: sweepResult.evaluated,
      transitions: sweepResult.transitions.length,
      alertsRaised: sweepResult.alertsRaised,
      rollups: rollups.map((r) => r.onDate),
      delivered,
      ms: finishedAt.getTime() - now.getTime(),
    },
  });

  log(`nightly: done in ${finishedAt.getTime() - now.getTime()}ms`);
  return {
    startedAt: now,
    finishedAt,
    sweep: sweepResult,
    rollups,
    delivered,
    wellbeingRaised,
  };
}

/* ========================================================================== */
/* CLI                                                                         */
/* ========================================================================== */

function parseArgs(argv: readonly string[]): NightlyOptions {
  const opts: { days?: number; healthOnly?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--days') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n)) opts.days = n;
      i += 1;
    } else if (arg === '--health-only') {
      opts.healthOnly = true;
    }
  }
  return opts;
}

const isCli = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;

if (isCli) {
  runNightly(parseArgs(process.argv.slice(2)))
    .then(async () => {
      await closeDb();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('nightly: failed', err);
      try {
        await closeDb();
      } catch {
        /* the pool may already be gone; the exit code is what matters */
      }
      process.exit(1);
    });
}
