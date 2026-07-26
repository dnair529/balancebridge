/**
 * Applies SQL migrations from ./drizzle (generated with `npm run db:generate`),
 * then applies row-level security from ./rls.sql.
 * Run: npm run db:migrate
 *
 * Both steps need owner-grade privileges, so this script connects with
 * ADMIN_DATABASE_URL when set and DATABASE_URL otherwise. That split matters
 * once DATABASE_URL points at the restricted `portal_app` role in production:
 * the app keeps its reduced privileges, migrations still get what they need.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { config } from '../config.js';
import { applyRls } from './apply-rls.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/db -> <root>/drizzle (also correct from dist/db after build)
const migrationsFolder = path.resolve(here, '..', '..', 'drizzle');

const pool = new pg.Pool({ connectionString: config.adminDatabaseUrl, max: 1 });
const db = drizzle(pool);

async function main() {
  // citext is used for users.email / invites.email; must exist before tables.
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS citext`);
  await migrate(db, { migrationsFolder });
  console.log('Migrations applied.');

  // RLS is idempotent and runs on every boot so a newly added table can never
  // sit unpoliced. A failure here is fatal on purpose: silently booting without
  // the policies would leave the "defense in depth" claim untrue.
  const rls = await applyRls(pool);
  for (const notice of rls.notices) console.log(`  ${notice}`);
  console.log(`RLS applied to ${rls.securedTables.length} table(s); app role ${rls.appRole}.`);
}

main()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
