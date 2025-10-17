FROM node:24-alpine AS base

# Enable pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# Dependencies stage
FROM base AS deps
WORKDIR /app

# Copy package files for all workspaces
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY shared/package.json shared/

# Install all dependencies
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# <----- Builder stage ----->
FROM base AS builder
WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY --from=deps /app/frontend/node_modules ./frontend/node_modules
COPY --from=deps /app/shared/node_modules ./shared/node_modules

# Copy source files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY backend ./backend
COPY frontend ./frontend
COPY shared ./shared

# Build all workspace
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# <----- Final unified stage ----->
FROM base AS unified
WORKDIR /app

ENV NODE_ENV=production
ENV ARCHESTRA_AUTH_SECRET=""
ENV ARCHESTRA_API_BASE_URL="http://localhost:9000"
ENV ARCHESTRA_AUTH_ADMIN_EMAIL="admin@localhost.ai"
ENV ARCHESTRA_AUTH_ADMIN_PASSWORD="password"
ENV NEXT_TELEMETRY_DISABLED=1

# Install PostgreSQL 17 and supervisord
RUN apk add --no-cache \
    postgresql17 \
    postgresql17-contrib \
    supervisor \
    su-exec \
    && mkdir -p /var/log/supervisor

# Create postgres directories (user already exists from postgresql package)
RUN mkdir -p /var/lib/postgresql/data /run/postgresql && \
    chown -R postgres:postgres /var/lib/postgresql /run/postgresql

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/

# Install production dependencies for both workspaces
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod=false --filter=@backend --filter=@frontend

# Copy built backend
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/drizzle.config.ts ./backend/
COPY --from=builder /app/backend/src/database/migrations ./backend/src/database/migrations

# Copy built frontend
COPY --from=builder /app/frontend/public ./frontend/public
COPY --from=builder /app/frontend/.next/standalone ./
COPY --from=builder /app/frontend/.next/static ./frontend/.next/static

# Create supervisord configuration
RUN cat > /etc/supervisord.conf <<'EOF'
[supervisord]
nodaemon=true
user=root
logfile=/var/log/supervisor/supervisord.log
pidfile=/var/run/supervisord.pid

[program:postgres]
user=postgres
command=postgres -D /var/lib/postgresql/data
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
priority=1

[program:backend]
directory=/app/backend
command=/bin/sh -c "sleep 5 && pnpm db:migrate && node dist/server.js"
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
priority=10
environment=NODE_ENV="%(ENV_NODE_ENV)s",DATABASE_URL="placeholder",ARCHESTRA_API_BASE_URL="placeholder",ARCHESTRA_AUTH_ADMIN_EMAIL="%(ENV_ARCHESTRA_AUTH_ADMIN_EMAIL)s",ARCHESTRA_AUTH_ADMIN_PASSWORD="%(ENV_ARCHESTRA_AUTH_ADMIN_PASSWORD)s",ARCHESTRA_AUTH_SECRET="%(ENV_ARCHESTRA_AUTH_SECRET)s"

[program:frontend]
directory=/app/frontend
command=/bin/sh -c "sleep 8 && node server.js"
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
priority=20
environment=NODE_ENV="%(ENV_NODE_ENV)s",HOSTNAME="0.0.0.0",NEXT_PUBLIC_ARCHESTRA_API_BASE_URL="placeholder"
EOF

# Create initialization script
RUN cat > /docker-entrypoint.sh <<'EOF'
#!/bin/sh
set -e

# Parse DATABASE_URL or use defaults
if [ -n "$DATABASE_URL" ]; then
    # Extract credentials from DATABASE_URL (postgresql://user:pass@host:port/db)
    POSTGRES_USER=$(echo "$DATABASE_URL" | sed -n 's|.*://\([^:]*\):.*|\1|p')
    POSTGRES_PASSWORD=$(echo "$DATABASE_URL" | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')
    POSTGRES_DB=$(echo "$DATABASE_URL" | sed -n 's|.*/\([^?]*\).*|\1|p')
else
    # Use defaults
    POSTGRES_USER=${POSTGRES_USER:-archestra}
    POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-archestra_dev_password}
    POSTGRES_DB=${POSTGRES_DB:-archestra_dev}
    DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:5432/${POSTGRES_DB}?schema=public"
fi

# Initialize PostgreSQL if data directory is empty
if [ ! -s /var/lib/postgresql/data/PG_VERSION ]; then
    echo "Initializing PostgreSQL database..."
    su-exec postgres initdb -D /var/lib/postgresql/data

    # Configure PostgreSQL
    echo "host all all all md5" >> /var/lib/postgresql/data/pg_hba.conf
    echo "listen_addresses='*'" >> /var/lib/postgresql/data/postgresql.conf

    # Start PostgreSQL temporarily to create user and database
    su-exec postgres pg_ctl -D /var/lib/postgresql/data -o "-c listen_addresses=''" -w start

    # Create user and database
    psql -v ON_ERROR_STOP=1 --username postgres <<-EOSQL
        CREATE USER ${POSTGRES_USER} WITH PASSWORD '${POSTGRES_PASSWORD}';
        CREATE DATABASE ${POSTGRES_DB} OWNER ${POSTGRES_USER};
        GRANT ALL PRIVILEGES ON DATABASE ${POSTGRES_DB} TO ${POSTGRES_USER};
EOSQL

    # Stop PostgreSQL
    su-exec postgres pg_ctl -D /var/lib/postgresql/data -m fast -w stop

    echo "PostgreSQL initialized successfully"
fi

# Update supervisord config with actual environment variables
sed -i "s|DATABASE_URL=\"[^\"]*\"|DATABASE_URL=\"${DATABASE_URL}\"|" /etc/supervisord.conf

# NOTE: we need to update both ARCHESTRA_API_BASE_URL and NEXT_PUBLIC_ARCHESTRA_API_BASE_URL
# because the frontend uses NEXT_PUBLIC_ARCHESTRA_API_BASE_URL to set the base URL for the codegen'd API client
# AT RUNTIME (see https://github.com/expatfile/next-runtime-env)
sed -i "s|ARCHESTRA_API_BASE_URL=\"[^\"]*\"|ARCHESTRA_API_BASE_URL=\"${ARCHESTRA_API_BASE_URL}\"|" /etc/supervisord.conf
sed -i "s|NEXT_PUBLIC_ARCHESTRA_API_BASE_URL=\"[^\"]*\"|NEXT_PUBLIC_ARCHESTRA_API_BASE_URL=\"${ARCHESTRA_API_BASE_URL}\"|" /etc/supervisord.conf

# Propagate analytics setting to frontend (enabled by default, set to "disabled" to opt-out)
if [ -n "$ARCHESTRA_ANALYTICS" ]; then
    sed -i "s|environment=\(.*\)|environment=\1,NEXT_PUBLIC_ARCHESTRA_ANALYTICS=\"${ARCHESTRA_ANALYTICS}\"|g" /etc/supervisord.conf
fi

# Start supervisord
exec /usr/bin/supervisord -c /etc/supervisord.conf
EOF

RUN chmod +x /docker-entrypoint.sh

# Expose ports
EXPOSE 5432 9000 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
