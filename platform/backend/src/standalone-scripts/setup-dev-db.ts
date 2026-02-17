#!/usr/bin/env tsx
/**
 * Setup development database: creates user and database if they don't exist.
 * This script connects as a superuser (postgres) to create the dev user/db.
 *
 * Usage:
 *   tsx src/standalone-scripts/setup-dev-db.ts
 *   # Or with custom superuser:
 *   SUPERUSER=myuser SUPERUSER_PASSWORD=mypass tsx src/standalone-scripts/setup-dev-db.ts
 */

import pg from "pg";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env from platform root
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, "../../../.env") });

const DB_USER = "archestra";
const DB_PASSWORD = "archestra_dev_password";
const DB_NAME = "archestra_dev";
const DB_HOST = process.env.ARCHESTRA_DATABASE_HOST || "localhost";
const DB_PORT = parseInt(process.env.ARCHESTRA_DATABASE_PORT || "5432", 10);

// Superuser credentials (try common defaults)
const SUPERUSER = process.env.SUPERUSER || "postgres";
const SUPERUSER_PASSWORD =
  process.env.SUPERUSER_PASSWORD || process.env.POSTGRES_PASSWORD || process.env.PGPASSWORD || "";

async function tryConnect(client: pg.Client, description: string): Promise<boolean> {
  try {
    await client.connect();
    return true;
  } catch (err) {
    await client.end().catch(() => {});
    return false;
  }
}

async function setupDatabase() {
  console.log("=== Setting up Postgres database ===");
  console.log(`Host: ${DB_HOST}:${DB_PORT}`);
  console.log(`Target user: ${DB_USER}`);
  console.log(`Target database: ${DB_NAME}`);

  // Try different connection methods
  const connectionAttempts = [
    // Try with password if provided
    ...(SUPERUSER_PASSWORD ? [{
      host: DB_HOST,
      port: DB_PORT,
      user: SUPERUSER,
      password: SUPERUSER_PASSWORD,
      database: "postgres",
    }] : []),
    // Try without password (trust/local auth)
    {
      host: DB_HOST,
      port: DB_PORT,
      user: SUPERUSER,
      database: "postgres",
    },
    // Try with current Windows user
    {
      host: DB_HOST,
      port: DB_PORT,
      user: process.env.USERNAME || process.env.USER || "postgres",
      database: "postgres",
    },
  ];

  let superuserClient: pg.Client | null = null;
  let connected = false;

  for (const config of connectionAttempts) {
    const client = new pg.Client(config);
    console.log(`\nTrying to connect as: ${config.user}${config.password ? " (with password)" : ""}...`);
    if (await tryConnect(client, `${config.user}`)) {
      superuserClient = client;
      connected = true;
      console.log(`Connected successfully as ${config.user}!`);
      break;
    }
  }

  if (!connected || !superuserClient) {
    console.error("\nERROR: Could not connect to Postgres as any superuser.");
    console.error("\nTroubleshooting:");
    console.error("1. Ensure Postgres is running on localhost:5432");
    console.error("2. Set SUPERUSER_PASSWORD environment variable:");
    console.error("   $env:SUPERUSER_PASSWORD='yourpassword'; pnpm db:setup");
    console.error("3. Or create the user manually:");
    console.error(`   psql -U postgres -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';"`);
    console.error(`   psql -U postgres -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"`);
    process.exit(1);
  }

  try {
    console.log("Connected successfully!");

    // Create user if not exists (identifiers can't be parameterized in Postgres)
    console.log(`\nCreating user '${DB_USER}'...`);
    const roleExists = await superuserClient.query(
      "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1",
      [DB_USER],
    );
    const quotedUser = `"${DB_USER.replace(/"/g, '""')}"`;
    const escapedPassword = DB_PASSWORD.replace(/'/g, "''");
    if (roleExists.rows.length === 0) {
      await superuserClient.query(
        `CREATE USER ${quotedUser} WITH PASSWORD '${escapedPassword}'`,
      );
    } else {
      await superuserClient.query(
        `ALTER USER ${quotedUser} WITH PASSWORD '${escapedPassword}'`,
      );
    }
    console.log(`User '${DB_USER}' created/updated successfully`);

    // Create database if not exists
    console.log(`\nCreating database '${DB_NAME}'...`);
    const dbExistsResult = await superuserClient.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [DB_NAME],
    );
    if (dbExistsResult.rows.length === 0) {
      await superuserClient.query(
        `CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}`,
      );
      console.log(`Database '${DB_NAME}' created successfully`);
    } else {
      console.log(`Database '${DB_NAME}' already exists`);
    }

    // Grant privileges
    console.log(`\nGranting privileges...`);
    await superuserClient.query(
      `GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER}`,
    );
    console.log("Privileges granted");

    // Verify connection as the new user
    console.log("\n=== Verifying connection ===");
    const userUrl = `postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
    const userClient = new pg.Client({
      connectionString: userUrl,
    });

    try {
      await userClient.connect();
      const versionResult = await userClient.query("SELECT version()");
      console.log("Connection verified!");
      console.log(`PostgreSQL version: ${versionResult.rows[0].version.split("\n")[0]}`);
      await userClient.end();
    } catch (err) {
      console.error("WARNING: Could not verify connection as new user:", err);
      throw err;
    }

    console.log("\n=== Database setup completed successfully! ===");
    console.log(`Connection string: postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=public`);
    console.log("\nNext steps:");
    console.log("1. Run migrations: cd backend && pnpm db:migrate");
    console.log("2. Start the app: cd platform && pnpm dev");
    console.log("3. Run tests: cd platform && pnpm test:e2e");
  } catch (err: unknown) {
    console.error("\nERROR: Database setup failed:");
    if (err instanceof Error) {
      console.error(err.message);
      if (err.message.includes("password authentication failed") || err.message.includes("SASL")) {
        console.error("\nTroubleshooting:");
        console.error("1. Ensure Postgres is running");
        console.error("2. Set SUPERUSER_PASSWORD environment variable:");
        console.error("   $env:SUPERUSER_PASSWORD='yourpassword'; pnpm db:setup");
        console.error("3. Or create the user manually:");
        console.error(`   psql -U postgres -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';"`);
        console.error(`   psql -U postgres -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"`);
      }
    } else {
      console.error(err);
    }
    process.exit(1);
  } finally {
    if (superuserClient) {
      await superuserClient.end();
    }
  }
}

setupDatabase().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
