import { defineConfig } from 'drizzle-kit';

/*
  Local/CI test-database setup only. This extension has no migrations of its own in production: its
  tables are created the real way, by createTablesFromSchema at install time, which the suites
  exercise. This file exists so `npx drizzle-kit push` can stand up a throwaway database holding
  kempo's core tables and this extension's own.

  No dotenv here on purpose: DATABASE_URL must be a real environment variable, exported or prefixed.
*/
export default defineConfig({
  schema: [
    './server/db/schema.js',
    './node_modules/kempo/server/db/schema.js',
  ],
  out: './server/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
