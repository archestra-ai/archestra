import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './src/backend/database/migrations',
  schema: './src/backend/database/schema',
  dialect: 'sqlite',
  // https://orm.drizzle.team/docs/sql-schema-declaration#camel-and-snake-casing
  casing: 'snake_case',
});
