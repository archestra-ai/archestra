# Build context is ai-labs (the reduced build reuses the workspace lockfile).
#   docker build -f baton/baton-proxy/Dockerfile -t baton-proxy:poc .
# Pin to bookworm so the runtime glibc (debian:bookworm-slim) matches the
# build glibc — rust:1-slim tracks trixie and links a newer glibc.
FROM rust:1-slim-bookworm AS build
WORKDIR /src
RUN apt-get update \
    && apt-get install -y --no-install-recommends cmake make \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN cargo build --release --locked -p baton-proxy --bin baton-proxy

FROM debian:bookworm-slim
# reqwest/rustls loads trust roots from the system store; the slim image has
# none, so HTTPS to the upstream provider fails without this.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/baton-proxy /usr/local/bin/baton-proxy
ENTRYPOINT ["baton-proxy"]
