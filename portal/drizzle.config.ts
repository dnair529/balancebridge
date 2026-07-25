import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    // Only needed for `drizzle-kit push` / introspection; `generate` works offline.
    url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/portal',
  },
  strict: true,
  verbose: true,
});
