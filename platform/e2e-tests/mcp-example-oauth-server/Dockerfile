FROM node:24-alpine AS builder

WORKDIR /app

# Clone the official MCP example remote server
RUN apk add --no-cache git && \
    git clone --depth 1 https://github.com/modelcontextprotocol/example-remote-server.git . && \
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
