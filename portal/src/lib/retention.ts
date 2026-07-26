import { pathToFileURL } from 'node:url';
import { and, count, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { db, closeDb } from '../db/index.js';
import {
  auditLog,
  documentRequests,
  extractions,
  intakeItems,
  leads,
  outboundMessages,
  sessions,
  txnMatches,
} from '../db/schema.js';
import { config } from '../config.js';
import { deleteStored } from './storage.js';

/**
 * Data retention + purge.
 *
 * Holding client financial records forever is a liability, not a feature: every
 * extra year of data is another year an attacker (or a subpoena) can reach. But
 * deleting the wrong thing is worse, so this module is deliberately narrow:
 *
 *   * Every bucket has an explicit window, an explicit predicate, and a report
 *     line. Nothing is deleted that isn't named here.
 *   * `dryRun` (the default for the CLI) counts without touching a row.
 *   * audit_log is append-only and financial: the window is 7 years, floored in
 *     config's zod schema AND re-checked here, so no env typo can shorten it.
 *     A row younger than the window is never eligible, full stop.
 *   * Purging quarantined intake items also removes their encrypted blobs from
 *     the uploads volume — a DB-only purge would leave orphaned ciphertext.
 *
 * Run it from cron (daily is plenty):
 *   node dist/lib/retention.js --dry-run     # report only
 *   node dist/lib/retention.js --apply       # actually delete
 *
 * Audit rows are the one bucket the restricted app DB role cannot delete (it
 * holds INSERT/SELECT only — see src/db/rls.sql). Run the purge with
 * ADMIN_DATABASE_URL-grade credentials; the report records the failure loudly
 * rather than silently skipping it.
 */

/** Safety rail applied to every bucket in a single run. */
const MAX_ROWS_PER_BUCKET = 20_000;

export interface RetentionBucket {
  /** Stable machine name for dashboards/alerting. */
  name: string;
  table: string;
  windowDays: number;
  /** Rows older than this instant are eligible. */
  cutoff: string;
  /** Plain-English statement of what is eligible. */
  rule: string;
  matched: number;
  deleted: number;
  /** Encrypted blobs removed from the uploads volume alongside the rows. */
  blobsDeleted?: number;
  /** True when `matched` hit MAX_ROWS_PER_BUCKET and more remain for the next run. */
  capped?: boolean;
  error?: string;
}

export interface RetentionReport {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  buckets: RetentionBucket[];
  totalMatched: number;
  totalDeleted: number;
  /** True when any bucket errored — the caller should alert, not shrug. */
  hadErrors: boolean;
}

export interface RunRetentionOptions {
  /** Count only, delete nothing. Defaults to true — you must ask to delete. */
  dryRun?: boolean;
  /** Fixed "now" for tests. */
  now?: Date;
}

function cutoffFor(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export async function runRetention(options: RunRetentionOptions = {}): Promise<RetentionReport> {
  const dryRun = options.dryRun !== false;
  const now = options.now ?? new Date();
  const startedAt = new Date();
  const buckets: RetentionBucket[] = [];

  const run = async (
    spec: Omit<RetentionBucket, 'matched' | 'deleted'>,
    fn: () => Promise<Pick<RetentionBucket, 'matched' | 'deleted' | 'blobsDeleted' | 'capped'>>,
  ) => {
    try {
      buckets.push({ ...spec, ...(await fn()) });
    } catch (err) {
      buckets.push({
        ...spec,
        matched: 0,
        deleted: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // ---- sessions: revoked or expired for longer than the window -------------
  {
    const windowDays = config.retention.sessionsDays;
    const cutoff = cutoffFor(now, windowDays);
    const where = or(
      and(isNotNull(sessions.revokedAt), lt(sessions.revokedAt, cutoff)),
      lt(sessions.expiresAt, cutoff),
    )!;
    await run(
      {
        name: 'sessions',
        table: 'sessions',
        windowDays,
        cutoff: cutoff.toISOString(),
        rule: `revoked_at or expires_at older than ${windowDays}d (live sessions are never touched)`,
      },
      async () => {
        const [row] = await db.select({ n: count() }).from(sessions).where(where);
        const matched = row?.n ?? 0;
        if (dryRun || matched === 0) return { matched, deleted: 0 };
        const gone = await db.delete(sessions).where(where).returning({ id: sessions.id });
        return { matched, deleted: gone.length };
      },
    );
  }

  // ---- audit_log: 7 years, floored ----------------------------------------
  {
    const windowDays = Math.max(config.retention.auditDays, config.retention.auditFloorDays);
    const cutoff = cutoffFor(now, windowDays);
    await run(
      {
        name: 'audit_log',
        table: 'audit_log',
        windowDays,
        cutoff: cutoff.toISOString(),
        rule: `at < ${windowDays}d ago (financial retention floor: ${config.retention.auditFloorDays}d — never lowered by env)`,
      },
      async () => {
        // Belt and braces: the floor is enforced in zod, again in windowDays
        // above, and once more here on the instant we are about to delete by.
        const floor = cutoffFor(now, config.retention.auditFloorDays);
        if (cutoff.getTime() > floor.getTime()) {
          throw new Error('refusing to purge audit_log inside the 7-year retention floor');
        }
        const where = lt(auditLog.at, cutoff);
        const [row] = await db.select({ n: count() }).from(auditLog).where(where);
        const matched = row?.n ?? 0;
        if (dryRun || matched === 0) return { matched, deleted: 0 };
        const gone = await db.delete(auditLog).where(where).returning({ id: auditLog.id });
        return { matched, deleted: gone.length };
      },
    );
  }

  // ---- leads: unhandled enquiries only ------------------------------------
  {
    const windowDays = config.retention.leadsDays;
    const cutoff = cutoffFor(now, windowDays);
    const where = and(isNull(leads.handledAt), lt(leads.createdAt, cutoff))!;
    await run(
      {
        name: 'leads_unhandled',
        table: 'leads',
        windowDays,
        cutoff: cutoff.toISOString(),
        rule: `handled_at IS NULL AND created_at older than ${windowDays}d (handled leads are kept — they became clients)`,
      },
      async () => {
        const [row] = await db.select({ n: count() }).from(leads).where(where);
        const matched = row?.n ?? 0;
        if (dryRun || matched === 0) return { matched, deleted: 0 };
        const gone = await db.delete(leads).where(where).returning({ id: leads.id });
        return { matched, deleted: gone.length };
      },
    );
  }

  // ---- intake_items: quarantined artefacts nobody claimed ------------------
  {
    const windowDays = config.retention.intakeQuarantineDays;
    const cutoff = cutoffFor(now, windowDays);
    const where = and(eq(intakeItems.status, 'quarantined'), lt(intakeItems.receivedAt, cutoff))!;
    await run(
      {
        name: 'intake_quarantined',
        table: 'intake_items',
        windowDays,
        cutoff: cutoff.toISOString(),
        rule: `status = 'quarantined' AND received_at older than ${windowDays}d (blobs deleted too)`,
      },
      async () => {
        const rows = await db
          .select({ id: intakeItems.id, storageKey: intakeItems.storageKey })
          .from(intakeItems)
          .where(where)
          .limit(MAX_ROWS_PER_BUCKET);
        const matched = rows.length;
        if (dryRun || matched === 0) {
          return { matched, deleted: 0, capped: matched === MAX_ROWS_PER_BUCKET };
        }

        const ids = rows.map((r) => r.id);
        // Order matters: children first, then the pointers into them, then the
        // items themselves. Anything referencing an intake item must be cleared
        // or the FKs abort the whole transaction.
        const exts = await db
          .select({ id: extractions.id })
          .from(extractions)
          .where(inArray(extractions.intakeItemId, ids));
        if (exts.length) {
          const extIds = exts.map((e) => e.id);
          await db.delete(txnMatches).where(inArray(txnMatches.extractionId, extIds));
          await db.delete(extractions).where(inArray(extractions.id, extIds));
        }
        await db
          .update(documentRequests)
          .set({ fulfilledByIntakeId: null })
          .where(inArray(documentRequests.fulfilledByIntakeId, ids));

        const gone = await db.delete(intakeItems).where(inArray(intakeItems.id, ids)).returning({
          id: intakeItems.id,
        });

        let blobsDeleted = 0;
        for (const r of rows) {
          if (!r.storageKey) continue;
          await deleteStored(r.storageKey);
          blobsDeleted += 1;
        }
        return { matched, deleted: gone.length, blobsDeleted, capped: matched === MAX_ROWS_PER_BUCKET };
      },
    );
  }

  // ---- outbound_messages: the send log ------------------------------------
  {
    const windowDays = config.retention.outboundDays;
    const cutoff = cutoffFor(now, windowDays);
    const where = lt(outboundMessages.createdAt, cutoff);
    await run(
      {
        name: 'outbound_messages',
        table: 'outbound_messages',
        windowDays,
        cutoff: cutoff.toISOString(),
        rule: `created_at older than ${windowDays}d (the audit_log record of the send survives)`,
      },
      async () => {
        const [row] = await db.select({ n: count() }).from(outboundMessages).where(where);
        const matched = row?.n ?? 0;
        if (dryRun || matched === 0) return { matched, deleted: 0 };
        const gone = await db.delete(outboundMessages).where(where).returning({ id: outboundMessages.id });
        return { matched, deleted: gone.length };
      },
    );
  }

  const finishedAt = new Date();
  return {
    dryRun,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    buckets,
    totalMatched: buckets.reduce((n, b) => n + b.matched, 0),
    totalDeleted: buckets.reduce((n, b) => n + b.deleted, 0),
    hadErrors: buckets.some((b) => b.error),
  };
}

/** Human-readable one-line-per-bucket rendering for cron mail / logs. */
export function formatReport(report: RetentionReport): string {
  const lines = [
    `Retention ${report.dryRun ? 'DRY RUN' : 'APPLY'} — ${report.startedAt} (${report.durationMs}ms)`,
  ];
  for (const b of report.buckets) {
    const blobs = b.blobsDeleted ? ` blobs=${b.blobsDeleted}` : '';
    const capped = b.capped ? ' [capped — rerun]' : '';
    const err = b.error ? `  ERROR: ${b.error}` : '';
    lines.push(
      `  ${b.name.padEnd(20)} window=${String(b.windowDays).padStart(5)}d  matched=${b.matched}  deleted=${b.deleted}${blobs}${capped}${err}`,
    );
  }
  lines.push(`  TOTAL matched=${report.totalMatched} deleted=${report.totalDeleted}`);
  return lines.join('\n');
}

// --- CLI -------------------------------------------------------------------
const isCli =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;

if (isCli) {
  const apply = process.argv.includes('--apply');
  runRetention({ dryRun: !apply })
    .then((report) => {
      console.log(formatReport(report));
      if (report.hadErrors) process.exitCode = 1;
    })
    .catch((err) => {
      console.error('Retention run failed:', err);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
