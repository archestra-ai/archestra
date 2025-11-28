FROM node:24.11.1-alpine3.22 AS base

# Enable pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# Development stage
FROM base AS dev
WORKDIR /app

# Copy package files for all workspaces
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY shared/package.json shared/

# Install all dependencies (including dev dependencies)
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Copy @shared package INTO the image (not mounted) for fast access
# This is the critical optimization - @shared will be on fast Docker filesystem
COPY shared ./shared

# Don't copy backend/frontend source files - they'll be mounted via volumes
# But @shared is copied to avoid slow symlink resolution through volume mounts

# Disable Next.js telemetry
ENV NEXT_TELEMETRY_DISABLED=1

# The actual command will be specified in docker-compose.yml
# Default to running dev mode for all workspaces
CMD ["pnpm", "dev"]
