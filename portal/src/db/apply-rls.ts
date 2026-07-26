/**
 * Applies src/db/rls.sql idempotently and (re)creates the restricted
 * application role. Runs automatically after migrations — see src/db/migrate.ts.
 *
 * Standalone:  node dist/db/apply-rls.js
 * Dev:         npx tsx src/db/apply-rls.ts
 *
 * Uses ADMIN_DATABASE_URL when set, otherwise DATABASE_URL. The DDL here needs
 * table-owner privileges (ALTER TABLE … ENABLE ROW LEVEL SECURITY) and, the
 * first time, CREATEROLE — the same privileges migrations already require.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * tsc does not copy .sql next to the emitted JS, so look in dist/db first
 * (the Dockerfile copies it there) and fall back to the source tree for
 * `tsx src/...` runs and for anyone running the built code from a checkout.
 */
export function rlsSqlPath(): string {
  const candidates = [
    path.join(moduleDir, 'rls.sql'), // dist/db/rls.sql  or  src/db/rls.sql
    path.resolve(moduleDir, '..', '..', 'src', 'db', 'rls.sql'), // dist/db -> src/db
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`rls.sql not found. Looked in:\n  ${candidates.join('\n  ')}`);
}

export interface ApplyRlsResult {
  sqlPath: string;
  appRole: string;
  /** Server NOTICEs raised by the script — one line per table decision. */
  notices: string[];
  /** Tables that ended up with relrowsecurity = true. */
  securedTables: string[];
}

/**
 * Runs the RLS script on the given pool.
 *
 * Executed through pg's simple query protocol (a single multi-statement
 * string, no bind parameters) because the script is a batch of DDL. The role
 * password is NOT interpolated into that string — it goes through a separate
 * parameterised call to app.ensure_app_role(), so a password containing quotes
 * can never become SQL.
 */
export async function applyRls(pool: pg.Pool): Promise<ApplyRlsResult> {
  const sqlPath = rlsSqlPath();
  const script = fs.readFileSync(sqlPath, 'utf8');
  const appRole = config.APP_DB_ROLE;
  const notices: string[] = [];

  const client = await pool.connect();
  try {
    client.on('notice', (n) => {
      // `DROP POLICY IF EXISTS` narrates itself on every first run; that noise
      // would bury the decisions worth reading (skipped/created).
      if (n.message && !/does not exist, skipping/.test(n.message)) notices.push(n.message);
    });

    await client.query(script);
    await client.query('SELECT app.ensure_app_role($1, $2)', [
      appRole,
      config.APP_DB_PASSWORD || null,
    ]);

    const secured = await client.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
        ORDER BY c.relname`,
    );

    return {
      sqlPath,
      appRole,
      notices,
      securedTables: secured.rows.map((r) => r.relname),
    };
  } finally {
    client.release();
  }
}

// --- CLI -------------------------------------------------------------------
const isCli = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;

if (isCli) {
  const pool = new pg.Pool({ connectionString: config.adminDatabaseUrl, max: 1 });
  applyRls(pool)
    .then((result) => {
      for (const n of result.notices) console.log(`  ${n}`);
      console.log(`RLS applied from ${result.sqlPath}`);
      console.log(`  app role: ${result.appRole}`);
      console.log(`  tables with RLS enabled (${result.securedTables.length}): ${result.securedTables.join(', ')}`);
    })
    .catch((err) => {
      console.error('Applying RLS failed:', err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
