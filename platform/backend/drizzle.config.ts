import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './src/database/migrations',
  schema: './src/database/schema.ts',
  dialect: 'postgresql',
  casing: 'snake_case',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
