/**
 * Applies SQL migrations from ./drizzle (generated with `npm run db:generate`).
 * Run: npm run db:migrate
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, closeDb } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/db -> <root>/drizzle (also correct from dist/db after build)
const migrationsFolder = path.resolve(here, '..', '..', 'drizzle');

async function main() {
  // citext is used for users.email / invites.email; must exist before tables.
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS citext`);
  await migrate(db, { migrationsFolder });
  console.log('Migrations applied.');
}

main()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
