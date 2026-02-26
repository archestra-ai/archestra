FROM node:24-alpine AS builder

WORKDIR /app

# Clone the official MCP example remote server (pinned to a specific commit for reproducible builds)
RUN apk add --no-cache git && \
    git clone https://github.com/modelcontextprotocol/example-remote-server.git . && \
    git checkout da36d623edca13e4d14079041e680330d86bc27b && \
    rm -rf .git

# Install dependencies and build
RUN npm ci && npm run build

# --- Runtime stage ---
FROM node:24-alpine

WORKDIR /app

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

ENV AUTH_MODE=internal
ENV PORT=3232

EXPOSE 3232

CMD ["node", "dist/index.js"]
