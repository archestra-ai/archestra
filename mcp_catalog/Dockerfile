# Use official Node.js LTS image
FROM node:24.4.1-alpine AS builder

# Set working directory
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate

# Copy tsconfig.base.json from parent directory
COPY tsconfig.base.json ../tsconfig.base.json

# Copy package files
COPY mcp_catalog/package.json mcp_catalog/pnpm-lock.yaml ./

# Install all dependencies (including dev dependencies for build)
RUN pnpm install --frozen-lockfile

# Copy the rest of the application code
COPY mcp_catalog/ .

# Build TypeScript
RUN pnpm build

# Production stage
FROM node:24.4.1-alpine

# Set working directory
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate

# Copy package files
COPY mcp_catalog/package.json mcp_catalog/pnpm-lock.yaml ./

# Install only production dependencies
RUN pnpm install --frozen-lockfile --prod

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist

# Expose the port (default 3000)
ENV PORT=3000
EXPOSE $PORT

# Start the server
CMD ["node", "dist/server.js"]
