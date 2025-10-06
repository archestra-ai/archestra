import { defineConfig } from 'drizzle-kit';
import path from "node:path";
import dotenv from "dotenv";
import { isProdAndDbUrlSet } from './src/utils';

dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });

export default defineConfig({
  out: './src/database/migrations',
  schema: './src/database/schemas',
  dialect: 'postgresql',
  casing: 'snake_case',
  ...isProdAndDbUrlSet() ? {
    dbCredentials: {
      url: process.env.DATABASE_URL!,
    },
  } : {
    driver: 'pglite',
    dbCredentials: {
      url: './.pgdata-dev'
    },
  },
});
