#!/bin/sh
set -e

echo "Running migrations..."
cd backend && pnpm exec drizzle-kit migrate --config=./drizzle.config.ts & PID=$!
wait $PID

echo "Starting server..."
cd backend && exec node dist/server.js
