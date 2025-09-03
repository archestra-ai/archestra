/**
 * NOTE: this config file is ONLY really here for usage with pnpm db studio
 *
 * Configuration for the database used by the application is defined in `desktop_app/src/backend/database/index.ts`
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './src/backend/database/migrations',
  schema: './src/backend/database/schema',
  dialect: 'sqlite',
  // https://orm.drizzle.team/docs/sql-schema-declaration#camel-and-snake-casing
  casing: 'snake_case',
  dbCredentials: {
    url: `${process.env.HOME}/Library/Application Support/archestra/archestra.db`,
  },
});
