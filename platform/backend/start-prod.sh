#!/bin/sh
set -e

if [ -n "$DATABASE_URL" ]; then
  echo "DATABASE_URL provided, assuming real Postgres"
  echo "Running migrations..."
  cd backend && pnpm exec drizzle-kit migrate --config=./drizzle.config.ts & PID=$!
  wait $PID

  echo "Starting production server..."
  cd backend && exec node dist/server.js
fi
