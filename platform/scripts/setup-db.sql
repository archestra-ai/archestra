-- Setup development database for Archestra
-- Run as Postgres superuser: psql -U postgres -f scripts/setup-db.sql

-- Create user if not exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'archestra') THEN
        CREATE USER archestra WITH PASSWORD 'archestra_dev_password';
    ELSE
        ALTER USER archestra WITH PASSWORD 'archestra_dev_password';
    END IF;
END
$$;

-- Create database if not exists
SELECT 'CREATE DATABASE archestra_dev OWNER archestra'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'archestra_dev')\gexec

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE archestra_dev TO archestra;

-- Verify
\c archestra_dev
SELECT 'Database setup complete!' AS status;
