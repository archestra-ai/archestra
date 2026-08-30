FROM node:24-alpine3.23

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

WORKDIR /app

# Dev-only image: the fixture runner needs the backend's production modules and
# compiled entrypoint, not the frontend or the platform supervisor image.
COPY . .
RUN --mount=type=cache,id=kb-eval-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @backend...
RUN pnpm --filter @backend exec tsdown

WORKDIR /app/backend
CMD ["sh", "-c", "sleep infinity"]
