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

# Build all workspaces
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# <----- Backend runner stage ----->
FROM base AS backend
WORKDIR /app

ENV NODE_ENV=production

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/

# Install dependencies
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod=false --filter=@backend

# Copy built backend and migrations
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/drizzle.config.ts ./backend/
COPY --from=builder /app/backend/src/database/migrations ./backend/src/database/migrations
COPY --from=builder /app/backend/start.sh ./backend/start.sh

RUN chmod +x ./backend/start.sh

EXPOSE 9000

CMD ["sh", "backend/start.sh"]

# <----- Frontend runner stage ----->
FROM base AS frontend
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy built frontend files
COPY --from=builder /app/frontend/public ./frontend/public

# Set correct permissions for Next.js cache
RUN mkdir -p ./frontend/.next
RUN chown nextjs:nodejs ./frontend/.next

# Copy standalone build
COPY --from=builder --chown=nextjs:nodejs /app/frontend/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/frontend/.next/static ./frontend/.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "frontend/server.js"]
