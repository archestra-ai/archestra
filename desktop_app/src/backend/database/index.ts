import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { app } from 'electron';
import path from 'node:path';

import log from '@backend/utils/logger';
import { DATABASE_PATH } from '@backend/utils/paths';

const db = drizzle({
  connection: DATABASE_PATH,
  casing: 'snake_case',
});

export async function runDatabaseMigrations() {
  try {
    log.info('Running database migrations...');
    log.info('Database path:', DATABASE_PATH);

    // Determine migrations folder based on environment
    let migrationsFolder: string;
    if (!app.isPackaged) {
      // Development: Use absolute path from project root
      migrationsFolder = path.join(process.cwd(), 'src/backend/database/migrations');
    } else {
      // Production: Migrations are bundled within the app resources
      // The migrations folder is copied to the .vite/build directory during build
      migrationsFolder = path.join(__dirname, 'migrations');
    }

    log.info('Migrations folder:', migrationsFolder);

    // Run migrations
    await migrate(db, { migrationsFolder });

    log.info('Database migrations completed successfully');
  } catch (error) {
    log.error('Failed to run migrations:', error);
    throw error;
  }
}

export default db;
